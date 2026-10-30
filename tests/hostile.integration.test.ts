// The server is deliberately hostile: request #6 to /v1/transactions is a 500,
// #11 is a 429 with Retry-After, page #3 takes 4.2s, the FIRST changes call is
// a 503 with Retry-After. The engine must ride through all of it and still
// land exactly on the checkpoint.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, stopServer, FIXTURES } from './helpers.ts';
import { MemoryStore } from '../src/core/store.ts';
import { SyncEngine } from '../src/core/sync.ts';
import { computeMonthTotals } from '../src/core/totals.ts';

const PORT = 4532;
let base: string;
const checkpoint = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'checkpoint.json'), 'utf8'));

before(async () => { base = await startServer(PORT, false); }); // NOT calm
after(() => stopServer());

test('full + incremental sync survives the hostile server and matches checkpoint', { timeout: 120000 }, async (t) => {
  const store = new MemoryStore();
  const waits: string[] = [];
  const engine = new SyncEngine(store, {
    baseUrl: base,
    onWait: (reason) => { waits.push(reason); },
  });
  const r1 = await engine.sync();
  assert.equal(r1.ok, true, String(r1.error));
  const r2 = await engine.sync();
  assert.equal(r2.ok, true, String(r2.error));
  const rows = await store.allTxns();
  assert.equal(rows.length, checkpoint.transaction_count);
  const byKey = new Map(computeMonthTotals(rows).map((m) => [m.month, m]));
  for (const [month, want] of Object.entries(checkpoint.months) as any) {
    const got = byKey.get(month)!;
    assert.equal(got.spendMinor, Math.round(parseFloat(want.spend) * 100), `${month} spend`);
    assert.equal(got.incomeMinor, Math.round(parseFloat(want.income) * 100), `${month} income`);
  }
  assert.ok(waits.some((w) => w.includes('500') || w.includes('429')), 'should have ridden through injected failures');
  t.diagnostic(`retry waits seen: ${JSON.stringify(waits)}`);
});
