// Regression tests for the security-hardening pass: a hostile or simply
// surprising counterparty must not poison, loop, or park the sync, and a
// skipped record must stay visible.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/core/store.ts';
import { SyncEngine } from '../src/core/sync.ts';
import { META } from '../src/core/store.ts';
import { normalizeRecord, UnnormalizableRecord, decimalStringToMinor } from '../src/core/normalize.ts';
import { ServerDeferral } from '../src/core/types.ts';

const rec = (id: string) => ({
  id, account_id: 'acc_1', occurred_at: '2026-10-10T10:08:00Z', direction: 'debit',
  amount_minor: 34900, currency: 'INR', merchant: 'SWIGGY*BANGALORE', category: 'FOOD',
  status: 'POSTED', updated_at: '2026-10-10T10:51:00Z',
});
const jsonRes = (body: any, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

function engineWith(fetchImpl: (url: any) => Promise<Response>, sleeps?: number[]) {
  const store = new MemoryStore();
  const engine = new SyncEngine(store, {
    baseUrl: 'http://stub',
    fetchImpl: fetchImpl as any,
    sleep: (ms: number) => { sleeps?.push(ms); return Promise.resolve(); },
  });
  return { store, engine };
}

test('one malformed record does not stop the page, the pipeline, or the retry', async () => {
  // page 1: good + poison (amount_minor a string); page 2: clean, done
  let calls = 0;
  const pages = [
    { items: [rec('txn_ok1'), { ...rec('txn_bad1'), amount_minor: '349.00' }], next_cursor: 'c2', sync_token: 'st_x' },
    { items: [rec('txn_ok2')], next_cursor: null, sync_token: 'st_y' },
  ];
  const { store, engine } = engineWith(async (url: any) => {
    const u = String(url);
    if (u.includes('/v1/accounts')) return jsonRes({ items: [] });
    return jsonRes(pages[Math.min(calls++, pages.length - 1)]);
  });
  const r1 = await engine.sync();
  assert.equal(r1.ok, true, `sync should complete: ${r1.error}`);
  assert.equal(await store.count(), 2, 'good rows commit');
  const q = JSON.parse((await store.getMeta(META.quarantined)) ?? '[]');
  assert.equal(q.length, 1);
  assert.equal(q[0].id, 'txn_bad1');
  assert.match(q[0].reason, /amount_minor/);
  assert.equal(await store.getMeta(META.quarantinedCount), '1');
});

test('malformed record in the changes feed is quarantined, sync still completes', async () => {
  let listDone = false;
  const { store, engine } = engineWith(async (url: any) => {
    const u = String(url);
    if (u.includes('/v1/accounts')) return jsonRes({ items: [] });
    if (!listDone) {
      listDone = true;
      return jsonRes({ items: [rec('txn_ok1')], next_cursor: null, sync_token: 'st_1' });
    }
    return jsonRes({ items: [{ ...rec('txn_bad2'), amount_minor: null }, rec('txn_ok3')], next_cursor: null, sync_token: 'st_2' });
  });
  await engine.sync(); // full
  const r2 = await engine.sync(); // incremental
  assert.equal(r2.ok, true, `incremental should complete: ${r2.error}`);
  assert.equal(await store.count(), 2);
  const q = JSON.parse((await store.getMeta(META.quarantined)) ?? '[]');
  assert.ok(q.some((x: any) => x.id === 'txn_bad2'));
});

test('a server that always returns next_cursor is bounded, committed pages kept', async () => {
  const page = { items: [rec('txn_a')], next_cursor: 'c_next', sync_token: 'st' };
  const { store, engine } = engineWith(async (url: any) => {
    if (String(url).includes('/v1/accounts')) return jsonRes({ items: [] });
    return jsonRes({ ...page, next_cursor: 'c' + Math.random() });
  });
  const r = await engine.sync();
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /500 pages/);
  assert.ok((await store.count()) > 0, 'committed pages survive the abort');
});

test('a non-advancing cursor fails fast instead of looping', async () => {
  const page = { items: [rec('txn_a')], next_cursor: 'SAME', sync_token: 'st' };
  let calls = 0;
  const { engine } = engineWith(async (url: any) => {
    if (String(url).includes('/v1/accounts')) return jsonRes({ items: [] });
    calls++;
    return jsonRes(page); // cursor=SAME twice: second fetch sees non-advancing
  });
  const r = await engine.sync();
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /non-advancing cursor/);
  assert.ok(calls <= 3, `should fail fast, got ${calls} fetches`);
});

test('a huge Retry-After defers honestly; it is never clamped into an early retry', async () => {
  const sleeps: number[] = [];
  const { engine } = engineWith(async (url: any) => {
    if (String(url).includes('/v1/accounts')) return jsonRes({ items: [] });
    return jsonRes({ error: 'busy' }, 429, { 'Retry-After': '100000' });
  }, sleeps);
  const r = await engine.sync();
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /paused until/);
  assert.deepEqual(sleeps, [], 'no early retry may be slept');
});

test("the mock's real 2-3s Retry-After values pass through unchanged", async () => {
  const sleeps: number[] = [];
  let calls = 0;
  const { engine } = engineWith(async (url: any) => {
    const u = String(url);
    if (u.includes('/v1/accounts')) return jsonRes({ items: [] });
    if (calls++ === 0) return jsonRes({ error: 'busy' }, 429, { 'Retry-After': '2' });
    return jsonRes({ items: [], next_cursor: null, sync_token: 'st' });
  }, sleeps);
  const r = await engine.sync();
  assert.equal(r.ok, true);
  assert.deepEqual(sleeps, [2000]);
});

test('ServerDeferral carries the eligible retry time', () => {
  const d = new ServerDeferral(100000);
  assert.ok(d.retryNotBefore > new Date().toISOString());
  assert.match(d.message, /paused until/);
});

test('legacy txn_time outside a plausible range is rejected (quarantinable)', () => {
  assert.throws(
    () => normalizeRecord({ id: 'l1', txn_time: Infinity, amount: '1.00', type: 'DR' }),
    UnnormalizableRecord,
  );
  assert.throws(
    () => normalizeRecord({ id: 'l2', txn_time: -5, amount: '1.00', type: 'DR' }),
    UnnormalizableRecord,
  );
});

test('amounts beyond exact minor-unit range are rejected, never silently inexact', () => {
  assert.throws(() => decimalStringToMinor('99999999999999.99'), /exact minor-unit range/);
  assert.equal(decimalStringToMinor('516.49'), 51649);
});

test('legacy amount parse failures normalize as quarantinable validation errors', () => {
  assert.throws(
    () => normalizeRecord({ id: 'l3', txn_time: 1760000000, amount: 'abc', type: 'DR' }),
    UnnormalizableRecord,
  );
});

test('D1: follow-up incremental sync merges quarantine, clears only on resolve/delete', async () => {
  // Full sync quarantines txn_bad1. An incremental pass that skips nothing
  // must keep the warning; a later change that fixes the record clears it;
  // a tombstone clears it too.
  let phase = 0;
  const { store, engine } = engineWith(async (url: any) => {
    const u = String(url);
    if (u.includes('/v1/accounts')) return jsonRes({ items: [] });
    if (phase === 0) return jsonRes({ items: [rec('txn_ok1'), { ...rec('txn_bad1'), amount_minor: 'oops' }], next_cursor: null, sync_token: 'st_1' });
    if (phase === 1) return jsonRes({ items: [], next_cursor: null, sync_token: 'st_2' }); // nothing new
    if (phase === 2) return jsonRes({ items: [rec('txn_bad1')], next_cursor: null, sync_token: 'st_3' }); // server fixed it
    return jsonRes({ items: [{ id: 'txn_bad1', deleted: true }], next_cursor: null, sync_token: 'st_4' });
  });
  await engine.sync(); // full: quarantines txn_bad1
  assert.equal(await store.getMeta(META.quarantinedCount), '1');
  await engine.sync(); // incremental with no items: warning must survive
  assert.equal(await store.getMeta(META.quarantinedCount), '1', 'empty incremental must not erase the quarantine');
  phase = 1; await engine.sync(); phase = 2;
  await engine.sync(); // server sends a readable version: entry resolves
  assert.equal(await store.getMeta(META.quarantinedCount), '0', 'a record that now normalizes clears its warning');
  // quarantine again, then tombstone it
  phase = 2; // will return readable... force re-quarantine via a bad change:
  const { store: store2, engine: engine2 } = engineWith(async (url: any) => {
    const u = String(url);
    if (u.includes('/v1/accounts')) return jsonRes({ items: [] });
    if (!store2.meta.get(META.syncToken)) return jsonRes({ items: [{ ...rec('txn_b1'), amount_minor: 'bad' }], next_cursor: null, sync_token: 'st_a' });
    return jsonRes({ items: [{ id: 'txn_b1', deleted: true }], next_cursor: null, sync_token: 'st_b' });
  });
  await engine2.sync();
  assert.equal(await store2.getMeta(META.quarantinedCount), '1');
  await engine2.sync(); // tombstone for txn_b1
  assert.equal(await store2.getMeta(META.quarantinedCount), '0', 'a tombstoned record clears its warning');
});

test('D2: skipped count stays exact beyond the persisted example cap', async () => {
  const bad = Array.from({ length: 150 }, (_, i) => ({ ...rec('txn_bad_' + i), amount_minor: 'bad' }));
  const { store, engine } = engineWith(async (url: any) => {
    if (String(url).includes('/v1/accounts')) return jsonRes({ items: [] });
    return jsonRes({ items: bad, next_cursor: null, sync_token: 'st_1' });
  });
  await engine.sync();
  assert.equal(await store.getMeta(META.quarantinedCount), '150', 'exact unique unresolved count');
  const examples = JSON.parse((await store.getMeta(META.quarantined)) ?? '[]');
  assert.ok(examples.length <= 100, 'examples stay bounded');
});

test('D3: server deferral persists and gates every later sync until its own time', async () => {
  let fetches = 0;
  const store = new MemoryStore();
  const mk = () => new SyncEngine(store, {
    baseUrl: 'http://stub',
    fetchImpl: (async () => { fetches++; return jsonRes({ error: 'busy' }, 429, { 'Retry-After': '100000' }); }) as any,
    sleep: () => Promise.resolve(),
  });
  const r1 = await mk().sync();
  assert.equal(r1.ok, false);
  assert.ok(r1.deferredUntil, 'deferral surfaced');
  assert.equal(await store.getMeta(META.nextSyncNotBefore), r1.deferredUntil, 'deferral persisted');
  // A brand-new engine instance (app restart) must not fetch at all.
  const r2 = await mk().sync();
  assert.equal(r2.ok, false);
  assert.ok(r2.deferredUntil);
  assert.equal(fetches, 1, 'gated syncs make no requests');
  // A different backend URL is not bound by this server's deferral.
  const other = new SyncEngine(store, {
    baseUrl: 'http://other',
    fetchImpl: (async (url: any) => {
      const u = String(url);
      if (u.includes('/v1/accounts')) return jsonRes({ items: [] });
      return jsonRes({ items: [rec('txn_o1')], next_cursor: null, sync_token: 'st_o' });
    }) as any,
    sleep: () => Promise.resolve(),
  });
  const r3 = await other.sync();
  assert.equal(r3.ok, true, 'deferral is scoped to the backend that issued it');
  // Once the time has passed, syncing resumes against the original backend.
  await store.commit({ meta: { [META.nextSyncNotBefore]: new Date(Date.now() - 1000).toISOString(), [META.nextSyncNotBeforeUrl]: 'http://stub' } });
  const r4 = await mk().sync();
  assert.ok(fetches >= 2, 'sync resumes after the wait');
});

test('quarantine overflow flags the count as an upper bound until a full resync reconciles', async () => {
  // 1050 unreadable records overflow the tracked id set (cap 1000): adds stay
  // exact, but resolves of untracked ids are invisible, so the count is an
  // upper bound and must be flagged as such - never shown as exact.
  const bad = Array.from({ length: 1050 }, (_, i) => ({ ...rec('txn_ov_' + i), amount_minor: 'bad' }));
  let phase = 0;
  const { store, engine } = engineWith(async (url: any) => {
    const u = String(url);
    if (u.includes('/v1/accounts')) return jsonRes({ items: [] });
    if (u.includes('/v1/transactions/changes')) {
      if (phase === 1) {
        // server fixes 50 records whose ids were NOT tracked (beyond the cap)
        return jsonRes({ items: bad.slice(1000).map((b) => rec(b.id)), next_cursor: null, sync_token: 'st_2' });
      }
      return jsonRes({ error: 'gone' }, 410); // token expired -> full resync
    }
    // full-sync list: all bad first, all fixed after the resync trigger
    return jsonRes({ items: phase === 2 ? bad.map((b) => rec(b.id)) : bad, next_cursor: null, sync_token: 'st_1' });
  });
  await engine.sync();
  assert.equal(await store.getMeta(META.quarantinedCount), '1050');
  assert.equal(await store.getMeta(META.quarantinedTruncated), '1', 'overflow flagged');
  phase = 1;
  await engine.sync(); // 50 untracked resolves are invisible
  assert.equal(await store.getMeta(META.quarantinedCount), '1050', 'conservative: never understates');
  assert.equal(await store.getMeta(META.quarantinedTruncated), '1');
  phase = 2;
  const r = await engine.sync(); // 410 on changes -> full resync, server now sends readable records
  assert.equal(r.ok, true, `resync completes: ${r.error}`);
  assert.equal(await store.getMeta(META.quarantinedCount), '0', 'full resync rebuilds exactly');
  assert.notEqual(await store.getMeta(META.quarantinedTruncated), '1', 'upper-bound flag cleared');
});
