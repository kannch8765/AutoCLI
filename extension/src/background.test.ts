// Based on OpenCLI (https://github.com/jackwener/opencli) by jackwener
// Licensed under Apache-2.0. Modified for AutoCLI.
import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockTab = {
  id: number;
  windowId: number;
  url?: string;
  title?: string;
  active?: boolean;
  status?: string;
};

type ListenerStore<T extends (...args: any[]) => any> = {
  addListener: ReturnType<typeof vi.fn>;
  removeListener?: ReturnType<typeof vi.fn>;
  listeners: T[];
};

function event<T extends (...args: any[]) => any>(): ListenerStore<T> {
  const listeners: T[] = [];
  return {
    listeners,
    addListener: vi.fn((fn: T) => { listeners.push(fn); }),
    removeListener: vi.fn((fn: T) => {
      const index = listeners.indexOf(fn);
      if (index >= 0) listeners.splice(index, 1);
    }),
  };
}

class MockWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(_url: string) {}
  send(_data: string): void {}
  close(): void { this.onclose?.(); }
}

const REGISTRY_KEY = 'autocli_target_lease_registry_v3';
const leaseKey = (session: string, surface: 'browser' | 'adapter' = 'adapter') =>
  `${surface}\u0000${encodeURIComponent(session)}`;
const alarmName = (session: string, surface: 'browser' | 'adapter' = 'adapter') =>
  `autocli:lease-idle:${encodeURIComponent(leaseKey(session, surface))}`;

function createChromeMock(opts: { initialUrl?: string } = {}) {
  let nextTabId = 10;
  let nextWindowId = 10;
  const sessionStorage: Record<string, unknown> = {};
  const windows = new Set<number>([1, 2]);
  const tabs: MockTab[] = [
    {
      id: 1,
      windowId: 1,
      url: opts.initialUrl ?? 'about:blank',
      title: 'automation',
      active: true,
      status: 'complete',
    },
    {
      id: 2,
      windowId: 2,
      url: 'https://user.example',
      title: 'user',
      active: true,
      status: 'complete',
    },
  ];

  const tabsOnUpdated = event<(id: number, info: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => void>();
  const tabsOnRemoved = event<(tabId: number) => void>();
  const windowsOnRemoved = event<(windowId: number) => void>();
  const alarmsOnAlarm = event<(alarm: { name: string }) => void>();
  const debuggerOnDetach = event<(source: { tabId?: number }, reason?: string) => void>();

  const query = vi.fn(async (queryInfo: { windowId?: number } = {}) =>
    tabs.filter((tab) => queryInfo.windowId === undefined || tab.windowId === queryInfo.windowId));

  const createTab = vi.fn(async ({ windowId, url, active }: { windowId?: number; url?: string; active?: boolean }) => {
    const resolvedWindowId = windowId ?? 1;
    windows.add(resolvedWindowId);
    const tab: MockTab = {
      id: nextTabId++,
      windowId: resolvedWindowId,
      url: url ?? 'about:blank',
      title: url ?? 'blank',
      active: !!active,
      status: 'complete',
    };
    tabs.push(tab);
    return tab;
  });

  const updateTab = vi.fn(async (tabId: number, updates: { active?: boolean; url?: string }) => {
    const tab = tabs.find((entry) => entry.id === tabId);
    if (!tab) throw new Error(`Unknown tab ${tabId}`);
    if (updates.active !== undefined) tab.active = updates.active;
    if (updates.url !== undefined) {
      tab.url = updates.url;
      tab.title = updates.url;
    }
    return tab;
  });

  const removeTab = vi.fn(async (tabId: number) => {
    const index = tabs.findIndex((entry) => entry.id === tabId);
    if (index >= 0) tabs.splice(index, 1);
  });

  const createWindow = vi.fn(async ({ url, focused, width, height, type }: any) => {
    const windowId = nextWindowId++;
    windows.add(windowId);
    const tab: MockTab = {
      id: nextTabId++,
      windowId,
      url: url ?? 'about:blank',
      title: url ?? 'blank',
      active: true,
      status: 'complete',
    };
    tabs.push(tab);
    return { id: windowId, focused, width, height, type };
  });

  const removeWindow = vi.fn(async (windowId: number) => {
    windows.delete(windowId);
    for (let i = tabs.length - 1; i >= 0; i--) {
      if (tabs[i].windowId === windowId) tabs.splice(i, 1);
    }
  });

  const chrome = {
    tabs: {
      query,
      create: createTab,
      update: updateTab,
      remove: removeTab,
      move: vi.fn(async (tabId: number, { windowId }: { windowId: number }) => {
        const tab = tabs.find((entry) => entry.id === tabId);
        if (!tab) throw new Error(`Unknown tab ${tabId}`);
        tab.windowId = windowId;
        return tab;
      }),
      get: vi.fn(async (tabId: number) => {
        const tab = tabs.find((entry) => entry.id === tabId);
        if (!tab) throw new Error(`Unknown tab ${tabId}`);
        return tab;
      }),
      onUpdated: tabsOnUpdated,
      onRemoved: tabsOnRemoved,
    },
    windows: {
      get: vi.fn(async (windowId: number) => {
        if (!windows.has(windowId)) throw new Error(`Unknown window ${windowId}`);
        return { id: windowId };
      }),
      create: createWindow,
      remove: removeWindow,
      onRemoved: windowsOnRemoved,
    },
    alarms: {
      create: vi.fn(),
      clear: vi.fn(),
      onAlarm: alarmsOnAlarm,
    },
    debugger: {
      attach: vi.fn(async () => {}),
      detach: vi.fn(async () => {}),
      sendCommand: vi.fn(async () => ({})),
      onDetach: debuggerOnDetach,
    },
    runtime: {
      onInstalled: event<() => void>(),
      onStartup: event<() => void>(),
      onMessage: event<(...args: any[]) => void>(),
      onConnect: event<(...args: any[]) => void>(),
      getManifest: vi.fn(() => ({ version: '1.5.7' })),
    },
    action: {
      onClicked: event<(...args: any[]) => void>(),
    },
    cookies: {
      getAll: vi.fn(async () => []),
    },
    storage: {
      session: {
        get: vi.fn(async (key: string) => ({ [key]: sessionStorage[key] })),
        set: vi.fn(async (values: Record<string, unknown>) => { Object.assign(sessionStorage, values); }),
        remove: vi.fn(async (key: string) => { delete sessionStorage[key]; }),
      },
    },
    scripting: {
      executeScript: vi.fn(async () => []),
    },
  };

  return {
    chrome,
    tabs,
    windows,
    sessionStorage,
    query,
    createTab,
    updateTab,
    removeTab,
    createWindow,
    removeWindow,
    alarmsOnAlarm,
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('OpenCLI lifecycle parity', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline test'); }));
  });

  it('rejects legacy workspace-only commands explicitly instead of timing out', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    const result = await mod.__test__.handleCommand({
      id: 'legacy-wire',
      action: 'close-window',
      workspace: 'default',
    } as any);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Browser session is required');
    expect(result.error).toContain('update the AutoCLI CLI and extension together');
  });

  it('leases separate tabs for separate ephemeral sessions inside one shared automation container', async () => {
    const { chrome, tabs } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    mod.__test__.setContainerWindowId('adapter', 1);

    const first = await mod.__test__.createOwnedTabLease(leaseKey('site:rednote:run-1'), 'https://www.rednote.com/explore');
    const second = await mod.__test__.createOwnedTabLease(leaseKey('site:twitter:run-2'), 'https://x.com/home');

    expect(first.tabId).toBe(1);
    expect(second.tabId).not.toBe(first.tabId);
    expect(tabs.find((tab) => tab.id === first.tabId)?.windowId).toBe(1);
    expect(tabs.find((tab) => tab.id === second.tabId)?.windowId).toBe(1);
    expect(chrome.windows.create).not.toHaveBeenCalled();
  });

  it('keeps browser and adapter sessions in separate owned containers even when the session name matches', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    mod.__test__.setContainerWindowId('adapter', 1);
    mod.__test__.setContainerWindowId('browser', 2);

    const adapter = await mod.__test__.createOwnedTabLease(leaseKey('same', 'adapter'));
    const browser = await mod.__test__.createOwnedTabLease(leaseKey('same', 'browser'));

    expect(adapter.tabId).toBe(1);
    expect(browser.tabId).not.toBe(adapter.tabId);
    expect((await chrome.tabs.get(adapter.tabId)).windowId).toBe(1);
    expect((await chrome.tabs.get(browser.tabId)).windowId).toBe(2);
    expect(mod.__test__.getSession('same', 'adapter')?.surface).toBe('adapter');
    expect(mod.__test__.getSession('same', 'browser')?.surface).toBe('browser');
  });

  it('uses OpenCLI browser defaults: persistent lifecycle with a 10 minute idle lease', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    mod.__test__.setContainerWindowId('browser', 2);
    await mod.__test__.createOwnedTabLease(leaseKey('browser-run', 'browser'));

    const lease = mod.__test__.getSession('browser-run', 'browser');
    expect(lease?.lifecycle).toBe('persistent');
    expect(lease?.idleDeadlineAt).toBeGreaterThan(Date.now() + 9 * 60_000);
    expect(chrome.alarms.create).toHaveBeenCalledWith(
      alarmName('browser-run', 'browser'),
      expect.objectContaining({ when: expect.any(Number) }),
    );
  });

  it('releases the last lease by detaching its target and leaving a reusable about:blank placeholder', async () => {
    const { chrome, tabs } = createChromeMock({ initialUrl: 'https://www.rednote.com/' });
    vi.stubGlobal('chrome', chrome);
    const executor = await import('./cdp');
    const detach = vi.spyOn(executor, 'detach').mockResolvedValue(undefined);
    const mod = await import('./background');
    mod.__test__.setContainerWindowId('adapter', 1);
    mod.__test__.setSession('site:rednote:run-1', 'adapter', {
      windowId: 1,
      preferredTabId: 1,
      lifecycle: 'ephemeral',
    });

    await mod.__test__.releaseLease(leaseKey('site:rednote:run-1'), 'test release');

    expect(detach).toHaveBeenCalledWith(1);
    expect(chrome.tabs.update).toHaveBeenCalledWith(1, { url: 'about:blank', active: true });
    expect(chrome.windows.remove).not.toHaveBeenCalled();
    expect(tabs.find((tab) => tab.id === 1)?.url).toBe('about:blank');
    expect(mod.__test__.getSession('site:rednote:run-1')).toBeNull();
  });

  it('removes only the released tab when another lease still owns a tab in the container', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    const executor = await import('./cdp');
    vi.spyOn(executor, 'detach').mockResolvedValue(undefined);
    const mod = await import('./background');
    mod.__test__.setContainerWindowId('adapter', 1);

    const first = await mod.__test__.createOwnedTabLease(leaseKey('site:rednote:run-1'));
    const second = await mod.__test__.createOwnedTabLease(leaseKey('site:twitter:run-2'));
    chrome.tabs.remove.mockClear();

    await mod.__test__.releaseLease(leaseKey('site:rednote:run-1'), 'test release');

    expect(chrome.tabs.remove).toHaveBeenCalledWith(first.tabId);
    expect(chrome.tabs.update).not.toHaveBeenCalledWith(first.tabId, { url: 'about:blank', active: true });
    expect(mod.__test__.getSession('site:twitter:run-2')?.preferredTabId).toBe(second.tabId);
  });

  it('keeps persistent site leases alive without an idle deadline', async () => {
    vi.useFakeTimers();
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);
    const mod = await import('./background');
    mod.__test__.setContainerWindowId('adapter', 1);
    mod.__test__.setSession('site:rednote', 'adapter', {
      windowId: 1,
      preferredTabId: 1,
      lifecycle: 'persistent',
    });
    mod.__test__.resetWindowIdleTimer(leaseKey('site:rednote'));

    await vi.advanceTimersByTimeAsync(60_000);

    expect(mod.__test__.getSession('site:rednote')?.idleDeadlineAt).toBe(0);
    expect(chrome.tabs.update).not.toHaveBeenCalledWith(1, { url: 'about:blank', active: true });
    expect(chrome.alarms.clear).toHaveBeenCalledWith(alarmName('site:rednote'));
    vi.useRealTimers();
  });

  it('restores an ephemeral preferred-tab lease from storage.session after worker eviction', async () => {
    const { chrome, sessionStorage } = createChromeMock({ initialUrl: 'https://www.rednote.com/' });
    const deadline = Date.now() + 30_000;
    sessionStorage[REGISTRY_KEY] = {
      version: 3,
      ownedContainers: { interactive: { windowId: null }, automation: { windowId: 1 } },
      leases: {
        [leaseKey('site:rednote:run-1')]: {
          session: 'site:rednote:run-1',
          surface: 'adapter',
          windowId: 1,
          preferredTabId: 1,
          lifecycle: 'ephemeral',
          idleDeadlineAt: deadline,
          updatedAt: Date.now(),
        },
      },
    };
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    await vi.waitFor(() => {
      expect(mod.__test__.getSession('site:rednote:run-1')?.preferredTabId).toBe(1);
    });

    expect(mod.__test__.getContainerWindowId('adapter')).toBe(1);
    expect(chrome.windows.create).not.toHaveBeenCalled();
  });

  it('honors the persisted remaining idle lifetime instead of granting a fresh 30 seconds', async () => {
    const { chrome, sessionStorage } = createChromeMock({ initialUrl: 'https://www.rednote.com/' });
    const now = Date.now();
    sessionStorage[REGISTRY_KEY] = {
      version: 3,
      ownedContainers: { interactive: { windowId: null }, automation: { windowId: 1 } },
      leases: {
        [leaseKey('site:rednote:run-1')]: {
          session: 'site:rednote:run-1',
          surface: 'adapter',
          windowId: 1,
          preferredTabId: 1,
          lifecycle: 'ephemeral',
          idleDeadlineAt: now + 5_000,
          updatedAt: now,
        },
      },
    };
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    await mod.__test__.reconcileTargetLeaseRegistry();

    const calls = chrome.alarms.create.mock.calls
      .filter((call: unknown[]) => call[0] === alarmName('site:rednote:run-1'));
    expect(calls.length).toBeGreaterThan(0);
    const when = (calls.at(-1)![1] as { when: number }).when;
    expect(when).toBeLessThan(now + 15_000);
    expect(when).toBeGreaterThan(now + 1_000);
  });

  it('recovers a lost in-memory REDnote lease before close-window, then detaches and releases it', async () => {
    const { chrome, sessionStorage, tabs } = createChromeMock({ initialUrl: 'https://www.rednote.com/' });
    sessionStorage[REGISTRY_KEY] = {
      version: 3,
      ownedContainers: { interactive: { windowId: null }, automation: { windowId: 1 } },
      leases: {
        [leaseKey('site:rednote:run-1')]: {
          session: 'site:rednote:run-1',
          surface: 'adapter',
          windowId: 1,
          preferredTabId: 1,
          lifecycle: 'ephemeral',
          idleDeadlineAt: Date.now() + 30_000,
          updatedAt: Date.now(),
        },
      },
    };
    vi.stubGlobal('chrome', chrome);
    const executor = await import('./cdp');
    const detach = vi.spyOn(executor, 'detach').mockResolvedValue(undefined);
    const mod = await import('./background');

    const result = await mod.__test__.handleCommand({
      id: 'close-after-worker-restart',
      action: 'close-window',
      session: 'site:rednote:run-1',
      surface: 'adapter',
      siteSession: 'ephemeral',
    });

    expect(result.ok).toBe(true);
    expect(detach).toHaveBeenCalledWith(1);
    expect(tabs.find((tab) => tab.id === 1)?.url).toBe('about:blank');
    expect(mod.__test__.getSession('site:rednote:run-1')).toBeNull();
  });

  it('does not wipe the persisted registry when an idle alarm wakes the worker before recovery finishes', async () => {
    const { chrome, sessionStorage, alarmsOnAlarm } = createChromeMock({ initialUrl: 'https://www.rednote.com/' });
    sessionStorage[REGISTRY_KEY] = {
      version: 3,
      ownedContainers: { interactive: { windowId: null }, automation: { windowId: 1 } },
      leases: {
        [leaseKey('site:rednote:run-1')]: {
          session: 'site:rednote:run-1',
          surface: 'adapter',
          windowId: 1,
          preferredTabId: 1,
          lifecycle: 'ephemeral',
          idleDeadlineAt: Date.now() + 30_000,
          updatedAt: Date.now(),
        },
      },
    };

    const gate = deferred<void>();
    const originalGet = chrome.storage.session.get;
    chrome.storage.session.get = vi.fn(async (key: string) => {
      if (key === REGISTRY_KEY) await gate.promise;
      return originalGet(key);
    });
    vi.stubGlobal('chrome', chrome);

    await import('./background');
    const listener = alarmsOnAlarm.listeners[0];
    expect(listener).toBeDefined();
    const alarmDone = listener({ name: alarmName('site:rednote:run-1') });

    await flush();
    expect((sessionStorage[REGISTRY_KEY] as any).leases[leaseKey('site:rednote:run-1')]).toBeDefined();

    gate.resolve();
    await alarmDone;
  });

  it('tags debugger detach-before-exec as attach_failed for OpenCLI semantic retry', async () => {
    const { chrome } = createChromeMock({ initialUrl: 'https://www.rednote.com/' });
    vi.stubGlobal('chrome', chrome);
    const executor = await import('./cdp');
    vi.spyOn(executor, 'evaluateAsync').mockRejectedValueOnce(
      new Error('Debugger is not attached to the tab with id: 1.'),
    );
    const mod = await import('./background');
    mod.__test__.setContainerWindowId('adapter', 1);
    mod.__test__.setSession('site:rednote:run-attach', 'adapter', {
      windowId: 1,
      preferredTabId: 1,
      lifecycle: 'ephemeral',
    });

    const result = await mod.__test__.handleCommand({
      id: 'exec-after-cross-lane-detach',
      action: 'exec',
      code: '1',
      session: 'site:rednote:run-attach',
      surface: 'adapter',
      siteSession: 'ephemeral',
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'attach_failed',
    });
  });

});
