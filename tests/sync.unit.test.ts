import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, META } from '../src/core/store.ts';
import { SyncEngine } from '../src/core/sync.ts';
import { newerOf, normalizeRecord } from '../src/core/normalize.ts';
import { ApiError } from '../src/core/types.ts';
import { validateServerUrl } from '../src/core/api.ts';

const rec = (id: string, minor: number, status: string, updated: string) => ({
  id, account_id: 'acc_1', occurred_at: '2026-10-10T10:08:00Z', direction: 'debit',
  amount_minor: minor, currency: 'INR', merchant: 'UPI/CHAI POINT', category: 'FOOD',
  status, updated_at: updated,
});

// Mirror of the real fixture trap: the changes feed hands us the STALE version
// AFTER the fresh one.
test('stale changes-feed entry never overwrites a newer stored version', async () => {
  const store = new MemoryStore();
  const stale = normalizeRecord(rec('t1', 3900, 'PENDING', '2026-10-10T19:23:33Z'));
  const fresh = normalizeRecord(rec('t1', 8900, 'POSTED', '2026-10-10T19:53:33Z'));
  assert.equal(newerOf(stale, fresh), fresh);
  assert.equal(newerOf(fresh, stale), fresh);
});

function mockClient(pages: any[]) {
  let i = 0;
  return {
    baseUrl: 'http://mock',
    fetchImpl: (async (url: string) => {
      const u = String(url);
      let body: any;
      if (u.includes('/v1/accounts')) body = { items: [] };
      else if (u.includes('/v1/transactions/changes')) body = pages[Math.min(i++, pages.length - 1)];
      else body = { items: [], next_cursor: null, sync_token: 'st_full' };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch,
    sleep: () => Promise.resolve(),
  };
}

test('incremental sync keeps newer updated_at when feed order lies', async () => {
  const store = new MemoryStore();
  store.txns.set('t1', normalizeRecord(rec('t1', 8900, 'POSTED', '2026-10-10T19:53:33Z')));
  await store.commit({ meta: { sync_token: 'st_x' } });
  const engine = new SyncEngine(store, mockClient([
    { items: [rec('t1', 3900, 'PENDING', '2026-10-10T19:23:33Z')], next_cursor: null, sync_token: 'st_y' },
  ]));
  const r = await engine.sync();
  assert.equal(r.ok, true);
  const t = await store.txnById('t1');
  assert.equal(t?.amountMinor, 8900);
  assert.equal(t?.status, 'POSTED');
});

test('410 on changes clears token and runs full sync', async () => {
  const store = new MemoryStore();
  await store.commit({ meta: { sync_token: 'st_old' } });
  let changesCalls = 0;
  const engine = new SyncEngine(store, {
    baseUrl: 'http://mock',
    fetchImpl: (async (url: string) => {
      const u = String(url);
      if (u.includes('/v1/accounts')) return new Response('{"items":[]}');
      if (u.includes('/v1/transactions/changes')) {
        changesCalls++;
        return new Response('{"error":"sync_token_expired"}', { status: 410 });
      }
      return new Response(JSON.stringify({ items: [rec('t9', 100, 'POSTED', '2026-10-10T00:00:00Z')], next_cursor: null, sync_token: 'st_new' }));
    }) as typeof fetch,
    sleep: () => Promise.resolve(),
  });
  const r = await engine.sync();
  assert.equal(r.ok, true);
  assert.equal(changesCalls, 1);
  assert.equal(await store.count(), 1);
  assert.equal(await store.getMeta('sync_token'), 'st_new');
});

// --- Review follow-ups: backend switch, error bounds, URL validation ---

test('a different backend that rejects our token asks before changing anything', async () => {
  const store = new MemoryStore();
  const okList = (items: any[]) => (u: string) => ({
    body: u.includes('/v1/accounts')
      ? { items: [] }
      : u.includes('/v1/transactions/changes')
        ? { items: [], next_cursor: null, sync_token: 'st_a' }
        : { items, next_cursor: null, sync_token: 'st_a' },
    status: 200,
  });
  const fetchOf = (handler: (u: string) => { body: any; status: number }) =>
    (async (url: string) => {
      const r = handler(String(url));
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

  const engineA = new SyncEngine(store, {
    baseUrl: 'http://server-a',
    fetchImpl: fetchOf(okList([rec('from_server_a', 100, 'POSTED', '2026-10-10T19:53:33Z')])),
    sleep: () => Promise.resolve(),
  });
  assert.equal((await engineA.sync()).ok, true);
  assert.equal(await store.count(), 1);

  // Same data behind a NEW URL (tunnel rotation): token still valid -> just continues.
  const engineB2 = new SyncEngine(store, {
    baseUrl: 'https://rotated-tunnel.example.com',
    fetchImpl: fetchOf(okList([rec('from_server_a', 100, 'POSTED', '2026-10-10T19:53:33Z')])),
    sleep: () => Promise.resolve(),
  });
  const rotated = await engineB2.sync();
  assert.equal(rotated.ok, true, 'same backend behind a new URL continues');
  assert.equal(rotated.needsServerSwitchConfirm, undefined);
  assert.notEqual(await store.txnById('from_server_a'), null, 'no wipe on rotation');

  // A genuinely different backend: our token is rejected with 410.
  const engineB = new SyncEngine(store, {
    baseUrl: 'http://server-b',
    fetchImpl: (async (url: string) => {
      const u = String(url);
      if (u.includes('/v1/accounts')) return new Response('{"items":[]}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response('{"error":"sync_token_expired"}', { status: 410, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch,
    sleep: () => Promise.resolve(),
  });
  const r = await engineB.sync();
  assert.equal(r.ok, false);
  assert.equal(r.needsServerSwitchConfirm?.previousUrl, 'https://rotated-tunnel.example.com', 'asks, naming the previous backend');
  assert.equal(await store.count(), 1, 'nothing deleted while asking');
  assert.notEqual(await store.txnById('from_server_a'), null);
  assert.equal(await store.getMeta(META.syncToken), 'st_a', 'sync state kept so dismissing restores full function');
});

test('a confirmed switch replaces history only after the new download succeeds', async () => {
  const store = new MemoryStore();
  const engineA = new SyncEngine(store, {
    baseUrl: 'http://server-a',
    fetchImpl: (async (url: string) => {
      const u = String(url);
      const body = u.includes('/v1/accounts')
        ? { items: [{ id: 'acct_a' }] }
        : { items: [rec('from_server_a', 100, 'POSTED', '2026-10-10T19:53:33Z')], next_cursor: null, sync_token: 'st_a' };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch,
    sleep: () => Promise.resolve(),
  });
  assert.equal((await engineA.sync()).ok, true);

  const engineB = new SyncEngine(store, {
    baseUrl: 'http://server-b',
    fetchImpl: (async (url: string) => {
      const u = String(url);
      const body = u.includes('/v1/accounts')
        ? { items: [{ id: 'acct_b' }] }
        : { items: [rec('from_server_b', 200, 'POSTED', '2026-10-10T19:53:33Z'), rec('b_second', 300, 'POSTED', '2026-10-10T19:54:33Z')], next_cursor: null, sync_token: 'st_b' };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch,
    sleep: () => Promise.resolve(),
  });
  const r = await engineB.replaceWithServer();
  assert.equal(r.ok, true);
  assert.equal(await store.count(), 2, 'only server B rows remain');
  assert.equal(await store.txnById('from_server_a'), null, 'old history dropped AFTER success');
  assert.deepEqual((await store.allAccounts()).map((x) => x.id), ['acct_b'], 'accounts replaced too');
  assert.equal(await store.getMeta(META.dataSourceUrl), 'http://server-b', 'stamp moved');
});

test('a failed replacement preserves the old history completely, no partial new rows', async () => {
  const store = new MemoryStore();
  const engineA = new SyncEngine(store, {
    baseUrl: 'http://server-a',
    fetchImpl: (async (url: string) => {
      const u = String(url);
      const body = u.includes('/v1/accounts')
        ? { items: [] }
        : { items: [rec('from_server_a', 100, 'POSTED', '2026-10-10T19:53:33Z')], next_cursor: null, sync_token: 'st_a' };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch,
    sleep: () => Promise.resolve(),
  });
  assert.equal((await engineA.sync()).ok, true);

  // Page 1 downloads fine (one new row from B), then page 2 dies. A staged
  // replace writes nothing before the final commit, so this mid-download
  // failure must leave zero B rows and the full old history + meta in place.
  const engineDown = new SyncEngine(store, {
    baseUrl: 'http://server-b',
    maxAttempts: 1,
    fetchImpl: (async (url: string) => {
      const u = String(url);
      if (u.includes('/v1/accounts')) return new Response('{"items":[]}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (!u.includes('cursor=')) {
        const body = { items: [rec('b_partial', 200, 'POSTED', '2026-10-10T19:54:33Z')], next_cursor: 'c2', sync_token: 'st_b1' };
        return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('{"error":"internal_error"}', { status: 500, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch,
    sleep: () => Promise.resolve(),
  });
  const r = await engineDown.replaceWithServer();
  assert.equal(r.ok, false);
  assert.equal(await store.count(), 1, 'old history untouched by the failed replacement');
  assert.equal(await store.txnById('b_partial'), null, 'no partial new rows committed on failure');
  assert.notEqual(await store.txnById('from_server_a'), null);
  assert.equal(await store.getMeta(META.dataSourceUrl), 'http://server-a', 'stamp NOT moved on failure');
  assert.equal(await store.getMeta(META.syncToken), 'st_a', 'old sync token kept on failure');
});

test('same-backend 410 recovery is staged: a failure mid-recovery changes nothing', async () => {
  const store = new MemoryStore();
  const mk = (baseUrl: string, fetchImpl: typeof fetch) => new SyncEngine(store, { baseUrl, maxAttempts: 1, fetchImpl, sleep: () => Promise.resolve() });
  const okPage = { items: [rec('orig_row', 100, 'POSTED', '2026-10-10T19:53:33Z')], next_cursor: null, sync_token: 'st_1' };
  const e1 = mk('http://server-a', (async () => new Response(JSON.stringify({ ...okPage }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch);
  assert.equal((await e1.sync()).ok, true);

  // changes() 410s (expired token), then the re-download page 1 ok, page 2 dies.
  const e2 = mk('http://server-a', (async (url: string) => {
    const u = String(url);
    if (u.includes('/v1/accounts')) return new Response('{"items":[]}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (u.includes('/v1/transactions/changes')) return new Response('{"error":"sync_token_expired"}', { status: 410, headers: { 'Content-Type': 'application/json' } });
    if (!u.includes('cursor=')) {
      const body = { items: [rec('orig_row', 100, 'POSTED', '2026-10-10T19:53:33Z'), rec('new_row', 200, 'POSTED', '2026-10-10T19:54:33Z')], next_cursor: 'c2', sync_token: 'st_2a' };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('{"error":"internal_error"}', { status: 500, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch);
  const r = await e2.sync();
  assert.equal(r.ok, false, 'recovery failed (page 2 died)');
  assert.equal(await store.count(), 1, 'staged recovery wrote nothing before failing');
  assert.equal(await store.txnById('new_row'), null, 'no partial recovery rows committed');
  assert.notEqual(await store.txnById('orig_row'), null);
  assert.equal(await store.getMeta(META.syncToken), 'st_1', 'old token kept after failed recovery');
});

test('pre-stamp history (source never recorded) is asked about, never silently adopted', async () => {
  // Simulates an install whose rows predate the data-source stamp: rows and
  // a sync token exist, but no data_source_url was ever recorded.
  const store = new MemoryStore();
  await store.commit({
    upserts: [normalizeRecord(rec('legacy_row', 100, 'POSTED', '2026-10-10T19:53:33Z'))],
    meta: { [META.syncToken]: 'st_legacy' },
  });
  const engine = new SyncEngine(store, {
    baseUrl: 'http://some-server',
    maxAttempts: 1,
    fetchImpl: (async (url: string) => {
      const u = String(url);
      if (u.includes('/v1/accounts')) return new Response('{"items":[]}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response('{"error":"sync_token_expired"}', { status: 410, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch,
    sleep: () => Promise.resolve(),
  });
  const r = await engine.sync();
  assert.equal(r.ok, false);
  assert.equal(r.needsServerSwitchConfirm?.previousUrl, null, 'asks, with the source named as unrecorded');
  assert.equal(await store.count(), 1, 'nothing re-downloaded or deleted while asking');
  assert.notEqual(await store.txnById('legacy_row'), null);
  assert.equal(await store.getMeta(META.syncToken), 'st_legacy', 'sync state kept so dismissing restores full function');
});

test('an empty pre-stamp store still recovers automatically (nothing to lose)', async () => {
  const store = new MemoryStore();
  await store.commit({ meta: { [META.syncToken]: 'st_old' } });
  const engine = new SyncEngine(store, {
    baseUrl: 'http://some-server',
    maxAttempts: 1,
    fetchImpl: (async (url: string) => {
      const u = String(url);
      const body = u.includes('/v1/accounts')
        ? { items: [] }
        : u.includes('/v1/transactions/changes')
          ? null
          : { items: [rec('fresh_row', 100, 'POSTED', '2026-10-10T19:53:33Z')], next_cursor: null, sync_token: 'st_new' };
      if (body === null) return new Response('{"error":"sync_token_expired"}', { status: 410, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch,
    sleep: () => Promise.resolve(),
  });
  const r = await engine.sync();
  assert.equal(r.ok, true, '410 recovery runs without asking when no history exists');
  assert.equal(r.needsServerSwitchConfirm, undefined);
  assert.notEqual(await store.txnById('fresh_row'), null);
});

test('a network-level failure reads as guidance, not a raw fetch error', async () => {
  const store = new MemoryStore();
  const engine = new SyncEngine(store, {
    baseUrl: 'http://unreachable-host:4010',
    maxAttempts: 1,
    fetchImpl: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch,
    sleep: () => Promise.resolve(),
  });
  const r = await engine.sync();
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /Can't reach the server at http:\/\/unreachable-host:4010/);
  assert.match(r.error ?? '', /Check the URL in Server settings/);
  assert.equal(await store.getMeta(META.lastSyncError), r.error, 'same guidance persisted for the UI');
});







test('Expo native FetchError (not a TypeError) also maps to guidance', async () => {
  // expo/src/winter/fetch/FetchErrors.ts: class FetchError extends Error with
  // message "fetch failed: <native cause>" - this is what Android actually
  // throws for DNS/refused/offline, and it must not leak raw to the UI.
  const store = new MemoryStore();
  const engine = new SyncEngine(store, {
    baseUrl: 'https://dead-host.invalid',
    maxAttempts: 1,
    fetchImpl: (async () => { throw new Error('fetch failed: java.net.UnknownHostException: Unable to resolve host "dead-host.invalid"'); }) as typeof fetch,
    sleep: () => Promise.resolve(),
  });
  const r = await engine.sync();
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /Can't reach the server at https:\/\/dead-host\.invalid/);
  assert.doesNotMatch(r.error ?? '', /UnknownHostException/);
});

test('an HTTP 530 with an empty edge body reads as guidance, not "API 530: null"', async () => {
  // A dead reverse proxy (e.g. an expired tunnel edge) returns 5xx with no
  // JSON body at all. The user must get actionable words, and no raw null.
  const store = new MemoryStore();
  const engine = new SyncEngine(store, {
    baseUrl: 'https://dead-tunnel.example.com',
    maxAttempts: 1,
    fetchImpl: (async () => new Response('', { status: 530 })) as typeof fetch,
    sleep: () => Promise.resolve(),
  });
  const r = await engine.sync();
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /having trouble right now \(HTTP 530\)/);
  assert.doesNotMatch(r.error ?? '', /API 530|null/);
  assert.doesNotMatch(r.error ?? '', /Nothing on this phone was changed/, 'no data-state claim the code does not guarantee');
  assert.equal(await store.getMeta(META.lastSyncError), r.error, 'same guidance persisted for the UI');
});

test('an HTTP 404 with no body points at the URL setting', async () => {
  const store = new MemoryStore();
  const engine = new SyncEngine(store, {
    baseUrl: 'https://wrong-path.example.com',
    maxAttempts: 1,
    fetchImpl: (async () => new Response('not here', { status: 404 })) as typeof fetch,
    sleep: () => Promise.resolve(),
  });
  const r = await engine.sync();
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /\(HTTP 404\)/);
  assert.match(r.error ?? '', /Check the URL in Server settings/);
  assert.doesNotMatch(r.error ?? '', /API 404|null/);
});

test('a real server error body is still shown, bounded, not replaced by guidance', async () => {
  const store = new MemoryStore();
  const engine = new SyncEngine(store, {
    baseUrl: 'https://honest-server.example.com',
    maxAttempts: 1,
    fetchImpl: (async () => new Response(JSON.stringify({ error: 'database on fire' }), { status: 500, headers: { 'Content-Type': 'application/json' } })) as typeof fetch,
    sleep: () => Promise.resolve(),
  });
  const r = await engine.sync();
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /database on fire/);
});

test('a cosmetic URL edit (trailing slash) does NOT wipe local data', async () => {
  const store = new MemoryStore();
  const mk = (baseUrl: string) => new SyncEngine(store, {
    baseUrl,
    fetchImpl: (async (url: string) => {
      const u = String(url);
      const body = u.includes('/v1/accounts')
        ? { items: [] }
        : { items: [rec('keep_me', 100, 'POSTED', '2026-10-10T19:53:33Z')], next_cursor: null, sync_token: 'st_x' };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch,
    sleep: () => Promise.resolve(),
  });
  assert.equal((await mk('http://server-a').sync()).ok, true);
  assert.equal((await mk('http://server-a/').sync()).ok, true);
  assert.notEqual(await store.txnById('keep_me'), null, 'data kept across cosmetic edit');
});

test('legacy install with no data-source stamp is stamped on next successful sync', async () => {
  const store = new MemoryStore();
  const engine = new SyncEngine(store, {
    baseUrl: 'http://server-a',
    fetchImpl: (async (url: string) => {
      const u = String(url);
      const body = u.includes('/v1/accounts')
        ? { items: [] }
        : { items: [], next_cursor: null, sync_token: 'st_a' };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch,
    sleep: () => Promise.resolve(),
  });
  assert.equal(await store.getMeta(META.dataSourceUrl), null);
  assert.equal((await engine.sync()).ok, true);
  assert.equal(await store.getMeta(META.dataSourceUrl), 'http://server-a');
});

test('API error messages bound the server body instead of quoting it whole', async () => {
  const huge = { error: 'x'.repeat(1000) };
  const e = new ApiError(500, huge, null);
  assert.ok(e.message.length < 200, `bounded: ${e.message.length}`);
  assert.match(e.message, /^API 500: /);
});

test('validateServerUrl accepts http/https, rejects the rest honestly', async () => {
  assert.equal(validateServerUrl('https://mock.example.com'), null);
  assert.equal(validateServerUrl('  http://10.0.2.2:4010  '), null, 'trimmed dev URL ok');
  assert.equal(validateServerUrl('http://192.168.1.20:4010'), null, 'LAN dev URL ok');
  assert.match(validateServerUrl('') ?? '', /Enter the server URL/);
  assert.match(validateServerUrl('not a url') ?? '', /not a valid URL/);
  assert.match(validateServerUrl('ftp://x.example.com') ?? '', /http:\/\/ or https:\/\//);
});
