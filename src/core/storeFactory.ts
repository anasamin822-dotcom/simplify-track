// Native (and default) implementation: real on-device SQLite.
import type { Store } from './store.ts';

export async function openDeviceStore(): Promise<Store> {
  const { SqliteStore } = await import('./sqlite.ts');
  const s = new SqliteStore();
  await s.open();
  return s;
}
