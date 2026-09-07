// Based on OpenCLI (https://github.com/jackwener/opencli) by jackwener
// Licensed under Apache-2.0. Modified for AutoCLI.
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Listener<T extends (...args: any[]) => void> = { addListener: (fn: T) => void };

type MockTab = {
  id: number;
  windowId: number;
  url?: string;
  title?: string;
  active?: boolean;
  status?: string;
};

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
  close(): void {
    this.onclose?.();
  }
}

function createChromeMock() {
  let nextTabId = 10;
  const sessionStorage: Record<string, unknown> = {};
  const tabs: MockTab[] = [
    { id: 1, windowId: 1, url: 'https://automation.example', title: 'automation', active: true, status: 'complete' },
    { id: 2, windowId: 2, url: 'https://user.example', title: 'user', active: true, status: 'complete' },
    { id: 3, windowId: 1, url: 'chrome://extensions', title: 'chrome', active: false, status: 'complete' },
  ];

  const query = vi.fn(async (queryInfo: { windowId?: number } = {}) => {
    return tabs.filter((tab) => queryInfo.windowId === undefined || tab.windowId === queryInfo.windowId);
  });
  const create = vi.fn(async ({ windowId, url, active }: { windowId?: number; url?: string; active?: boolean }) => {
    const tab: MockTab = {
      id: nextTabId++,
      windowId: windowId ?? 999,
      url,
      title: url ?? 'blank',
      active: !!active,
      status: 'complete',
    };
    tabs.push(tab);
    return tab;
  });
  const update = vi.fn(async (tabId: number, updates: { active?: boolean; url?: string }) => {
    const tab = tabs.find((entry) => entry.id === tabId);
    if (!tab) throw new Error(`Unknown tab ${tabId}`);
    if (updates.active !== undefined) tab.active = updates.active;
    if (updates.url !== undefined) tab.url = updates.url;
    return tab;
  });

  const chrome = {
    tabs: {
      query,
      create,
      update,
      remove: vi.fn(async (_tabId: number) => {}),
      get: vi.fn(async (tabId: number) => {
        const tab = tabs.find((entry) => entry.id === tabId);
        if (!tab) throw new Error(`Unknown tab ${tabId}`);
        return tab;
      }),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() } as Listener<(id: number, info: chrome.tabs.TabChangeInfo) => void>,
    },
    windows: {
      get: vi.fn(async (windowId: number) => ({ id: windowId })),
      create: vi.fn(async ({ url, focused, width, height, type }: any) => ({ id: 1, url, focused, width, height, type })),
      remove: vi.fn(async (_windowId: number) => {}),
      onRemoved: { addListener: vi.fn() } as Listener<(windowId: number) => void>,
    },
    alarms: {
      create: vi.fn(),
      onAlarm: { addListener: vi.fn() } as Listener<(alarm: { name: string }) => void>,
    },
    runtime: {
      onInstalled: { addListener: vi.fn() } as Listener<() => void>,
      onStartup: { addListener: vi.fn() } as Listener<() => void>,
      onMessage: { addListener: vi.fn() } as Listener<(...args: any[]) => void>,
      onConnect: { addListener: vi.fn() } as Listener<(...args: any[]) => void>,
      getManifest: vi.fn(() => ({ version: '1.5.6' })),
    },
    action: {
      onClicked: { addListener: vi.fn() } as Listener<(...args: any[]) => void>,
    },
    cookies: {
      getAll: vi.fn(async () => []),
    },
    storage: {
      session: {
        get: vi.fn(async (key: string) => ({
          [key]: sessionStorage[key],
        })),
        set: vi.fn(async (values: Record<string, unknown>) => {
          Object.assign(sessionStorage, values);
        }),
        remove: vi.fn(async (key: string) => {
          delete sessionStorage[key];
        }),
      },
    },
  };

  return { chrome, tabs, query, create, update, sessionStorage };
}

describe('background tab isolation', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  it('lists only automation-window web tabs', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    mod.__test__.setAutomationWindowId('site:twitter', 1);

    const result = await mod.__test__.handleTabs({ id: '1', action: 'tabs', op: 'list', workspace: 'site:twitter' }, 'site:twitter');

    expect(result.ok).toBe(true);
    expect(result.data).toEqual([
      {
        index: 0,
        tabId: 1,
        url: 'https://automation.example',
        title: 'automation',
        active: true,
      },
    ]);
  });

  it('creates new tabs inside the automation window', async () => {
    const { chrome, create } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    mod.__test__.setAutomationWindowId('site:twitter', 1);

    const result = await mod.__test__.handleTabs({ id: '2', action: 'tabs', op: 'new', url: 'https://new.example', workspace: 'site:twitter' }, 'site:twitter');

    expect(result.ok).toBe(true);
    expect(create).toHaveBeenCalledWith({ windowId: 1, url: 'https://new.example', active: true });
  });

  it('reports sessions per workspace', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    mod.__test__.setAutomationWindowId('site:twitter', 1);
    mod.__test__.setAutomationWindowId('site:zhihu', 2);

    const result = await mod.__test__.handleSessions({ id: '3', action: 'sessions' });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ workspace: 'site:twitter', windowId: 1 }),
      expect.objectContaining({ workspace: 'site:zhihu', windowId: 2 }),
    ]));
  });
  it('does not idle-close persistent site workspaces', async () => {
    vi.useFakeTimers();
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    mod.__test__.setAutomationWindowId('site:xiaohongshu', 1);
    mod.__test__.resetWindowIdleTimer('site:xiaohongshu');

    await vi.advanceTimersByTimeAsync(60_000);
    expect(chrome.windows.remove).not.toHaveBeenCalled();
    expect(mod.__test__.getSession('site:xiaohongshu')?.idleDeadlineAt).toBe(Number.POSITIVE_INFINITY);
    vi.useRealTimers();
  });


  it('restores a persistent site window after a service-worker restart', async () => {
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const firstWorker = await import('./background');
    const firstWindowId = await firstWorker.__test__.getAutomationWindow(
      'site:xiaohongshu',
      'https://www.xiaohongshu.com/search_result?keyword=coffee',
    );
    expect(firstWindowId).toBe(1);
    expect(chrome.windows.create).toHaveBeenCalledTimes(1);

    // Simulate MV3 worker eviction: module memory disappears, Chrome windows and
    // chrome.storage.session survive.
    vi.resetModules();
    const secondWorker = await import('./background');
    const restoredWindowId = await secondWorker.__test__.getAutomationWindow(
      'site:xiaohongshu',
      'https://www.xiaohongshu.com/search_result?keyword=dessert',
    );

    expect(restoredWindowId).toBe(firstWindowId);
    expect(chrome.windows.create).toHaveBeenCalledTimes(1);
    expect(secondWorker.__test__.getSession('site:xiaohongshu')?.idleDeadlineAt)
      .toBe(Number.POSITIVE_INFINITY);
  });

  it('still idle-closes one-shot workspaces', async () => {
    vi.useFakeTimers();
    const { chrome } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./background');
    mod.__test__.setAutomationWindowId('default', 1);
    mod.__test__.resetWindowIdleTimer('default');

    await vi.advanceTimersByTimeAsync(30_001);
    expect(chrome.windows.remove).toHaveBeenCalledWith(1);
    expect(mod.__test__.getSession('default')).toBeNull();
    vi.useRealTimers();
  });

});
