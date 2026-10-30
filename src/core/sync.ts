// Sync engine. Two phases, both resumable and safe to kill at any point:
//
//  FULL sync (no usable sync token):
//    Pages /v1/transactions newest-first. The server's cursor is position-based
//    and RE-SENDS the boundary record between pages, so we dedupe by id across
//    pages. After every page we commit rows + the resume cursor, so killing
//    the app mid-sync loses at most one in-flight page (brief stretch goal:
//    "survives the app being killed halfway through"; non-negotiable #5).
//    The sync_token is only stored once the LAST page lands - storing it
//    earlier would make a partial history look complete.
//
//  INCREMENTAL sync:
//    /v1/transactions/changes?since=<token>. Applies upserts + tombstones.
//    A 410 means the server no longer accepts our token -> wipe sync META
//    (never the rows) and run a full sync; the full sync rewrites anything
//    stale, which is how "latest truth wins" (#6) is enforced end to end.
//
//  A process-wide + persisted lock stops two syncs racing each other
//  (stretch goal). A lock older than LOCK_STALE_MS belongs to a killed
//  process and is broken automatically.

import { createApiClient } from './api.ts';
import type { ApiClient } from './api.ts';
import type { ClientOptions } from './api.ts';
import { normalizeRecord, newerOf, UnnormalizableRecord } from './normalize.ts';
import { META } from './store.ts';
import type { Store } from './store.ts';
import { ApiError, ServerDeferral } from './types.ts';
import type { Account, CanonicalTxn } from './types.ts';

const PAGE_LIMIT = 100; // server max: fewer round-trips against a flaky server
const MAX_PAGES = 500; // ~50x the honest history: bounds a hostile server's pagination
const MAX_Q_EXAMPLES = 100; // persisted {id, reason} examples for the UI
const MAX_Q_IDS = 1000; // tracked ids so a record that later reads (or is deleted) clears its own warning
const LOCK_STALE_MS = 2 * 60 * 1000;

export interface SyncEvents {
  onProgress?(p: { phase: 'full' | 'incremental'; synced: number; done: boolean }): void;
  onWait?: ClientOptions['onWait'];
}

export interface SyncResult {
  ok: boolean;
  phase: 'full' | 'incremental' | 'none';
  total: number;
  error?: string;
  alreadyRunning?: boolean;
  needsServerSwitchConfirm?: { previousUrl: string | null };
  deferredUntil?: string;
}

interface QuarantinedRecord { id: string; reason: string; }

// Persisted quarantine state. The count is the exact number of unique,
// still-unresolved records; examples and the tracked id set are bounded.
// An entry clears only when that record actually normalizes or is deleted -
// never because a later sync happened to skip nothing (the follow-up
// incremental sync must not erase the full sync's warning), and never a
// blind eternal warning either. If a hostile server quarantines more than
// MAX_Q_IDS ids, adds still count exactly; the next full sync rebuilds the
// state from scratch, which restores exactness after resolves.
interface QuarantineState { count: number; examples: QuarantinedRecord[]; ids: Set<string>; truncated: boolean; }

function emptyQuarantine(): QuarantineState { return { count: 0, examples: [], ids: new Set(), truncated: false }; }

async function loadQuarantine(store: Store): Promise<QuarantineState> {
  let examples: QuarantinedRecord[] = [];
  let ids = new Set<string>();
  let count = 0;
  try {
    const rawExamples = await store.getMeta(META.quarantined);
    if (rawExamples) examples = JSON.parse(rawExamples);
  } catch { /* fall through to empty */ }
  try {
    const rawIds = await store.getMeta(META.quarantinedIds);
    if (rawIds) ids = new Set<string>(JSON.parse(rawIds).filter((x: unknown): x is string => typeof x === 'string'));
  } catch { /* fall through */ }
  const rawCount = await store.getMeta(META.quarantinedCount);
  const n = rawCount != null ? Number(rawCount) : NaN;
  // Older installs have no count key: the examples list was the whole record.
  count = Number.isFinite(n) && n >= ids.size ? n : ids.size;
  if (!Number.isFinite(n) && ids.size === 0 && examples.length > 0) {
    ids = new Set(examples.map((r) => r?.id).filter((x): x is string => typeof x === 'string'));
    count = ids.size;
  }
  const truncated = (await store.getMeta(META.quarantinedTruncated)) === '1' || ids.size >= MAX_Q_IDS && count > ids.size;
  return { count, examples: examples.slice(0, MAX_Q_EXAMPLES), ids, truncated };
}

function addQuarantine(q: QuarantineState, id: string, reason: string): void {
  if (q.ids.has(id)) {
    const ex = q.examples.find((r) => r.id === id);
    if (ex) ex.reason = reason;
    return;
  }
  q.count += 1;
  if (q.ids.size < MAX_Q_IDS) q.ids.add(id);
  else q.truncated = true; // untracked: later resolves of this record can't be seen, so the count becomes an upper bound
  if (q.examples.length < MAX_Q_EXAMPLES) q.examples.push({ id, reason });
}

function resolveQuarantine(q: QuarantineState, id: string): void {
  if (!q.ids.delete(id)) return;
  q.count = Math.max(0, q.count - 1);
  const i = q.examples.findIndex((r) => r.id === id);
  if (i >= 0) q.examples.splice(i, 1);
}

function quarantineMeta(q: QuarantineState): Record<string, string> {
  return {
    [META.quarantined]: JSON.stringify(q.examples.slice(0, MAX_Q_EXAMPLES)),
    [META.quarantinedCount]: String(q.count),
    [META.quarantinedIds]: JSON.stringify([...q.ids].slice(0, MAX_Q_IDS)),
    [META.quarantinedTruncated]: q.truncated ? '1' : '',
  };
}

export class SyncEngine {
  private client: ApiClient;
  private running = false;

  private baseUrl: string;
  private store: Store;

  constructor(
    store: Store,
    clientOpts: ClientOptions,
  ) {
    this.store = store;
    this.client = createApiClient(clientOpts);
    this.baseUrl = clientOpts.baseUrl;
  }

  private async meta(key: string): Promise<string | null> {
    const v = await this.store.getMeta(key);
    return v == null || v === '' ? null : v;
  }

  async sync(): Promise<SyncResult> {
    // In-memory guard must flip synchronously - before the first await - or
    // two calls started together both pass it.
    if (this.running) return { ok: false, phase: 'none', total: await this.store.count(), alreadyRunning: true };
    this.running = true;
    // Durable deferral: a server that told us to wait is not called again
    // until its own time - across refresh, Settings, and app restarts, since
    // every entrypoint routes through sync(). Scoped to the backend that
    // issued the deferral; changing the server URL drops the gate.
    const notBefore = await this.meta(META.nextSyncNotBefore);
    if (notBefore && (await this.meta(META.nextSyncNotBeforeUrl)) === this.baseUrl) {
      const until = Date.parse(notBefore);
      if (Number.isFinite(until)) {
        if (Date.now() < until) {
          this.running = false;
          return { ok: false, phase: 'none', total: await this.store.count(), error: `Server asked us to wait until ${notBefore}. Not syncing before then; the data on this device is unchanged.`, deferredUntil: notBefore };
        }
        await this.store.commit({ meta: { [META.nextSyncNotBefore]: '', [META.nextSyncNotBeforeUrl]: '' } });
      }
    }
    const lock = await this.meta(META.lock);
    if (lock) {
      const at = Number(lock);
      if (Number.isFinite(at) && Date.now() - at < LOCK_STALE_MS) {
        this.running = false;
        return { ok: false, phase: 'none', total: await this.store.count(), alreadyRunning: true };
      }
    }
    await this.store.commit({ meta: { [META.lock]: String(Date.now()) } });
    try {
      await this.store.putAccounts((await this.client.accounts()).items);
      const token = await this.meta(META.syncToken);
      const resumeCursor = await this.meta(META.fullCursor);
      let r: SyncResult;
      if (!token || resumeCursor != null) {
        r = await this.fullSync(resumeCursor);
      } else {
        r = await this.incrementalSync(token);
      }
      if (r.ok) {
        await this.store.commit({ meta: { [META.dataSourceUrl]: this.baseUrl, [META.lastSyncAt]: new Date().toISOString(), [META.lastSyncError]: '' } });
      } else if (r.error) {
        await this.store.commit({ meta: { [META.lastSyncError]: r.error } });
      }
      return r;
    } catch (e) {
      if (e instanceof ServerDeferral) {
        const msg = `Server asked us to wait until ${e.retryNotBefore}. Sync is paused until then; the data on this device is kept.`;
        await this.store.commit({ meta: { [META.nextSyncNotBefore]: e.retryNotBefore, [META.nextSyncNotBeforeUrl]: this.baseUrl, [META.lastSyncError]: msg } });
        return { ok: false, phase: 'none', total: await this.store.count(), error: msg, deferredUntil: e.retryNotBefore };
      }
      const msg = this.describeError(e);
      await this.store.commit({ meta: { [META.lastSyncError]: msg } });
      return { ok: false, phase: 'none', total: await this.store.count(), error: msg };
    } finally {
      this.running = false;
      await this.store.commit({ meta: { [META.lock]: '' } });
    }
  }
  // staged: fetch everything FIRST, commit once at the end (upserts + drops of
  // what the server does not have + optional account replacement + optional
  // data-source stamp) as one store-atomic write. Used for every replace
  // path, so a failure, cancel or crash mid-download changes NOTHING. It
  // trades away kill-resume: a staged run always starts from the beginning.
  private async fullSync(resumeCursor: string | null, events: SyncEvents = {}, staged?: { accountsReplace?: Account[]; stampDataSource?: boolean }): Promise<SyncResult> {
    // Ids seen during THIS full sync, to drop the server's boundary re-sends.
    // In memory only: resume re-reads the boundary row, whose primary-key
    // upsert + updated_at comparison makes the identical re-send a no-op -
    // no need to persist (and re-serialize) the whole set after every page.
    const seen = new Set<string>();
    const stagedRows = staged ? new Map<string, CanonicalTxn>() : null;
    let cursor = resumeCursor;
    let synced = resumeCursor != null ? await this.store.count() : 0;
    // A fresh full sync re-reads everything, so its quarantine starts empty;
    // a RESUMED one keeps accumulating where the killed attempt left off.
    const quar = resumeCursor != null ? await loadQuarantine(this.store) : emptyQuarantine();
    let pages = 0;
    for (;;) {
      if (++pages > MAX_PAGES) {
        // Committed pages are safe; say exactly what happened.
        throw new Error(`Full sync stopped after ${MAX_PAGES} pages: the server keeps returning next_cursor. ${synced} transactions already synced are kept.`);
      }
      const page = await this.client.listTransactions(cursor, PAGE_LIMIT);
      if (page.next_cursor != null && page.next_cursor === cursor) {
        throw new Error('Server returned a non-advancing cursor; stopping so we do not loop forever. Synced history so far is kept.');
      }
      // Within one page, keep the newest updated_at per id; across pages, the
      // first occurrence wins (the list is newest-first; the only cross-page
      // duplicate the server makes is the identical boundary re-send).
      const pageBest = new Map<string, CanonicalTxn>();
      for (const rawItem of page.items) {
        if (rawItem == null || typeof rawItem.id !== 'string') continue;
        if (seen.has(rawItem.id)) continue;
        let incoming: CanonicalTxn;
        try {
          incoming = normalizeRecord(rawItem);
        } catch (e) {
          if (e instanceof UnnormalizableRecord) {
            // One unreadable record must not block the page or the pipeline;
            // it is recorded and surfaced in the UI, never silently dropped.
            addQuarantine(quar, rawItem.id, e.message);
            continue;
          }
          throw e;
        }
        resolveQuarantine(quar, rawItem.id); // server fixed a record it previously sent unreadable
        pageBest.set(rawItem.id, newerOf(pageBest.get(rawItem.id), incoming));
      }
      const fresh = [...pageBest.values()];
      for (const t of fresh) seen.add(t.id);
      if (stagedRows) for (const t of fresh) stagedRows.set(t.id, t);
      synced += fresh.length;
      const done = page.next_cursor == null;
      if (staged && stagedRows) {
        if (done) {
          // ONE atomic commit: nothing was written during the download, so a
          // failure above leaves the old history byte-for-byte in place.
          const stale: string[] = [];
          for (const t of await this.store.allTxns()) if (!stagedRows.has(t.id)) stale.push(t.id);
          await this.store.commit({
            upserts: [...stagedRows.values()],
            deletes: stale,
            meta: {
              [META.syncToken]: page.sync_token ?? '',
              [META.fullCursor]: '',
              ...quarantineMeta(quar),
              ...(staged.stampDataSource
                ? { [META.dataSourceUrl]: this.baseUrl, [META.lastSyncAt]: new Date().toISOString(), [META.lastSyncError]: '' }
                : {}),
            },
            ...(staged.accountsReplace ? { accountsReplace: staged.accountsReplace } : {}),
          });
          return { ok: true, phase: 'full', total: await this.store.count() };
        }
      } else {
        await this.store.commit({
          upserts: fresh,
          meta: {
            ...(done
              ? { [META.syncToken]: page.sync_token ?? '', [META.fullCursor]: '' }
              : { [META.fullCursor]: page.next_cursor ?? '' }),
            ...quarantineMeta(quar),
          },
        });
      }
      events.onProgress?.({ phase: 'full', synced, done });
      if (done) return { ok: true, phase: 'full', total: await this.store.count() };
      cursor = page.next_cursor;
    }
  }

  private async incrementalSync(token: string, events: SyncEvents = {}): Promise<SyncResult> {
    let cursor: string | null = null;
    let latestToken = token;
    let applied = 0;
    let pages = 0;
    // Merge with what earlier syncs recorded: an incremental pass that skips
    // nothing must not erase an outstanding warning.
    const quar = await loadQuarantine(this.store);
    try {
      for (;;) {
        if (++pages > MAX_PAGES) {
          throw new Error(`Incremental sync stopped after ${MAX_PAGES} pages: the server keeps returning next_cursor. Changes applied so far are kept.`);
        }
        const page = await this.client.changes(latestToken, cursor, PAGE_LIMIT);
        if (page.next_cursor != null && page.next_cursor === cursor) {
          throw new Error('Server returned a non-advancing cursor; stopping so we do not loop forever. Changes applied so far are kept.');
        }
        // The feed is not ordered by updated_at - it can hand us a STALE
        // version after the fresh one. "Latest truth wins" (#6) means compare
        // updated_at against both the batch and the stored row.
        const batchBest = new Map<string, CanonicalTxn>();
        const deletes: string[] = [];
        for (const item of page.items) {
          if (item == null || typeof item.id !== 'string') continue;
          if (item.deleted === true) {
            deletes.push(item.id);
            batchBest.delete(item.id);
            resolveQuarantine(quar, item.id); // gone from the server - warning no longer owed
          } else {
            let incoming: CanonicalTxn;
            try {
              incoming = normalizeRecord(item);
            } catch (e) {
              if (e instanceof UnnormalizableRecord) {
                addQuarantine(quar, item.id, e.message);
                continue;
              }
              throw e;
            }
            resolveQuarantine(quar, item.id); // previously unreadable, now fixed
            batchBest.set(item.id, newerOf(batchBest.get(item.id), incoming));
          }
        }
        const stored = await this.store.txnsByIds([...batchBest.keys()]);
        const upserts: CanonicalTxn[] = [];
        for (const [id, t] of batchBest) {
          if (newerOf(stored.get(id), t) === t) upserts.push(t);
        }
        applied += upserts.length + deletes.length;
        const done = page.next_cursor == null;
        if (done && page.sync_token) latestToken = page.sync_token;
        await this.store.commit({
          upserts,
          deletes,
          meta: {
            ...(done ? { [META.syncToken]: latestToken } : {}),
            ...quarantineMeta(quar),
          },
        });
        events.onProgress?.({ phase: 'incremental', synced: applied, done });
        if (done) return { ok: true, phase: 'incremental', total: await this.store.count() };
        cursor = page.next_cursor;
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 410) {
        // A 410 from the SAME backend is token expiry: clear sync META only
        // (never rows) and do a full sync. A 410 after the backend CHANGED
        // means this server does not know our history at all - replacing
        // local data is the user's call, never ours, so stop and ask.
        const stamped = await this.meta(META.dataSourceUrl);
        if (stamped != null && !sameUrl(stamped, this.baseUrl)) {
          const msg = `This server does not recognise the sync history from ${stamped}. If it is a different backend, you can replace the local history with its data - nothing has been changed or deleted.`;
          await this.store.commit({ meta: { [META.lastSyncError]: msg } });
          return { ok: false, phase: 'none', total: await this.store.count(), error: msg, needsServerSwitchConfirm: { previousUrl: stamped } };
        }
        if (stamped == null && (await this.store.count()) > 0) {
          // History synced by a build from before the data-source stamp
          // existed. We cannot know which backend it came from, and a silent
          // re-download would adopt whatever this server has - so ask, the
          // same as a known-different backend, naming the source as unknown.
          const msg = 'This server does not recognise the synced history on this device, and its original source was never recorded. If this is a different backend, you can replace the local history with its data - nothing has been changed or deleted.';
          await this.store.commit({ meta: { [META.lastSyncError]: msg } });
          return { ok: false, phase: 'none', total: await this.store.count(), error: msg, needsServerSwitchConfirm: { previousUrl: null } };
        }
        // Same-backend recovery (stamp matches, or an empty store with
        // nothing to lose) is also staged: the re-download commits once at
        // the end, so a failed recovery never half-overwrites history.
        return this.fullSync(null, events, {});
      }
      throw e;
    }
  }

  // User-confirmed backend switch. Full sync against the new backend; only on
  // success are rows it does not have dropped and the data-source stamp moved.
  // Any failure leaves the previous history exactly where it was.
  // A transport-level failure (DNS, refused, offline) gets words a user can
  // act on instead of the raw text. Web/Node fetch throws TypeError; Expo's
  // native fetch throws FetchError (an Error, NOT a TypeError) whose message
  // starts "fetch failed: ...", so match the transport signatures, not one
  // class. Verified against expo/src/winter/fetch/FetchErrors.ts.
  private describeError(e: unknown): string {
    if (e instanceof ApiError) return e.message;
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof TypeError || /^fetch failed/i.test(msg) || /network request failed/i.test(msg)) {
      return `Can't reach the server at ${this.baseUrl}. Check the URL in Server settings and the network connection.`;
    }
    return msg;
  }


  async replaceWithServer(events: SyncEvents = {}): Promise<SyncResult> {
    try {
      const accounts = (await this.client.accounts()).items;
      return await this.fullSync(null, events, { accountsReplace: accounts, stampDataSource: true });
    } catch (e) {
      // Failure at any point leaves the previous history exactly where it was.
      const msg = this.describeError(e);
      await this.store.commit({ meta: { [META.lastSyncError]: msg } });
      return { ok: false, phase: 'none', total: await this.store.count(), error: msg };
    }
  }
}

// Two URLs are the same backend when they differ only by trailing slashes or
// surrounding whitespace - cosmetic edits must not trigger a data wipe.
export function sameUrl(a: string, b: string): boolean {
  return a.trim().replace(/\/+$/, '') === b.trim().replace(/\/+$/, '');
}
