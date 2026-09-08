// Based on OpenCLI (https://github.com/jackwener/opencli) by jackwener
// Licensed under Apache-2.0. Modified for AutoCLI.
/**
 * AutoCLI — Service Worker (background script).
 *
 * Connects to the autocli daemon via WebSocket, receives commands,
 * dispatches them to Chrome APIs (debugger/tabs/cookies), returns results.
 */

import type { Command, Result } from './protocol';
import { DAEMON_WS_URL, DAEMON_PING_URL, WS_RECONNECT_BASE_DELAY, WS_RECONNECT_MAX_DELAY } from './protocol';
import * as executor from './cdp';

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;

// ─── Console log forwarding ──────────────────────────────────────────
// Hook console.log/warn/error to forward logs to daemon via WebSocket.

const _origLog = console.log.bind(console);
const _origWarn = console.warn.bind(console);
const _origError = console.error.bind(console);

function forwardLog(level: 'info' | 'warn' | 'error', args: unknown[]): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    ws.send(JSON.stringify({ type: 'log', level, msg, ts: Date.now() }));
  } catch { /* don't recurse */ }
}

console.log = (...args: unknown[]) => { _origLog(...args); forwardLog('info', args); };
console.warn = (...args: unknown[]) => { _origWarn(...args); forwardLog('warn', args); };
console.error = (...args: unknown[]) => { _origError(...args); forwardLog('error', args); };

// ─── WebSocket connection ────────────────────────────────────────────

/**
 * Probe the daemon via its /ping HTTP endpoint before attempting a WebSocket
 * connection.  fetch() failures are silently catchable; new WebSocket() is not
 * — Chrome logs ERR_CONNECTION_REFUSED to the extension error page before any
 * JS handler can intercept it.  By keeping the probe inside connect() every
 * call site remains unchanged and the guard can never be accidentally skipped.
 */
async function connect(): Promise<void> {
  if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return;

  try {
    const res = await fetch(DAEMON_PING_URL, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return; // unexpected response — not our daemon
  } catch {
    return; // daemon not running — skip WebSocket to avoid console noise
  }

  try {
    ws = new WebSocket(DAEMON_WS_URL);
  } catch {
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log('[autocli] Connected to daemon');
    reconnectAttempts = 0; // Reset on successful connection
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    // Send version so the daemon can report mismatches to the CLI
    ws?.send(JSON.stringify({ type: 'hello', version: chrome.runtime.getManifest().version }));
  };

  ws.onmessage = async (event) => {
    try {
      const raw = event.data as string;
      const parsed = JSON.parse(raw);

      // Handle AI stream chunks from daemon
      if (parsed.type === 'ai-stream-chunk' || parsed.type === 'ai-stream-done' || parsed.type === 'ai-stream-error') {
        const port = aiStreamPorts.get(parsed.streamId);
        if (port) {
          if (parsed.type === 'ai-stream-chunk') {
            port.postMessage({ type: 'chunk', data: parsed.data });
          } else if (parsed.type === 'ai-stream-done') {
            port.postMessage({ type: 'done' });
            aiStreamPorts.delete(parsed.streamId);
            try { port.disconnect(); } catch {}
          } else if (parsed.type === 'ai-stream-error') {
            port.postMessage({ type: 'error', status: parsed.status || 0, body: parsed.body || parsed.error || '' });
            aiStreamPorts.delete(parsed.streamId);
            try { port.disconnect(); } catch {}
          }
        }
        return;
      }

      // Normal command from daemon
      const command = parsed as Command;
      const result = await handleCommand(command);
      ws?.send(JSON.stringify(result));
    } catch (err) {
      console.error('[autocli] Message handling error:', err);
    }
  };

  ws.onclose = () => {
    console.log('[autocli] Disconnected from daemon');
    ws = null;
    scheduleReconnect();
  };

  ws.onerror = () => {
    ws?.close();
  };
}

/**
 * After MAX_EAGER_ATTEMPTS (reaching 60s backoff), stop scheduling reconnects.
 * The keepalive alarm (~24s) will still call connect() periodically, but at a
 * much lower frequency — reducing console noise when the daemon is not running.
 */
const MAX_EAGER_ATTEMPTS = 6; // 2s, 4s, 8s, 16s, 32s, 60s — then stop

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectAttempts++;
  if (reconnectAttempts > MAX_EAGER_ATTEMPTS) return; // let keepalive alarm handle it
  const delay = Math.min(WS_RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttempts - 1), WS_RECONNECT_MAX_DELAY);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, delay);
}

// ─── OpenCLI-compatible target lease lifecycle ───────────────────────
// AutoCLI is the Rust rewrite of OpenCLI. Keep the browser lifecycle semantics
// aligned with OpenCLI rather than deriving persistence from session-name
// prefixes or treating a window as the session identity.

type BrowserSurface = 'browser' | 'adapter';
type LeaseLifecycle = 'ephemeral' | 'persistent';
type OwnedWindowRole = 'interactive' | 'automation';

type TargetLease = {
  session: string;
  surface: BrowserSurface;
  windowId: number;
  preferredTabId: number | null;
  lifecycle: LeaseLifecycle;
  idleTimer: ReturnType<typeof setTimeout> | null;
  idleDeadlineAt: number;
};

type StoredLease = Omit<TargetLease, 'idleTimer'> & { updatedAt: number };

type StoredRegistry = {
  version: 3;
  ownedContainers: {
    interactive: { windowId: number | null };
    automation: { windowId: number | null };
  };
  leases: Record<string, StoredLease>;
};

const automationSessions = new Map<string, TargetLease>();
const sessionLifecycleOverrides = new Map<string, LeaseLifecycle>();
const activeCommandCounts = new Map<string, number>();
const IDLE_TIMEOUT_DEFAULT = 30_000;
const IDLE_TIMEOUT_INTERACTIVE = 600_000;
const IDLE_TIMEOUT_NONE = -1;
const REGISTRY_KEY = 'autocli_target_lease_registry_v3';
const LEASE_IDLE_ALARM_PREFIX = 'autocli:lease-idle:';
const LEASE_KEY_SEPARATOR = '\u0000';
let leaseMutationQueue: Promise<void> = Promise.resolve();
const ownedContainers: Record<OwnedWindowRole, {
  windowId: number | null;
  promise: Promise<{ windowId: number; initialTabId?: number }> | null;
}> = {
  interactive: { windowId: null, promise: null },
  automation: { windowId: null, promise: null },
};

// A worker can be woken by an alarm/window/tab event before startup recovery
// rehydrates the in-memory registry. Persisting before recovery would overwrite
// the stored leases with an empty snapshot, so event/command paths gate here.
let workerReady: Promise<void> = Promise.resolve();

function getSessionName(cmd: Pick<Command, 'session'>): string {
  const raw = cmd.session?.trim();
  if (!raw) throw new Error('Browser session is required');
  return raw;
}

function getCommandSurface(cmd: Pick<Command, 'surface' | 'session'>): BrowserSurface {
  return cmd.surface === 'adapter' ? 'adapter' : 'browser';
}

function getLeaseKey(session: string, surface: BrowserSurface): string {
  return `${surface}${LEASE_KEY_SEPARATOR}${encodeURIComponent(session)}`;
}

function getSurfaceFromKey(leaseKey: string): BrowserSurface {
  return leaseKey.split(LEASE_KEY_SEPARATOR, 1)[0] === 'adapter' ? 'adapter' : 'browser';
}

function getSessionFromKey(leaseKey: string): string {
  const idx = leaseKey.indexOf(LEASE_KEY_SEPARATOR);
  if (idx === -1) return leaseKey;
  try {
    return decodeURIComponent(leaseKey.slice(idx + 1));
  } catch {
    return leaseKey.slice(idx + 1);
  }
}

function getOwnedWindowRole(leaseKey: string): OwnedWindowRole {
  return getSurfaceFromKey(leaseKey) === 'browser' ? 'interactive' : 'automation';
}

function getLeaseLifecycle(leaseKey: string): LeaseLifecycle {
  return sessionLifecycleOverrides.get(leaseKey)
    ?? automationSessions.get(leaseKey)?.lifecycle
    ?? (getSurfaceFromKey(leaseKey) === 'browser' ? 'persistent' : 'ephemeral');
}

function getIdleTimeout(leaseKey: string): number {
  const surface = getSurfaceFromKey(leaseKey);
  const lifecycle = getLeaseLifecycle(leaseKey);
  if (surface === 'adapter' && lifecycle === 'persistent') return IDLE_TIMEOUT_NONE;
  return surface === 'browser' ? IDLE_TIMEOUT_INTERACTIVE : IDLE_TIMEOUT_DEFAULT;
}

function makeAlarmName(leaseKey: string): string {
  return `${LEASE_IDLE_ALARM_PREFIX}${encodeURIComponent(leaseKey)}`;
}

function leaseKeyFromAlarmName(name: string): string | null {
  if (!name.startsWith(LEASE_IDLE_ALARM_PREFIX)) return null;
  try {
    return decodeURIComponent(name.slice(LEASE_IDLE_ALARM_PREFIX.length));
  } catch {
    return null;
  }
}

function withLeaseMutation<T>(fn: () => Promise<T>): Promise<T> {
  const run = leaseMutationQueue.then(fn, fn);
  leaseMutationQueue = run.then(() => undefined, () => undefined);
  return run;
}

function emptyRegistry(): StoredRegistry {
  return {
    version: 3,
    ownedContainers: {
      interactive: { windowId: ownedContainers.interactive.windowId },
      automation: { windowId: ownedContainers.automation.windowId },
    },
    leases: {},
  };
}

async function readRegistry(): Promise<StoredRegistry> {
  try {
    const storage = chrome.storage?.session;
    if (!storage) return emptyRegistry();
    const raw = await storage.get(REGISTRY_KEY) as Record<string, unknown>;
    const stored = raw[REGISTRY_KEY] as Partial<StoredRegistry> | undefined;
    if (!stored || stored.version !== 3 || typeof stored.leases !== 'object') return emptyRegistry();
    const containers = stored.ownedContainers && typeof stored.ownedContainers === 'object'
      ? stored.ownedContainers
      : emptyRegistry().ownedContainers;
    return {
      version: 3,
      ownedContainers: {
        interactive: {
          windowId: typeof containers.interactive?.windowId === 'number'
            ? containers.interactive.windowId
            : null,
        },
        automation: {
          windowId: typeof containers.automation?.windowId === 'number'
            ? containers.automation.windowId
            : null,
        },
      },
      leases: stored.leases as Record<string, StoredLease>,
    };
  } catch {
    return emptyRegistry();
  }
}

async function writeRegistry(registry: StoredRegistry): Promise<void> {
  try {
    await chrome.storage?.session?.set({ [REGISTRY_KEY]: registry });
  } catch {
    // Registry persistence is a recovery aid; command execution remains primary.
  }
}

async function persistRuntimeState(): Promise<void> {
  const leases: Record<string, StoredLease> = {};
  for (const [leaseKey, lease] of automationSessions.entries()) {
    leases[leaseKey] = {
      session: lease.session,
      surface: lease.surface,
      windowId: lease.windowId,
      preferredTabId: lease.preferredTabId,
      lifecycle: lease.lifecycle,
      idleDeadlineAt: lease.idleDeadlineAt,
      updatedAt: Date.now(),
    };
  }
  await writeRegistry({
    version: 3,
    ownedContainers: {
      interactive: { windowId: ownedContainers.interactive.windowId },
      automation: { windowId: ownedContainers.automation.windowId },
    },
    leases,
  });
}

function scheduleIdleAlarm(leaseKey: string, timeout: number): void {
  const alarmName = makeAlarmName(leaseKey);
  try {
    if (timeout > 0) {
      chrome.alarms?.create?.(alarmName, { when: Date.now() + timeout });
    } else {
      chrome.alarms?.clear?.(alarmName);
    }
  } catch {
    // setTimeout remains the in-process fast path; alarms survive MV3 eviction.
  }
}

async function safeDetach(tabId: number): Promise<void> {
  try {
    await executor.detach(tabId);
  } catch {
    // Detach is best-effort during cleanup, matching OpenCLI releaseLease().
  }
}

function setLeaseSession(
  leaseKey: string,
  value: { windowId: number; preferredTabId: number | null; lifecycle?: LeaseLifecycle },
): void {
  const existing = automationSessions.get(leaseKey);
  if (existing?.idleTimer) clearTimeout(existing.idleTimer);
  const lifecycle = value.lifecycle ?? getLeaseLifecycle(leaseKey);
  const timeout = getIdleTimeout(leaseKey);
  automationSessions.set(leaseKey, {
    session: getSessionFromKey(leaseKey),
    surface: getSurfaceFromKey(leaseKey),
    windowId: value.windowId,
    preferredTabId: value.preferredTabId,
    lifecycle,
    idleTimer: null,
    idleDeadlineAt: timeout <= 0 ? 0 : Date.now() + timeout,
  });
  void persistRuntimeState();
}

async function removeLeaseSession(leaseKey: string): Promise<void> {
  const existing = automationSessions.get(leaseKey);
  if (existing?.idleTimer) clearTimeout(existing.idleTimer);
  automationSessions.delete(leaseKey);
  sessionLifecycleOverrides.delete(leaseKey);
  scheduleIdleAlarm(leaseKey, IDLE_TIMEOUT_NONE);
  await persistRuntimeState();
}

function resetWindowIdleTimer(leaseKey: string, remainingMs?: number): void {
  const lease = automationSessions.get(leaseKey);
  if (!lease) return;
  if (lease.idleTimer) clearTimeout(lease.idleTimer);
  const timeout = getIdleTimeout(leaseKey);
  if (timeout <= 0) {
    scheduleIdleAlarm(leaseKey, timeout);
    lease.idleTimer = null;
    lease.idleDeadlineAt = 0;
    void persistRuntimeState();
    return;
  }
  const interval = remainingMs === undefined
    ? timeout
    : Math.max(0, Math.min(remainingMs, timeout));
  scheduleIdleAlarm(leaseKey, interval);
  lease.idleDeadlineAt = Date.now() + interval;
  void persistRuntimeState();
  lease.idleTimer = setTimeout(async () => {
    if ((activeCommandCounts.get(leaseKey) ?? 0) > 0) return;
    await releaseLease(leaseKey, 'idle timeout');
  }, interval);
}

function initialTabIsAvailable(tabId: number | undefined): tabId is number {
  if (tabId === undefined) return false;
  for (const lease of automationSessions.values()) {
    if (lease.preferredTabId === tabId) return false;
  }
  return true;
}

async function findReusableOwnedContainerTab(windowId: number): Promise<number | undefined> {
  try {
    const tabs = await chrome.tabs.query({ windowId });
    const reusable = tabs.find((tab) =>
      tab.id !== undefined
      && initialTabIsAvailable(tab.id)
      && isDebuggableUrl(tab.url)
      && !isSafeNavigationUrl(tab.url ?? ''),
    );
    return reusable?.id;
  } catch {
    return undefined;
  }
}

async function ensureOwnedContainerWindow(
  role: OwnedWindowRole,
  initialUrl?: string,
): Promise<{ windowId: number; initialTabId?: number }> {
  const container = ownedContainers[role];
  if (container.promise) return container.promise;
  container.promise = ensureOwnedContainerWindowUnlocked(role, initialUrl)
    .finally(() => { container.promise = null; });
  return container.promise;
}

async function ensureOwnedContainerWindowUnlocked(
  role: OwnedWindowRole,
  initialUrl?: string,
): Promise<{ windowId: number; initialTabId?: number }> {
  const container = ownedContainers[role];
  if (container.windowId !== null) {
    try {
      await chrome.windows.get(container.windowId);
      return {
        windowId: container.windowId,
        initialTabId: await findReusableOwnedContainerTab(container.windowId),
      };
    } catch {
      container.windowId = null;
    }
  }

  const startUrl = (initialUrl && isSafeNavigationUrl(initialUrl)) ? initialUrl : BLANK_PAGE;
  const win = await chrome.windows.create({
    url: startUrl,
    focused: role === 'interactive',
    width: 1280,
    height: 900,
    type: 'normal',
  });
  if (win.id === undefined) throw new Error(`Failed to create ${role} container window`);
  container.windowId = win.id;
  // Persist before further awaits, matching OpenCLI's worker-crash recovery ordering.
  await persistRuntimeState();
  console.log(`[autocli] Created owned ${role} window ${win.id} (start=${startUrl})`);

  const tabs = await chrome.tabs.query({ windowId: win.id });
  const initialTabId = tabs[0]?.id;
  if (initialTabId) {
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 500);
      const listener = (tabId: number, info: chrome.tabs.TabChangeInfo) => {
        if (tabId === initialTabId && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timeout);
          resolve();
        }
      };
      if (tabs[0].status === 'complete') {
        clearTimeout(timeout);
        resolve();
      } else {
        chrome.tabs.onUpdated.addListener(listener);
      }
    });
  }
  return { windowId: win.id, initialTabId };
}

async function createOwnedTabLease(leaseKey: string, initialUrl?: string): Promise<ResolvedTab> {
  return withLeaseMutation(() => createOwnedTabLeaseUnlocked(leaseKey, initialUrl));
}

async function createOwnedTabLeaseUnlocked(leaseKey: string, initialUrl?: string): Promise<ResolvedTab> {
  const targetUrl = (initialUrl && isSafeNavigationUrl(initialUrl)) ? initialUrl : BLANK_PAGE;
  const role = getOwnedWindowRole(leaseKey);
  const { windowId, initialTabId } = await ensureOwnedContainerWindow(role, targetUrl);
  let tab: chrome.tabs.Tab;

  if (initialTabIsAvailable(initialTabId)) {
    tab = await chrome.tabs.get(initialTabId);
    if (!isTargetUrl(tab.url, targetUrl)) {
      tab = await chrome.tabs.update(initialTabId, { url: targetUrl });
      await new Promise(resolve => setTimeout(resolve, 300));
      tab = await chrome.tabs.get(initialTabId);
    }
  } else {
    tab = await chrome.tabs.create({ windowId, url: targetUrl, active: true });
  }

  if (tab.id === undefined) throw new Error(`Failed to create tab lease in ${role} container`);
  setLeaseSession(leaseKey, {
    windowId: tab.windowId,
    preferredTabId: tab.id,
  });
  resetWindowIdleTimer(leaseKey);
  return { tabId: tab.id, tab };
}

async function getAutomationWindow(leaseKey: string, initialUrl?: string): Promise<number> {
  const existing = automationSessions.get(leaseKey);
  if (existing) {
    try {
      if (existing.preferredTabId !== null) {
        const tab = await chrome.tabs.get(existing.preferredTabId);
        if (isDebuggableUrl(tab.url)) return tab.windowId;
      }
      await chrome.windows.get(existing.windowId);
      return existing.windowId;
    } catch {
      await removeLeaseSession(leaseKey);
    }
  }
  return (await ensureOwnedContainerWindow(getOwnedWindowRole(leaseKey), initialUrl)).windowId;
}

async function releaseLease(leaseKey: string, reason = 'released'): Promise<void> {
  const lease = automationSessions.get(leaseKey);
  if (!lease) {
    sessionLifecycleOverrides.delete(leaseKey);
    scheduleIdleAlarm(leaseKey, IDLE_TIMEOUT_NONE);
    await persistRuntimeState();
    return;
  }

  if (lease.idleTimer) clearTimeout(lease.idleTimer);
  scheduleIdleAlarm(leaseKey, IDLE_TIMEOUT_NONE);

  const tabId = lease.preferredTabId;
  if (tabId !== null) {
    const hasOtherLease = [...automationSessions.entries()].some(([otherKey, otherLease]) =>
      otherKey !== leaseKey
      && otherLease.windowId === lease.windowId
      && otherLease.preferredTabId !== null,
    );
    await safeDetach(tabId);
    if (hasOtherLease) {
      await chrome.tabs.remove(tabId).catch(() => {});
      console.log(`[autocli] Released owned tab lease ${tabId} (surface=${lease.surface}, session=${lease.session}, ${reason})`);
    } else {
      try {
        const tab = await chrome.tabs.update(tabId, { url: BLANK_PAGE, active: true });
        ownedContainers[getOwnedWindowRole(leaseKey)].windowId = tab.windowId;
        console.log(`[autocli] Released owned tab lease ${tabId} as reusable placeholder (surface=${lease.surface}, session=${lease.session}, ${reason})`);
      } catch {
        await chrome.tabs.remove(tabId).catch(() => {});
        console.log(`[autocli] Released owned tab lease ${tabId} (surface=${lease.surface}, session=${lease.session}, ${reason})`);
      }
    }
  }

  automationSessions.delete(leaseKey);
  sessionLifecycleOverrides.delete(leaseKey);
  await persistRuntimeState();
}

async function reconcileTargetLeaseRegistry(): Promise<void> {
  const registry = await readRegistry();

  for (const role of ['interactive', 'automation'] as OwnedWindowRole[]) {
    const windowId = registry.ownedContainers[role]?.windowId ?? null;
    ownedContainers[role].windowId = windowId;
    if (windowId !== null) {
      try {
        await chrome.windows.get(windowId);
      } catch {
        ownedContainers[role].windowId = null;
      }
    }
  }

  automationSessions.clear();
  sessionLifecycleOverrides.clear();
  for (const [leaseKey, stored] of Object.entries(registry.leases)) {
    const tabId = stored.preferredTabId;
    if (tabId === null) continue;
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!isDebuggableUrl(tab.url)) continue;
      const surface = stored.surface === 'adapter' ? 'adapter' : 'browser';
      const lifecycle: LeaseLifecycle = stored.lifecycle === 'persistent'
        ? 'persistent'
        : (surface === 'browser' ? 'persistent' : 'ephemeral');
      sessionLifecycleOverrides.set(leaseKey, lifecycle);
      automationSessions.set(leaseKey, {
        session: stored.session || getSessionFromKey(leaseKey),
        surface,
        windowId: tab.windowId,
        preferredTabId: tabId,
        lifecycle,
        idleTimer: null,
        idleDeadlineAt: stored.idleDeadlineAt,
      });
      const role = getOwnedWindowRole(leaseKey);
      if (ownedContainers[role].windowId === null) ownedContainers[role].windowId = tab.windowId;

      const timeout = getIdleTimeout(leaseKey);
      const remaining = stored.idleDeadlineAt > 0
        ? stored.idleDeadlineAt - Date.now()
        : timeout;
      if (timeout > 0) {
        if (remaining <= 0) {
          await releaseLease(leaseKey, 'reconciled idle expiry');
        } else {
          resetWindowIdleTimer(leaseKey, remaining);
        }
      } else {
        resetWindowIdleTimer(leaseKey);
      }
    } catch {
      // Runtime ids are only hints; dead tabs are dropped during convergence.
    }
  }
  await persistRuntimeState();
}

chrome.windows.onRemoved.addListener(async (windowId) => {
  await workerReady;
  for (const container of Object.values(ownedContainers)) {
    if (container.windowId === windowId) container.windowId = null;
  }
  for (const [leaseKey, lease] of [...automationSessions.entries()]) {
    if (lease.windowId !== windowId) continue;
    if (lease.idleTimer) clearTimeout(lease.idleTimer);
    automationSessions.delete(leaseKey);
    sessionLifecycleOverrides.delete(leaseKey);
    scheduleIdleAlarm(leaseKey, IDLE_TIMEOUT_NONE);
  }
  await persistRuntimeState();
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await workerReady;
  for (const [leaseKey, lease] of [...automationSessions.entries()]) {
    if (lease.preferredTabId !== tabId) continue;
    if (lease.idleTimer) clearTimeout(lease.idleTimer);
    automationSessions.delete(leaseKey);
    sessionLifecycleOverrides.delete(leaseKey);
    scheduleIdleAlarm(leaseKey, IDLE_TIMEOUT_NONE);
  }
  await persistRuntimeState();
});

// ─── Lifecycle events ────────────────────────────────────────────────

let initialized = false;

function initialize(): void {
  if (initialized) return;
  initialized = true;
  // Chrome production minimum is 30 seconds; use the same cadence as OpenCLI.
  chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
  executor.registerListeners();
  workerReady = reconcileTargetLeaseRegistry().catch((err) => {
    console.warn(`[autocli] Startup lease recovery failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  void workerReady.then(() => connect());
  console.log('[autocli] AutoCLI extension initialized');
}

chrome.runtime.onInstalled.addListener(() => {
  initialize();
});

chrome.runtime.onStartup.addListener(() => {
  initialize();
});

// MV3 workers can start for events other than install/startup. OpenCLI
// initializes on every worker load so lease recovery always runs.
initialize();

chrome.alarms.onAlarm.addListener(async (alarm) => {
  await workerReady;
  if (alarm.name === 'keepalive') {
    void connect();
    return;
  }
  const leaseKey = leaseKeyFromAlarmName(alarm.name);
  if (!leaseKey) return;
  if ((activeCommandCounts.get(leaseKey) ?? 0) > 0) {
    resetWindowIdleTimer(leaseKey);
    return;
  }
  await releaseLease(leaseKey, 'idle alarm');
});


// ─── Popup status API ───────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'getStatus') {
    sendResponse({
      connected: ws?.readyState === WebSocket.OPEN,
      reconnecting: reconnectTimer !== null,
    });
  }
  return false;
});

// ─── Command dispatcher ─────────────────────────────────────────────

async function handleCommand(cmd: Command): Promise<Result> {
  await workerReady;
  let session: string;
  try {
    session = getSessionName(cmd);
  } catch (err) {
    return {
      id: cmd.id,
      ok: false,
      error: `${err instanceof Error ? err.message : String(err)}; update the AutoCLI CLI and extension together`,
    };
  }
  const surface = getCommandSurface(cmd);
  const leaseKey = getLeaseKey(session, surface);
  if (surface === 'adapter' && (cmd.siteSession === 'persistent' || cmd.siteSession === 'ephemeral')) {
    sessionLifecycleOverrides.set(leaseKey, cmd.siteSession);
  }
  // OpenCLI measures idle from command completion and blocks release while a
  // command is in flight, instead of letting a timer tear down a long run.
  resetWindowIdleTimer(leaseKey);
  activeCommandCounts.set(leaseKey, (activeCommandCounts.get(leaseKey) ?? 0) + 1);
  try {
    switch (cmd.action) {
      case 'exec':
        return await handleExec(cmd, leaseKey);
      case 'navigate':
        return await handleNavigate(cmd, leaseKey);
      case 'tabs':
        return await handleTabs(cmd, leaseKey);
      case 'cookies':
        return await handleCookies(cmd);
      case 'screenshot':
        return await handleScreenshot(cmd, leaseKey);
      case 'close-window':
        return await handleCloseWindow(cmd, leaseKey);
      case 'cdp':
        return await handleCdp(cmd, leaseKey);
      case 'sessions':
        return await handleSessions(cmd);
      case 'set-file-input':
        return await handleSetFileInput(cmd, leaseKey);
      case 'read-article':
        return await handleReadArticle(cmd, leaseKey);
      default:
        return { id: cmd.id, ok: false, error: `Unknown action: ${cmd.action}` };
    }
  } catch (err) {
    return errorResult(cmd.id, err);
  } finally {
    const remaining = (activeCommandCounts.get(leaseKey) ?? 1) - 1;
    if (remaining <= 0) activeCommandCounts.delete(leaseKey);
    else activeCommandCounts.set(leaseKey, remaining);
    resetWindowIdleTimer(leaseKey);
  }
}

// ─── Action handlers ─────────────────────────────────────────────────

/** Internal blank page used when no user URL is provided. */
const BLANK_PAGE = 'about:blank';

/** Check if a URL can be attached via CDP — only allow http(s) and blank pages. */
function isDebuggableUrl(url?: string): boolean {
  if (!url) return true;  // empty/undefined = tab still loading, allow it
  return url.startsWith('http://') || url.startsWith('https://') || url === 'about:blank' || url.startsWith('data:');
}

/** Check if a URL is safe for user-facing navigation (http/https only). */
function isSafeNavigationUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://');
}

/** Minimal URL normalization for same-page comparison: root slash + default port only. */
function normalizeUrlForComparison(url?: string): string {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    if ((parsed.protocol === 'https:' && parsed.port === '443') || (parsed.protocol === 'http:' && parsed.port === '80')) {
      parsed.port = '';
    }
    const pathname = parsed.pathname === '/' ? '' : parsed.pathname;
    return `${parsed.protocol}//${parsed.host}${pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return url;
  }
}

function isTargetUrl(currentUrl: string | undefined, targetUrl: string): boolean {
  return normalizeUrlForComparison(currentUrl) === normalizeUrlForComparison(targetUrl);
}

type ResolvedTab = { tabId: number; tab: chrome.tabs.Tab | null };

/** Resolve the tab owned by a logical OpenCLI-style session lease. */
async function resolveTab(tabId: number | undefined, leaseKey: string, initialUrl?: string): Promise<ResolvedTab> {
  const existing = automationSessions.get(leaseKey);

  if (tabId !== undefined) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (existing?.preferredTabId === tabId && isDebuggableUrl(tab.url)) {
        return { tabId, tab };
      }
      if (!isDebuggableUrl(tab.url)) {
        console.warn(`[autocli] Tab ${tabId} URL is not debuggable (${tab.url}), re-resolving`);
      }
    } catch {
      console.warn(`[autocli] Tab ${tabId} no longer exists, re-resolving`);
    }
  }

  if (existing?.preferredTabId !== null && existing?.preferredTabId !== undefined) {
    try {
      const preferred = await chrome.tabs.get(existing.preferredTabId);
      if (isDebuggableUrl(preferred.url)) {
        return { tabId: existing.preferredTabId, tab: preferred };
      }
    } catch {
      // Re-create below after dropping the stale lease.
    }
    await removeLeaseSession(leaseKey);
    return createOwnedTabLease(leaseKey, initialUrl);
  }

  return createOwnedTabLease(leaseKey, initialUrl);
}

/** Convenience wrapper returning just the tabId (used by most handlers). */
async function resolveTabId(tabId: number | undefined, leaseKey: string, initialUrl?: string): Promise<number> {
  const resolved = await resolveTab(tabId, leaseKey, initialUrl);
  return resolved.tabId;
}

async function listAutomationTabs(leaseKey: string): Promise<chrome.tabs.Tab[]> {
  const lease = automationSessions.get(leaseKey);
  if (!lease) return [];
  if (lease.preferredTabId !== null) {
    try {
      return [await chrome.tabs.get(lease.preferredTabId)];
    } catch {
      await removeLeaseSession(leaseKey);
      return [];
    }
  }
  return [];
}

async function listAutomationWebTabs(leaseKey: string): Promise<chrome.tabs.Tab[]> {
  const tabs = await listAutomationTabs(leaseKey);
  return tabs.filter((tab) => isDebuggableUrl(tab.url));
}

/**
 * Current OpenCLI classifies debugger failures at the extension boundary so
 * the client can distinguish safe semantic retries from unknown outcomes.
 */
function classifyExtensionError(message: string): string | undefined {
  if (/Inspected target navigated|Target closed/.test(message)) return 'target_navigated';
  if (/Detached while handling command/.test(message)) return 'detached_mid_command';
  if (/CDP command .* timed out/.test(message)) return 'cdp_timeout';
  if (/attach failed|Debugger is not attached/.test(message)) return 'attach_failed';
  if (/No tab with id|no longer exists|No window with id/.test(message)) return 'tab_gone';
  return undefined;
}

function errorResult(id: string, err: unknown): Result {
  const message = err instanceof Error ? err.message : String(err);
  const errorCode = classifyExtensionError(message);
  return { id, ok: false, error: message, ...(errorCode ? { errorCode } : {}) };
}

async function handleExec(cmd: Command, leaseKey: string): Promise<Result> {
  if (!cmd.code) return { id: cmd.id, ok: false, error: 'Missing code' };
  const tabId = await resolveTabId(cmd.tabId, leaseKey);
  try {
    // Current OpenCLI reserves aggressive attach retry for the interactive
    // browser surface; adapters use the normal attach policy.
    const aggressive = getSurfaceFromKey(leaseKey) === 'browser';
    const data = await executor.evaluateAsync(tabId, cmd.code, aggressive);
    return { id: cmd.id, ok: true, data };
  } catch (err) {
    return errorResult(cmd.id, err);
  }
}

async function handleNavigate(cmd: Command, leaseKey: string): Promise<Result> {
  if (!cmd.url) return { id: cmd.id, ok: false, error: 'Missing url' };
  if (!isSafeNavigationUrl(cmd.url)) {
    return { id: cmd.id, ok: false, error: 'Blocked URL scheme -- only http:// and https:// are allowed' };
  }
  // Pass target URL so that first-time window creation can start on the right domain
  const resolved = await resolveTab(cmd.tabId, leaseKey, cmd.url);
  const tabId = resolved.tabId;

  const beforeTab = resolved.tab ?? await chrome.tabs.get(tabId);
  const beforeNormalized = normalizeUrlForComparison(beforeTab.url);
  const targetUrl = cmd.url;

  // Fast-path: tab is already at the target URL and fully loaded.
  if (beforeTab.status === 'complete' && isTargetUrl(beforeTab.url, targetUrl)) {
    return {
      id: cmd.id,
      ok: true,
      data: { title: beforeTab.title, url: beforeTab.url, tabId, timedOut: false },
    };
  }

  // Detach any existing debugger before top-level navigation.
  // Some sites (observed on creator.xiaohongshu.com flows) can invalidate the
  // current inspected target during navigation, which leaves a stale CDP attach
  // state and causes the next Runtime.evaluate to fail with
  // "Inspected target navigated or closed". Resetting here forces a clean
  // re-attach after navigation.
  await executor.detach(tabId);

  await chrome.tabs.update(tabId, { url: targetUrl });

  // Wait until navigation completes. Resolve when status is 'complete' AND either:
  // - the URL matches the target (handles same-URL / canonicalized navigations), OR
  // - the URL differs from the pre-navigation URL (handles redirects).
  let timedOut = false;
  await new Promise<void>((resolve) => {
    let settled = false;
    let checkTimer: ReturnType<typeof setTimeout> | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      if (checkTimer) clearTimeout(checkTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      resolve();
    };

    const isNavigationDone = (url: string | undefined): boolean => {
      return isTargetUrl(url, targetUrl) || normalizeUrlForComparison(url) !== beforeNormalized;
    };

    const listener = (id: number, info: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => {
      if (id !== tabId) return;
      if (info.status === 'complete' && isNavigationDone(tab.url ?? info.url)) {
        finish();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);

    // Also check if the tab already navigated (e.g. instant cache hit)
    checkTimer = setTimeout(async () => {
      try {
        const currentTab = await chrome.tabs.get(tabId);
        if (currentTab.status === 'complete' && isNavigationDone(currentTab.url)) {
          finish();
        }
      } catch { /* tab gone */ }
    }, 100);

    // Timeout fallback with warning
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      console.warn(`[autocli] Navigate to ${targetUrl} timed out after 15s`);
      finish();
    }, 15000);
  });

  let tab = await chrome.tabs.get(tabId);

  // Post-navigation drift detection: if the tab moved to another window
  // during navigation (e.g. a tab-management extension regrouped it),
  // try to move it back to maintain session isolation.
  const session = automationSessions.get(leaseKey);
  if (session && tab.windowId !== session.windowId) {
    console.warn(`[autocli] Tab ${tabId} drifted to window ${tab.windowId} during navigation, moving back to ${session.windowId}`);
    try {
      await chrome.tabs.move(tabId, { windowId: session.windowId, index: -1 });
      tab = await chrome.tabs.get(tabId);
    } catch (moveErr) {
      console.warn(`[autocli] Failed to recover drifted tab: ${moveErr}`);
    }
  }

  return {
    id: cmd.id,
    ok: true,
    data: { title: tab.title, url: tab.url, tabId, timedOut },
  };
}

async function handleTabs(cmd: Command, leaseKey: string): Promise<Result> {
  switch (cmd.op) {
    case 'list': {
      const tabs = await listAutomationWebTabs(leaseKey);
      const data = tabs.map((t, i) => ({
        index: i,
        tabId: t.id,
        url: t.url,
        title: t.title,
        active: t.active,
      }));
      return { id: cmd.id, ok: true, data };
    }
    case 'new': {
      if (cmd.url && !isSafeNavigationUrl(cmd.url)) {
        return { id: cmd.id, ok: false, error: 'Blocked URL scheme -- only http:// and https:// are allowed' };
      }
      if (!automationSessions.has(leaseKey)) {
        const created = await createOwnedTabLease(leaseKey, cmd.url);
        return { id: cmd.id, ok: true, data: { tabId: created.tabId, url: created.tab?.url } };
      }
      const windowId = await getAutomationWindow(leaseKey);
      const tab = await chrome.tabs.create({ windowId, url: cmd.url ?? BLANK_PAGE, active: true });
      if (tab.id === undefined) return { id: cmd.id, ok: false, error: 'Failed to create tab' };
      setLeaseSession(leaseKey, {
        windowId: tab.windowId,
        preferredTabId: tab.id,
      });
      resetWindowIdleTimer(leaseKey);
      return { id: cmd.id, ok: true, data: { tabId: tab.id, url: tab.url } };
    }
    case 'close': {
      let targetId: number | undefined;
      if (cmd.index !== undefined) {
        const tabs = await listAutomationWebTabs(leaseKey);
        targetId = tabs[cmd.index]?.id;
        if (targetId === undefined) return { id: cmd.id, ok: false, error: `Tab index ${cmd.index} not found` };
      } else {
        targetId = await resolveTabId(cmd.tabId, leaseKey);
      }
      const current = automationSessions.get(leaseKey);
      if (current?.preferredTabId === targetId) {
        await releaseLease(leaseKey, 'tab close');
      } else {
        await safeDetach(targetId);
        await chrome.tabs.remove(targetId);
      }
      return { id: cmd.id, ok: true, data: { closed: targetId } };
    }
    case 'select': {
      if (cmd.index === undefined && cmd.tabId === undefined) {
        return { id: cmd.id, ok: false, error: 'Missing index or tabId' };
      }
      let targetId = cmd.tabId;
      if (targetId === undefined) {
        const tabs = await listAutomationWebTabs(leaseKey);
        targetId = tabs[cmd.index!]?.id;
      }
      if (targetId === undefined) return { id: cmd.id, ok: false, error: 'Tab not found' };
      let tab: chrome.tabs.Tab;
      try {
        tab = await chrome.tabs.get(targetId);
      } catch {
        return { id: cmd.id, ok: false, error: `Tab ${targetId} no longer exists` };
      }
      const lease = automationSessions.get(leaseKey);
      if (!lease || tab.windowId !== lease.windowId) {
        return { id: cmd.id, ok: false, error: `Tab ${targetId} is not in the automation container` };
      }
      await chrome.tabs.update(targetId, { active: true });
      setLeaseSession(leaseKey, {
        windowId: tab.windowId,
        preferredTabId: targetId,
        lifecycle: lease.lifecycle,
      });
      resetWindowIdleTimer(leaseKey);
      return { id: cmd.id, ok: true, data: { selected: targetId } };
    }
    default:
      return { id: cmd.id, ok: false, error: `Unknown tabs op: ${cmd.op}` };
  }
}

async function handleCookies(cmd: Command): Promise<Result> {
  if (!cmd.domain && !cmd.url) {
    return { id: cmd.id, ok: false, error: 'Cookie scope required: provide domain or url to avoid dumping all cookies' };
  }
  const details: chrome.cookies.GetAllDetails = {};
  if (cmd.domain) details.domain = cmd.domain;
  if (cmd.url) details.url = cmd.url;
  const cookies = await chrome.cookies.getAll(details);
  const data = cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    expirationDate: c.expirationDate,
  }));
  return { id: cmd.id, ok: true, data };
}

async function handleScreenshot(cmd: Command, leaseKey: string): Promise<Result> {
  const tabId = await resolveTabId(cmd.tabId, leaseKey);
  try {
    const data = await executor.screenshot(tabId, {
      format: cmd.format,
      quality: cmd.quality,
      fullPage: cmd.fullPage,
    });
    return { id: cmd.id, ok: true, data };
  } catch (err) {
    return { id: cmd.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** CDP methods permitted via the 'cdp' passthrough action. */
const CDP_ALLOWLIST = new Set([
  // Agent DOM context
  'Accessibility.getFullAXTree',
  'DOM.getDocument',
  'DOM.getBoxModel',
  'DOM.getContentQuads',
  'DOM.querySelectorAll',
  'DOM.scrollIntoViewIfNeeded',
  'DOMSnapshot.captureSnapshot',
  // Native input events
  'Input.dispatchMouseEvent',
  'Input.dispatchKeyEvent',
  'Input.insertText',
  // Page metrics & screenshots
  'Page.getLayoutMetrics',
  'Page.captureScreenshot',
  // Runtime.enable needed for CDP attach setup (Runtime.evaluate goes through 'exec' action)
  'Runtime.enable',
  // Emulation (used by screenshot full-page)
  'Emulation.setDeviceMetricsOverride',
  'Emulation.clearDeviceMetricsOverride',
]);

async function handleCdp(cmd: Command, leaseKey: string): Promise<Result> {
  if (!cmd.cdpMethod) return { id: cmd.id, ok: false, error: 'Missing cdpMethod' };
  if (!CDP_ALLOWLIST.has(cmd.cdpMethod)) {
    return { id: cmd.id, ok: false, error: `CDP method not permitted: ${cmd.cdpMethod}` };
  }
  const tabId = await resolveTabId(cmd.tabId, leaseKey);
  try {
    const aggressive = getSessionFromKey(leaseKey).startsWith('operate:');
    await executor.ensureAttached(tabId, aggressive);
    const data = await chrome.debugger.sendCommand(
      { tabId },
      cmd.cdpMethod,
      cmd.cdpParams ?? {},
    );
    return { id: cmd.id, ok: true, data };
  } catch (err) {
    return { id: cmd.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function handleCloseWindow(cmd: Command, leaseKey: string): Promise<Result> {
  const session = getSessionFromKey(leaseKey);
  const surface = getSurfaceFromKey(leaseKey);
  await releaseLease(leaseKey, 'explicit close');
  return { id: cmd.id, ok: true, data: { closed: true, session, surface } };
}

async function handleSetFileInput(cmd: Command, leaseKey: string): Promise<Result> {
  if (!cmd.files || !Array.isArray(cmd.files) || cmd.files.length === 0) {
    return { id: cmd.id, ok: false, error: 'Missing or empty files array' };
  }
  const tabId = await resolveTabId(cmd.tabId, leaseKey);
  try {
    await executor.setFileInputFiles(tabId, cmd.files, cmd.selector);
    return { id: cmd.id, ok: true, data: { count: cmd.files.length } };
  } catch (err) {
    return { id: cmd.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function handleReadArticle(cmd: Command, leaseKey: string): Promise<Result> {
  if (!cmd.url) return { id: cmd.id, ok: false, error: 'Missing url' };

  // Step 1: navigate (reuses existing handler: creates window, resolves tab, waits for load).
  const navResult = await handleNavigate(cmd, leaseKey);
  if (!navResult.ok) return { id: cmd.id, ok: false, error: navResult.error };
  const navData = navResult.data as { tabId: number; url?: string; title?: string } | undefined;
  if (!navData?.tabId) return { id: cmd.id, ok: false, error: 'Navigate returned no tabId' };
  const tabId = navData.tabId;

  // Step 2: wait for DOM to settle so SPAs have rendered before extraction.
  try {
    await executor.evaluateAsync(tabId, `
      new Promise(resolve => {
        if (!document.body) { setTimeout(() => resolve('nobody'), 3000); return; }
        let timer = null, cap = null;
        const done = (r) => { clearTimeout(timer); clearTimeout(cap); obs.disconnect(); resolve(r); };
        const reset = () => { clearTimeout(timer); timer = setTimeout(() => done('quiet'), 500); };
        const obs = new MutationObserver(reset);
        obs.observe(document.body, { childList: true, subtree: true, attributes: true });
        reset();
        cap = setTimeout(() => done('capped'), 3000);
      })
    `);
  } catch {
    // DOM-stability is best-effort; extraction below is the real gate.
  }

  // Step 3: inject the vendored Readability library into the page's isolated world.
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['reader/Readability.js'],
    });
  } catch (err) {
    return { id: cmd.id, ok: false, error: `Failed to inject Readability: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Step 4: run the extractor. Readability is now on globalThis in the isolated world.
  let injectionResults: chrome.scripting.InjectionResult<unknown>[];
  try {
    injectionResults = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const R = (globalThis as unknown as { Readability?: new (doc: Document) => { parse(): unknown } }).Readability;
        if (!R) return { __err: 'Readability not loaded in page context' };
        // Clone so Readability's destructive parse does not mutate the live DOM.
        const docClone = document.cloneNode(true) as Document;
        const article = new R(docClone).parse() as null | {
          title: string;
          byline: string | null;
          dir: string | null;
          lang: string | null;
          content: string;
          textContent: string;
          length: number;
          excerpt: string;
          siteName: string | null;
          publishedTime: string | null;
        };
        if (!article) return { __err: 'Readability could not extract an article from this page' };
        return {
          title: article.title,
          byline: article.byline,
          dir: article.dir,
          lang: article.lang,
          content: article.content,
          textContent: article.textContent,
          length: article.length,
          excerpt: article.excerpt,
          siteName: article.siteName,
          publishedTime: article.publishedTime,
          url: document.location.href,
        };
      },
    });
  } catch (err) {
    return { id: cmd.id, ok: false, error: `Failed to run extractor: ${err instanceof Error ? err.message : String(err)}` };
  }

  const payload = injectionResults[0]?.result as Record<string, unknown> | undefined;
  if (!payload) return { id: cmd.id, ok: false, error: 'Extractor returned no result' };
  if (typeof payload.__err === 'string') return { id: cmd.id, ok: false, error: payload.__err };

  return { id: cmd.id, ok: true, data: payload };
}

async function handleSessions(cmd: Command): Promise<Result> {
  const now = Date.now();
  const data = [...automationSessions.values()].map((lease) => ({
    session: lease.session,
    surface: lease.surface,
    windowId: lease.windowId,
    preferredTabId: lease.preferredTabId,
    lifecycle: lease.lifecycle,
    idleMsRemaining: lease.idleDeadlineAt <= 0 ? 0 : Math.max(0, lease.idleDeadlineAt - now),
  }));
  return { id: cmd.id, ok: true, data };
}

export const __test__ = {
  handleCommand,
  handleNavigate,
  isTargetUrl,
  handleTabs,
  handleSessions,
  handleCloseWindow,
  resolveTabId,
  resetWindowIdleTimer,
  getAutomationWindow,
  createOwnedTabLease,
  releaseLease,
  reconcileTargetLeaseRegistry,
  getLeaseKey,
  getSession: (session: string, surface: BrowserSurface = 'adapter') =>
    automationSessions.get(getLeaseKey(session, surface)) ?? null,
  getContainerWindowId: (surface: BrowserSurface) =>
    ownedContainers[surface === 'browser' ? 'interactive' : 'automation'].windowId,
  setSession: (
    session: string,
    surface: BrowserSurface,
    lease: { windowId: number; preferredTabId: number | null; lifecycle?: LeaseLifecycle },
  ) => {
    const leaseKey = getLeaseKey(session, surface);
    if (lease.lifecycle) sessionLifecycleOverrides.set(leaseKey, lease.lifecycle);
    setLeaseSession(leaseKey, lease);
  },
  setContainerWindowId: (surface: BrowserSurface, windowId: number | null) => {
    ownedContainers[surface === 'browser' ? 'interactive' : 'automation'].windowId = windowId;
  },
};

// ─── Daemon proxy: relay localhost requests from content scripts ──
const DAEMON_PORT = 19925;
const DAEMON_BASE = `http://localhost:${DAEMON_PORT}`;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'daemon-fetch') {
    const { path, method, body } = msg;
    const url = `${DAEMON_BASE}${path}`;
    const opts: RequestInit = {
      method: method || 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    };

    fetch(url, opts)
      .then(async (resp) => {
        const text = await resp.text();
        sendResponse({ ok: resp.ok, status: resp.status, body: text });
      })
      .catch((e) => {
        sendResponse({ ok: false, status: 0, body: '', error: e.message });
      });

    return true; // async response
  }

  if (msg?.type === 'daemon-stream') {
    const { path, body } = msg;
    const url = `${DAEMON_BASE}${path}`;

    // For streaming, we can't use sendResponse (one-shot).
    // Instead, use a port-based approach via chrome.runtime.connect.
    // But since content scripts initiate this, we handle it differently —
    // content.js will use the port approach directly.
    sendResponse({ error: 'Use daemon-stream-port instead' });
    return false;
  }

  if (msg?.type === 'getStatus') {
    // Move existing getStatus handler here (already handled above)
  }

  return false;
});

// Port-based streaming for AI generate — uses existing daemon WebSocket
const aiStreamPorts = new Map<string, chrome.runtime.Port>();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'daemon-stream') return;

  const streamId = `ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  aiStreamPorts.set(streamId, port);

  port.onMessage.addListener(async (msg) => {
    // If WS not connected, try reconnecting once before giving up
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      await connect();
      // Wait briefly for connection to establish
      await new Promise(r => setTimeout(r, 1000));
    }

    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'ai-generate',
        streamId,
        ...msg,
      }));
    } else {
      port.postMessage({ type: 'error', status: 0, body: 'Daemon not connected. Run: autocli' });
      try { port.disconnect(); } catch {}
      aiStreamPorts.delete(streamId);
    }
  });

  port.onDisconnect.addListener(() => {
    aiStreamPorts.delete(streamId);
  });
});

// ─── Selector Tool: inject on extension icon click ──────────────
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  try {
    // Check if already injected — if so, just toggle
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => !!window.__autocliSelectorActive,
    });
    if (result?.result) {
      // Already injected, re-run content.js to toggle
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['selector/content.js'] });
    } else {
      // First time: inject engine + dom-clean + content
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['selector/engine.js'] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['selector/dom-clean.js'] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['selector/content.js'] });
    }
  } catch (e) {
    console.error('[autocli] Selector inject failed:', e);
  }
});
