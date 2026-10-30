// Web preview: localStorage-backed store. Sync works the same and data
// survives reloads, which lets the offline/restart behaviour be exercised in
// a browser. Native builds use ./storeFactory.ts (expo-sqlite).
import { LocalStorageStore } from './localstore.web.ts';
import type { Store } from './store.ts';

export async function openDeviceStore(): Promise<Store> {
  return new LocalStorageStore();
}
