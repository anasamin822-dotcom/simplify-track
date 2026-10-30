// localStorage-backed Store for the web preview, so "aeroplane mode and app
// restart" can be exercised in a browser too: data survives a reload with the
// server down. Device builds use expo-sqlite (see storeFactory.ts).

import type { Account, CanonicalTxn } from './types.ts';
import type { Store } from './store.ts';

const TXN = 'track.txn.';
const META = 'track.meta.';
const ACCT = 'track.acct.';

export class LocalStorageStore implements Store {
  async commit(batch: { upserts?: CanonicalTxn[]; deletes?: string[]; meta?: Record<string, string>; accountsReplace?: Account[] }): Promise<void> {
    if (batch.accountsReplace) {
      const doomed: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)!;
        if (k.startsWith(ACCT)) doomed.push(k);
      }
      for (const k of doomed) localStorage.removeItem(k);
      for (const a of batch.accountsReplace) localStorage.setItem(ACCT + a.id, JSON.stringify(a));
    }
    // localStorage is quota-tight (~5MB): the verbatim server record is kept on
    // device (SQLite) but dropped here; re-syncing regenerates it.
    for (const t of batch.upserts ?? []) localStorage.setItem(TXN + t.id, JSON.stringify({ ...t, raw: '' }));
    for (const id of batch.deletes ?? []) localStorage.removeItem(TXN + id);
    for (const [k, v] of Object.entries(batch.meta ?? {})) localStorage.setItem(META + k, v);
  }
  async allTxns(): Promise<CanonicalTxn[]> {
    const out: CanonicalTxn[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!;
      if (k.startsWith(TXN)) out.push(JSON.parse(localStorage.getItem(k)!));
    }
    return out.sort((a, b) => b.occurredAtMs - a.occurredAtMs || (a.id < b.id ? -1 : 1));
  }
  async txnById(id: string): Promise<CanonicalTxn | null> {
    const v = localStorage.getItem(TXN + id);
    return v ? JSON.parse(v) : null;
  }
  async txnsByIds(ids: string[]): Promise<Map<string, CanonicalTxn>> {
    const out = new Map<string, CanonicalTxn>();
    for (const id of ids) {
      const v = localStorage.getItem(TXN + id);
      if (v) out.set(id, JSON.parse(v));
    }
    return out;
  }
  async count(): Promise<number> {
    let n = 0;
    for (let i = 0; i < localStorage.length; i++) if (localStorage.key(i)!.startsWith(TXN)) n++;
    return n;
  }
  async getMeta(key: string): Promise<string | null> {
    return localStorage.getItem(META + key);
  }
  async putAccounts(accounts: Account[]): Promise<void> {
    for (const a of accounts) localStorage.setItem(ACCT + a.id, JSON.stringify(a));
  }
  async allAccounts(): Promise<Account[]> {
    const out: Account[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!;
      if (k.startsWith(ACCT)) out.push(JSON.parse(localStorage.getItem(k)!));
    }
    return out;
  }
  async clearSyncState(): Promise<void> {
    for (const k of ['sync_token', 'full_sync_cursor', 'full_sync_seen', 'last_sync_error']) localStorage.removeItem(META + k);
  }
}
