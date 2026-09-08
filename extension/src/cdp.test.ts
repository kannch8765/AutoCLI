import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function createChromeMock() {
  const tabs = {
    get: vi.fn(async (_tabId: number) => ({
      id: 1,
      windowId: 1,
      url: 'https://x.com/home',
    })),
    onRemoved: { addListener: vi.fn() },
    onUpdated: { addListener: vi.fn() },
  };

  const debuggerApi = {
    attach: vi.fn(async () => {}),
    detach: vi.fn(async () => {}),
    sendCommand: vi.fn(async (_target: unknown, method: string) => {
      if (method === 'Runtime.evaluate') return { result: { value: 'ok' } };
      return {};
    }),
    onDetach: { addListener: vi.fn() },
  };

  const scripting = {
    executeScript: vi.fn(async () => [{ result: { removed: 1 } }]),
  };

  return {
    chrome: {
      tabs,
      debugger: debuggerApi,
      scripting,
      runtime: { id: 'autocli-test' },
    },
    debuggerApi,
    scripting,
  };
}

describe('cdp attach recovery', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not mutate the DOM before a successful attach', async () => {
    const { chrome, debuggerApi, scripting } = createChromeMock();
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./cdp');
    const result = await mod.evaluate(1, '1');

    expect(result).toBe('ok');
    expect(debuggerApi.attach).toHaveBeenCalledTimes(1);
    expect(scripting.executeScript).not.toHaveBeenCalled();
  });

  it('retries attach without mutating the DOM when a foreign extension interferes', async () => {
    const { chrome, debuggerApi, scripting } = createChromeMock();
    debuggerApi.attach
      .mockRejectedValueOnce(new Error('Cannot access a chrome-extension:// URL of different extension'))
      .mockResolvedValueOnce(undefined);
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./cdp');
    const result = await mod.evaluate(1, '1');

    expect(result).toBe('ok');
    expect(scripting.executeScript).not.toHaveBeenCalled();
    expect(debuggerApi.attach).toHaveBeenCalledTimes(2);
  });

  it('surfaces a lost debugger to the client instead of replaying evaluate internally', async () => {
    const { chrome, debuggerApi } = createChromeMock();
    debuggerApi.sendCommand.mockImplementation(async (_target: unknown, method: string) => {
      if (method === 'Runtime.evaluate') {
        throw new Error('Debugger is not attached to the tab with id: 1.');
      }
      return {};
    });
    vi.stubGlobal('chrome', chrome);

    const mod = await import('./cdp');
    await expect(mod.evaluate(1, '1')).rejects.toThrow('Debugger is not attached');

    // Current OpenCLI lets the transport own semantic retries; cdp.evaluate
    // itself must not attach/evaluate repeatedly with the same command.
    expect(debuggerApi.attach).toHaveBeenCalledTimes(1);
  });

});
