// expo-sqlite implementation of the Store. Used on device; tests use
// MemoryStore. Same contract, same commit semantics (one transaction per
// batch - a crash between batches never leaves a half-written page).

import * as SQLite from 'expo-sqlite';
import type { Account, CanonicalTxn } from './types.ts';
import type { Store } from './store.ts';

export class SqliteStore implements Store {
  private db: SQLite.SQLiteDatabase | null = null;

  async open(): Promise<void> {
    if (this.db) return;
    this.db = await SQLite.openDatabaseAsync('track.db');
    await this.db.execAsync(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS txns (
        id TEXT PRIMARY KEY NOT NULL,
        data TEXT NOT NULL,
        occurred_ms INTEGER NOT NULL,
        month TEXT NOT NULL,
        merchant TEXT NOT NULL DEFAULT '',
        search TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_txns_occurred ON txns(occurred_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_txns_month ON txns(month);
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY NOT NULL, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL);
    `);
  }

  private must(): SQLite.SQLiteDatabase {
    if (!this.db) throw new Error('SqliteStore.open() first');
    return this.db;
  }

  async commit(batch: { upserts?: CanonicalTxn[]; deletes?: string[]; meta?: Record<string, string>; accountsReplace?: Account[] }): Promise<void> {
    const db = this.must();
    await db.withExclusiveTransactionAsync(async (txn) => {
      if (batch.accountsReplace) {
        await txn.runAsync('DELETE FROM accounts');
        for (const a of batch.accountsReplace) {
          await txn.runAsync('INSERT INTO accounts (id, data) VALUES (?,?)', a.id, JSON.stringify(a));
        }
      }
      for (const t of batch.upserts ?? []) {
        await txn.runAsync(
          'INSERT OR REPLACE INTO txns (id, data, occurred_ms, month, merchant, search) VALUES (?,?,?,?,?,?)',
          t.id,
          JSON.stringify(t),
          t.occurredAtMs,
          monthKeyOf(t.occurredAtMs),
          t.merchant,
          t.merchant.toLocaleLowerCase(),
        );
      }
      for (const id of batch.deletes ?? []) {
        await txn.runAsync('DELETE FROM txns WHERE id = ?', id);
      }
      for (const [k, v] of Object.entries(batch.meta ?? {})) {
        await txn.runAsync('INSERT OR REPLACE INTO meta (k, v) VALUES (?,?)', k, v);
      }
    });
  }

  async allTxns(): Promise<CanonicalTxn[]> {
    const rows = await this.must().getAllAsync<{ data: string }>('SELECT data FROM txns ORDER BY occurred_ms DESC, id ASC');
    return rows.map((r) => JSON.parse(r.data));
  }

  async txnById(id: string): Promise<CanonicalTxn | null> {
    const row = await this.must().getFirstAsync<{ data: string }>('SELECT data FROM txns WHERE id = ?', id);
    return row ? JSON.parse(row.data) : null;
  }

  async txnsByIds(ids: string[]): Promise<Map<string, CanonicalTxn>> {
    const out = new Map<string, CanonicalTxn>();
    if (ids.length === 0) return out;
    const db = this.must();
    // chunked IN() to stay under SQLite variable limits
    for (let i = 0; i < ids.length; i += 200) {
      const part = ids.slice(i, i + 200);
      const rows = await db.getAllAsync<{ id: string; data: string }>(
        `SELECT id, data FROM txns WHERE id IN (${part.map(() => '?').join(',')})`,
        ...part,
      );
      for (const r of rows) out.set(r.id, JSON.parse(r.data));
    }
    return out;
  }

  async count(): Promise<number> {
    const row = await this.must().getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM txns');
    return row?.n ?? 0;
  }

  async getMeta(key: string): Promise<string | null> {
    const row = await this.must().getFirstAsync<{ v: string }>('SELECT v FROM meta WHERE k = ?', key);
    return row?.v ?? null;
  }

  async putAccounts(accounts: Account[]): Promise<void> {
    const db = this.must();
    await db.withExclusiveTransactionAsync(async (txn) => {
      for (const a of accounts) {
        await txn.runAsync('INSERT OR REPLACE INTO accounts (id, data) VALUES (?,?)', a.id, JSON.stringify(a));
      }
    });
  }

  async allAccounts(): Promise<Account[]> {
    const rows = await this.must().getAllAsync<{ data: string }>('SELECT data FROM accounts');
    return rows.map((r) => JSON.parse(r.data));
  }

  async searchByMerchant(query: string, limit = 200): Promise<CanonicalTxn[]> {
    const rows = await this.must().getAllAsync<{ data: string }>(
      'SELECT data FROM txns WHERE search LIKE ? ORDER BY occurred_ms DESC LIMIT ?',
      `%${query.toLocaleLowerCase()}%`,
      limit,
    );
    return rows.map((r) => JSON.parse(r.data));
  }

  async clearSyncState(): Promise<void> {
    await this.must().runAsync("DELETE FROM meta WHERE k IN ('sync_token','full_sync_cursor','full_sync_seen','last_sync_error')");
  }
}

// local duplicate of monthKeyIST to keep this file free of UI deps
function monthKeyOf(ms: number): string {
  const d = new Date(ms + (5 * 60 + 30) * 60 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
