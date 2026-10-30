// Local persistence boundary. The app reads ONLY from the store; the network
// writes into it page by page. Non-negotiable #5: a failure never costs the
// user what they could already see - every completed page is committed before
// the next request, and a failed sync leaves the stored data untouched.

import type { Account, CanonicalTxn } from './types.ts';

export interface Store {
  // Page-atomic: applies upserts+deletes+meta in one commit.
  commit(batch: { upserts?: CanonicalTxn[]; deletes?: string[]; meta?: Record<string, string>; accountsReplace?: Account[] }): Promise<void>;
  allTxns(): Promise<CanonicalTxn[]>;
  txnById(id: string): Promise<CanonicalTxn | null>;
  txnsByIds(ids: string[]): Promise<Map<string, CanonicalTxn>>;
  count(): Promise<number>;
  getMeta(key: string): Promise<string | null>;
  putAccounts(accounts: Account[]): Promise<void>;
  allAccounts(): Promise<Account[]>;
  clearSyncState(): Promise<void>; // drops cursor/token meta ONLY, never transactions
}

export const META = {
  syncToken: 'sync_token', // last completed sync position
  fullCursor: 'full_sync_cursor', // resume position of an interrupted FULL sync
  fullSeenIds: 'full_sync_seen', // ids seen so far in the interrupted full sync (dedupe across pages)
  lastSyncAt: 'last_sync_at',
  lastSyncError: 'last_sync_error',
  lock: 'sync_lock',
  quarantined: 'quarantined_records',
  quarantinedCount: 'quarantined_count',
  quarantinedIds: 'quarantined_ids', // bounded id set so a record that later reads (or is deleted) clears its own warning
  quarantinedTruncated: 'quarantined_truncated', // '1' once more records are skipped than the id set can track: the count is then an upper bound
  nextSyncNotBefore: 'next_sync_not_before',
  nextSyncNotBeforeUrl: 'next_sync_not_before_url',
  dataSourceUrl: 'data_source_url', // records the server sent but we could not read (skipped, never silently)
} as const;

export class MemoryStore implements Store {
  txns = new Map<string, CanonicalTxn>();
  meta = new Map<string, string>();
  accounts = new Map<string, Account>();

  async commit(batch: { upserts?: CanonicalTxn[]; deletes?: string[]; meta?: Record<string, string>; accountsReplace?: Account[] }): Promise<void> {
    if (batch.accountsReplace) {
      this.accounts.clear();
      for (const a of batch.accountsReplace) this.accounts.set(a.id, a);
    }
    for (const t of batch.upserts ?? []) this.txns.set(t.id, t);
    for (const id of batch.deletes ?? []) this.txns.delete(id);
    for (const [k, v] of Object.entries(batch.meta ?? {})) this.meta.set(k, v);
  }
  async allTxns(): Promise<CanonicalTxn[]> {
    return [...this.txns.values()].sort((a, b) => b.occurredAtMs - a.occurredAtMs || (a.id < b.id ? -1 : 1));
  }
  async txnById(id: string): Promise<CanonicalTxn | null> {
    return this.txns.get(id) ?? null;
  }
  async txnsByIds(ids: string[]): Promise<Map<string, CanonicalTxn>> {
    const out = new Map<string, CanonicalTxn>();
    for (const id of ids) {
      const t = this.txns.get(id);
      if (t) out.set(id, t);
    }
    return out;
  }
  async count(): Promise<number> {
    return this.txns.size;
  }
  async getMeta(key: string): Promise<string | null> {
    return this.meta.get(key) ?? null;
  }
  async putAccounts(accounts: Account[]): Promise<void> {
    for (const a of accounts) this.accounts.set(a.id, a);
  }
  async allAccounts(): Promise<Account[]> {
    return [...this.accounts.values()];
  }
  async clearSyncState(): Promise<void> {
    for (const k of [META.syncToken, META.fullCursor, META.fullSeenIds, META.lastSyncError]) this.meta.delete(k);
  }
}
