// Integration tests run against the REAL mock server (fixtures dir is read at
// runtime, never hardcoded). checkpoint.json is the assignment's own oracle:
// "Use it to check your own numbers."
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, stopServer, FIXTURES } from './helpers.ts';
import { MemoryStore } from '../src/core/store.ts';
import { SyncEngine } from '../src/core/sync.ts';
import { computeMonthTotals } from '../src/core/totals.ts';

const PORT = 4531;
let base: string;
const checkpoint = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'checkpoint.json'), 'utf8'));

function assertTotalsMatchCheckpoint(storeRows: any[]) {
  const months = computeMonthTotals(storeRows);
  const byKey = new Map(months.map((m) => [m.month, m]));
  for (const [month, want] of Object.entries(checkpoint.months) as any) {
    const got = byKey.get(month);
    assert.ok(got, `month ${month} missing from computed totals`);
    assert.equal(got.spendMinor, Math.round(parseFloat(want.spend) * 100), `${month} spend`);
    assert.equal(got.incomeMinor, Math.round(parseFloat(want.income) * 100), `${month} income`);
  }
}

before(async () => { base = await startServer(PORT, true); });
after(() => stopServer());

test('full + incremental sync reproduces the checkpoint exactly', async () => {
  const store = new MemoryStore();
  const engine = new SyncEngine(store, { baseUrl: base });
  const r1 = await engine.sync();
  assert.equal(r1.ok, true, String(r1.error));
  assert.equal(r1.phase, 'full');
  // changes feed still pending -> now run incremental
  const r2 = await engine.sync();
  assert.equal(r2.ok, true, String(r2.error));
  assert.equal(r2.phase, 'incremental');
  const rows = await store.allTxns();
  assert.equal(rows.length, checkpoint.transaction_count);
  const ids = new Set(rows.map((t) => t.id));
  assert.equal(ids.size, rows.length, 'every transaction appears exactly once');
  assertTotalsMatchCheckpoint(rows);
});

test('killed mid-full-sync resumes without duplicates or loss', async () => {
  const store = new MemoryStore();
  let calls = 0;
  const realFetch = fetch;
  // A killed process never recovers - this fetch dies permanently after two
  // successful requests (the accounts call + one page), exhausting retries.
  const killingFetch = (async (url: any, init?: any) => {
    calls++;
    if (calls > 2) throw new Error('process killed (simulated)');
    return realFetch(url, init);
  }) as typeof fetch;

  const engine1 = new SyncEngine(store, { baseUrl: base, fetchImpl: killingFetch, maxAttempts: 2, sleep: () => Promise.resolve() });
  const r1 = await engine1.sync();
  assert.equal(r1.ok, false);
  const partialCount = await store.count();
  assert.ok(partialCount > 0, 'completed pages must survive the kill');

  const engine2 = new SyncEngine(store, { baseUrl: base });
  const r2 = await engine2.sync();
  assert.equal(r2.ok, true, String(r2.error));
  const r3 = await engine2.sync(); // incremental
  assert.equal(r3.ok, true, String(r3.error));
  const rows = await store.allTxns();
  assert.equal(rows.length, checkpoint.transaction_count);
  assertTotalsMatchCheckpoint(rows);
});

test('expired sync token (410) triggers a safe full resync', async () => {
  const store = new MemoryStore();
  await store.commit({ meta: { sync_token: 'st_bogus' } });
  const engine = new SyncEngine(store, { baseUrl: base });
  const r = await engine.sync();
  assert.equal(r.ok, true, String(r.error));
  const rows = await store.allTxns();
  assert.ok(rows.length > 0);
});

test('concurrent syncs do not race', async () => {
  const store = new MemoryStore();
  const engine = new SyncEngine(store, { baseUrl: base });
  const [a, b] = await Promise.all([engine.sync(), engine.sync()]);
  const results = [a, b];
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(results.filter((r) => r.alreadyRunning).length, 1);
});

test('network failure keeps every row the user could already see', async () => {
  const store = new MemoryStore();
  const engine = new SyncEngine(store, { baseUrl: base });
  await engine.sync();
  await engine.sync();
  const before1 = await store.count();

  const offlineFetch = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
  const offline = new SyncEngine(store, { baseUrl: base, fetchImpl: offlineFetch, maxAttempts: 2, sleep: () => Promise.resolve() });
  const r = await offline.sync();
  assert.equal(r.ok, false);
  assert.equal(await store.count(), before1, 'offline failure must not delete stored data');
});
