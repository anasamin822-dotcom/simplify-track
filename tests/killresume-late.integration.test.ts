// Late kill/resume regression: an app killed DEEP into the first full sync
// (here: after ~16 committed pages, with the mock's chaos counters already
// consumed) must resume to a checkpoint-exact state once the server returns.
// Complements sync.integration.test.ts's early-kill case: the resume cursor
// points far into the history, so the resumed run re-fetches most pages and
// re-encounters the boundary re-send many pages in.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, stopServer, FIXTURES } from './helpers.ts';
import { MemoryStore } from '../src/core/store.ts';
import { SyncEngine } from '../src/core/sync.ts';
import { computeMonthTotals } from '../src/core/totals.ts';

const PORT = 4533;
let base: string;
const checkpoint = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'checkpoint.json'), 'utf8'));

before(async () => { base = await startServer(PORT, false); }); // chaos on: 500s/429/503 included
after(() => stopServer());

test('killed deep into the first full sync resumes to the checkpoint exactly', async () => {
  const store = new MemoryStore();
  const realFetch = fetch;
  let calls = 0;
  // Die after the accounts call + 16 page requests (~1.6k rows committed):
  // a killed process never recovers, so this fetch dies permanently.
  const killingFetch = (async (url: any, init?: any) => {
    calls++;
    if (calls > 17) throw new Error('process killed (simulated)');
    return realFetch(url, init);
  }) as typeof fetch;
  const quiet = { maxAttempts: 2, sleep: () => Promise.resolve() };
  const engine1 = new SyncEngine(store, { baseUrl: base, fetchImpl: killingFetch, ...quiet });
  const r1 = await engine1.sync();
  assert.equal(r1.ok, false);
  const partial = await store.count();
  assert.ok(partial > 1000, `expected deep partial state, got ${partial}`);

  // "Restart the app": a new engine has no in-memory dedupe set or lock.
  const engine2 = new SyncEngine(store, { baseUrl: base, ...quiet });
  const r2 = await engine2.sync();
  assert.equal(r2.ok, true, String(r2.error));
  assert.equal(r2.phase, 'full');
  const r3 = await engine2.sync(); // incremental: apply the changes feed
  assert.equal(r3.ok, true, String(r3.error));
  assert.equal(r3.phase, 'incremental');

  const rows = await store.allTxns();
  assert.equal(rows.length, checkpoint.transaction_count);
  assert.equal(new Set(rows.map((t) => t.id)).size, rows.length, 'no duplicated rows after resume');
  const months = computeMonthTotals(rows);
  const byKey = new Map(months.map((m) => [m.month, m]));
  for (const [month, want] of Object.entries(checkpoint.months) as any) {
    const got = byKey.get(month);
    assert.ok(got, `month ${month} missing`);
    assert.equal(got.spendMinor, Math.round(parseFloat(want.spend) * 100), `${month} spend`);
    assert.equal(got.incomeMinor, Math.round(parseFloat(want.income) * 100), `${month} income`);
  }
});
