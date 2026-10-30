// npm run verify -- syncs against the running mock server and checks the app's
// month totals + count against the assignment's checkpoint.json. This is a
// development tool, not app code: the checkpoint is the assignment's oracle.
//
// Usage: node ../track-api-mock/server.js   (in one shell)
//        npm run verify                     (in another)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryStore } from '../src/core/store.ts';
import { SyncEngine } from '../src/core/sync.ts';
import { computeMonthTotals } from '../src/core/totals.ts';
import { formatINR } from '../src/core/money.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const checkpointPath = process.argv[2] ?? path.resolve(HERE, '../../track-api-mock/fixtures/checkpoint.json');
const baseUrl = process.env.TRACK_API ?? 'http://127.0.0.1:4010';
const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));

const store = new MemoryStore();
const engine = new SyncEngine(store, { baseUrl, onWait: (r) => console.log(`  (server pushed back: ${r})`) });
console.log(`Syncing from ${baseUrl} ...`);
let r = await engine.sync();
if (!r.ok) { console.error(`full sync failed: ${r.error}`); process.exit(1); }
r = await engine.sync();
if (!r.ok) { console.error(`incremental sync failed: ${r.error}`); process.exit(1); }

const rows = await store.allTxns();
const ids = new Set(rows.map((t) => t.id));
let failures = 0;

console.log(`\nTransactions: ${rows.length} (checkpoint: ${checkpoint.transaction_count})`);
if (rows.length !== checkpoint.transaction_count) failures++;
if (ids.size !== rows.length) { console.error('DUPLICATE IDS PRESENT'); failures++; }

const byKey = new Map(computeMonthTotals(rows).map((m) => [m.month, m]));
console.log('\nMonth     | Spend (app)      | Spend (checkpoint) | Income (app)     | Income (checkpoint)');
for (const [month, want] of Object.entries(checkpoint.months) as any) {
  const got = byKey.get(month);
  const ws = Math.round(parseFloat(want.spend) * 100);
  const wi = Math.round(parseFloat(want.income) * 100);
  const okS = got?.spendMinor === ws;
  const okI = got?.incomeMinor === wi;
  if (!okS || !okI) failures++;
  console.log(
    `${month}    | ${formatINR(got?.spendMinor ?? -1).padEnd(16)} | ${formatINR(ws).padEnd(18)} ${okS ? ' ' : '<- MISMATCH'} | ${formatINR(got?.incomeMinor ?? -1).padEnd(16)} | ${formatINR(wi).padEnd(18)} ${okI ? '' : '<- MISMATCH'}`,
  );
}
console.log(failures === 0 ? '\nPASS: totals match the checkpoint exactly.' : `\nFAIL: ${failures} mismatch(es).`);
process.exit(failures === 0 ? 0 : 1);
