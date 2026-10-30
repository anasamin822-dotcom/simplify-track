// Canonical transaction shape used everywhere inside the app.
// Raw API records (modern OR legacy shape) are normalized into this once,
// at the sync boundary. The untouched raw record is always preserved.

export type Direction = 'debit' | 'credit';

export interface CanonicalTxn {
  id: string;
  accountId: string | null; // e.g. "acc_4821"; null when the record does not name an account
  occurredAtMs: number; // epoch milliseconds
  direction: Direction;
  amountMinor: number; // integer minor units of `currency`
  currency: string; // ISO code, e.g. "INR" | "USD"; "???" when the record does not say
  inrMinor: number | null; // exact INR value: amountMinor when INR, fx.inr_minor when the API provides it, null when unknown
  merchant: string; // raw merchant string, "" when absent
  category: string | null;
  status: string; // e.g. "POSTED" | "PENDING"
  updatedAtMs: number | null; // null for legacy records (they carry no updated_at)
  isOwnTransfer: boolean; // money between the user's own accounts
  linkedAccountId: string | null; // the other own account, when the record names it
  shape: 'modern' | 'legacy';
  raw: string; // the original record, verbatim JSON
}

export interface Account {
  id: string;
  bank: string;
  type: string;
  last4: string;
  nickname: string | null;
}

export interface ListPage {
  items: any[];
  next_cursor: string | null;
  sync_token?: string;
}

export interface ChangesPage {
  items: any[];
  next_cursor: string | null;
  sync_token?: string;
}

// The server asked us to wait longer than we are willing to hold a sync open.
// We never retry EARLIER than the server asked; we stop the attempt and tell
// the user when a retry becomes eligible instead.
export class ServerDeferral extends Error {
  retryAfterSec: number;
  retryNotBefore: string;
  constructor(retryAfterSec: number) {
    const at = new Date(Date.now() + retryAfterSec * 1000);
    super(`Server asked us to wait ${Math.round(retryAfterSec / 60)} min before the next try; sync paused until ${at.toLocaleTimeString()}. Your data so far is kept.`);
    this.retryAfterSec = retryAfterSec;
    this.retryNotBefore = at.toISOString();
  }
}


export class ApiError extends Error {
  status: number;
  body: any;
  retryAfterSec: number | null;
  constructor(status: number, body: any, retryAfterSec: number | null) {
    // The body is the server's own words, shown to the user as-is - bound it,
    // or a hostile/buggy server controls a wall of text in our UI.
    const raw = JSON.stringify(body) ?? String(body);
    super(`API ${status}: ${raw.length > 160 ? raw.slice(0, 157) + '...' : raw}`);
    this.status = status;
    this.body = body;
    this.retryAfterSec = retryAfterSec;
  }
}
