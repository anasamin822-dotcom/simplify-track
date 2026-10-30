// Thin API client for the Track mock server.
// The server is deliberately hostile (assignment README: "This server behaves
// the way our production API does. That includes the parts nobody likes"):
//   - request #6 to /v1/transactions -> 500
//   - request #11 -> 429 with Retry-After
//   - request #3 and then every 7th after #20 -> multi-second latency
//   - first /v1/transactions/changes call -> 503 with Retry-After
//   - unknown sync tokens -> 410 (do a full sync)
// So: honour Retry-After, bounded backoff on 5xx, never retry 4xx (except 429),
// and let the SYNC layer decide about 410.

import { ApiError, ServerDeferral } from './types.ts';
import type { ChangesPage, ListPage } from './types.ts';

export interface ApiClient {
  listTransactions(cursor: string | null, limit: number): Promise<ListPage>;
  changes(since: string, cursor: string | null, limit: number): Promise<ChangesPage>;
  accounts(): Promise<{ items: any[] }>;
}

export interface ClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  maxAttempts?: number; // per request, including the first
  sleep?: (ms: number) => Promise<void>;
  onWait?: (reason: string, ms: number) => void;
}

const MAX_WAIT_MS = 30_000; // longest server-directed wait we will hold open

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function getJson<T>(opts: ClientOptions, path: string, attempt = 1): Promise<T> {
  const f = opts.fetchImpl ?? fetch;
  const max = opts.maxAttempts ?? 5;
  const sleep = opts.sleep ?? defaultSleep;
  let res: Response;
  try {
    res = await f(`${opts.baseUrl}${path}`);
  } catch (e) {
    if (attempt >= max) throw e;
    const wait = Math.min(500 * 2 ** (attempt - 1), 4000);
    opts.onWait?.(`network error, retry ${attempt}`, wait);
    await sleep(wait);
    return getJson(opts, path, attempt + 1);
  }
  if (res.ok) return (await res.json()) as T;

  const retryAfterRaw = res.headers.get('Retry-After');
  const retryAfterSec = retryAfterRaw != null && /^\d+$/.test(retryAfterRaw) ? Number(retryAfterRaw) : null;
  let body: any = null;
  try { body = await res.json(); } catch { /* not json */ }

  const retriable = res.status === 429 || (res.status >= 500 && res.status < 600);
  if (retriable && attempt < max) {
    // Honour Retry-After - but a server-directed wait past MAX_WAIT_MS ends
    // this attempt honestly (deferred, not clamped): we never retry earlier
    // than the server required, and we never park a sync for hours.
    if (retryAfterSec != null && retryAfterSec * 1000 > MAX_WAIT_MS) {
      throw new ServerDeferral(retryAfterSec);
    }
    const wait = retryAfterSec != null ? retryAfterSec * 1000 : Math.min(500 * 2 ** (attempt - 1), 4000);
    opts.onWait?.(`HTTP ${res.status}, retry ${attempt}`, wait);
    await sleep(wait);
    return getJson(opts, path, attempt + 1);
  }
  throw new ApiError(res.status, body, retryAfterSec);
}

export function createApiClient(opts: ClientOptions): ApiClient {
  return {
    listTransactions: (cursor, limit) =>
      getJson(opts, `/v1/transactions?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),
    changes: (since, cursor, limit) =>
      getJson(opts, `/v1/transactions/changes?since=${encodeURIComponent(since)}&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),
    accounts: () => getJson(opts, '/v1/accounts'),
  };
}

// What the Settings screen accepts. http stays allowed on purpose: the dev
// flow (emulator 10.0.2.2, same-Wi-Fi LAN IP) is plain http, and the README
// documents that release builds need https.
export function validateServerUrl(rawInput: string): string | null {
  const raw = rawInput.trim();
  if (!raw) return 'Enter the server URL first.';
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return 'That is not a valid URL. Example: https://your-track-server.example.com';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'Only http:// or https:// server URLs work.';
  }
  return null;
}
