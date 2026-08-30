import { DAEMON_PORT } from './protocol';

export const DAEMON_PORT_STORAGE_KEY = 'daemonPort';

export function normalizeDaemonPort(value: unknown): number {
  const parsed = typeof value === 'number'
    ? value
    : (typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN);

  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) return DAEMON_PORT;
  return parsed;
}

export async function getDaemonPort(): Promise<number> {
  const stored = await chrome.storage.local.get(DAEMON_PORT_STORAGE_KEY);
  return normalizeDaemonPort(stored[DAEMON_PORT_STORAGE_KEY]);
}

export async function setDaemonPort(port: number): Promise<void> {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Daemon port must be an integer between 1 and 65535');
  }
  await chrome.storage.local.set({ [DAEMON_PORT_STORAGE_KEY]: port });
}
