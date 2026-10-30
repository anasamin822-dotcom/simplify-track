// Normalization: API records -> CanonicalTxn.
//
// The API serves two record shapes (this is intentional, per the assignment:
// "real-shaped, which means it is not tidy"):
//
//  modern: { id, account_id, occurred_at, direction, amount_minor, currency,
//            merchant, category, status, updated_at, counterparty?, fx? }
//  legacy: { id, account, txn_time (epoch seconds), amount ("516.49", MAJOR units,
//            string), type: "DR"|"CR", merchant_name, category, status,
//            linked_account? }   -- no updated_at, no currency (INR: pre-2026
//            domestic bank export, amount is rupees with paise)
//
// Rules, and where each comes from:
//  - legacy `amount` is a decimal string in MAJOR units -> parse with the
//    string -> minor-units helper (never float multiply) to stay exact.
//  - legacy `type` DR -> debit, CR -> credit.
//  - legacy `linked_account` marks a transfer between the user's own accounts,
//    same meaning as modern counterparty.type === "OWN_ACCOUNT".
//  - Non-INR records keep their own currency/amount. When the record carries
//    fx.inr_minor (the bank's settled INR value) we use THAT for INR totals -
//    it is the exact settled amount, not an estimated conversion.
//  - Nothing is dropped here. Unknown/odd values flow through; `raw` keeps
//    the verbatim record so no information is ever lost.

import type { CanonicalTxn, Direction } from './types.ts';

export class UnnormalizableRecord extends Error {
  record: any;
  constructor(record: any, reason: string) {
    super(`Cannot normalize record: ${reason}`);
    this.record = record;
  }
}

// Exact decimal-string -> minor units. "516.49" -> 51649, "516.5" -> 51650,
// "516" -> 51600. Rejects anything that would lose sub-paise precision.
export function decimalStringToMinor(s: string): number {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (!m) throw new Error(`bad decimal string: ${JSON.stringify(s)}`);
  const frac = (m[3] ?? '').padEnd(2, '0');
  if (frac.length > 2 && /[1-9]/.test(frac.slice(2))) {
    throw new Error(`sub-minor-unit precision would be lost: ${JSON.stringify(s)}`);
  }
  if (m[2].length > 13) {
    // minor units would exceed 2^53; Number() would go silently inexact
    throw new Error(`amount exceeds exact minor-unit range: ${JSON.stringify(s)}`);
  }
  const v = Number(m[2]) * 100 + Number(frac.slice(0, 2) || '0');
  return m[1] === '-' ? -v : v;
}

export function isLegacyShape(r: any): boolean {
  return r != null && typeof r === 'object' && 'txn_time' in r && !('occurred_at' in r);
}

export function normalizeRecord(r: any): CanonicalTxn {
  if (r == null || typeof r !== 'object' || typeof r.id !== 'string') {
    throw new UnnormalizableRecord(r, 'missing string id');
  }
  const raw = JSON.stringify(r);

  if (isLegacyShape(r)) {
    if (typeof r.txn_time !== 'number') throw new UnnormalizableRecord(r, 'legacy txn_time not a number');
    // epoch seconds, 1970..2100: Infinity/negative/huge values would store
    // rows with NaN or nonsense month labels
    if (!Number.isFinite(r.txn_time) || r.txn_time < 0 || r.txn_time > 4102444800) {
      throw new UnnormalizableRecord(r, `legacy txn_time out of range: ${r.txn_time}`);
    }
    if (typeof r.amount !== 'string') throw new UnnormalizableRecord(r, 'legacy amount not a string');
    const direction: Direction = r.type === 'DR' ? 'debit' : r.type === 'CR' ? 'credit' : (() => { throw new UnnormalizableRecord(r, `legacy type ${r.type}`); })();
    let minor: number;
    try {
      minor = decimalStringToMinor(r.amount);
    } catch (e) {
      throw new UnnormalizableRecord(r, `legacy amount: ${e instanceof Error ? e.message : e}`);
    }
    return {
      id: r.id,
      accountId: typeof r.account === 'string' ? `acc_${r.account}` : null,
      occurredAtMs: r.txn_time * 1000,
      direction,
      amountMinor: Math.abs(minor),
      currency: 'INR', // legacy export is a domestic bank feed; amounts are rupees
      inrMinor: Math.abs(minor),
      merchant: typeof r.merchant_name === 'string' ? r.merchant_name : '',
      category: typeof r.category === 'string' ? r.category : null,
      status: typeof r.status === 'string' ? r.status : 'UNKNOWN',
      updatedAtMs: null, // legacy shape carries no updated_at
      isOwnTransfer: r.linked_account != null,
      linkedAccountId: r.linked_account != null ? `acc_${r.linked_account}` : null,
      shape: 'legacy',
      raw,
    };
  }

  // modern shape
  if (typeof r.occurred_at !== 'string') throw new UnnormalizableRecord(r, 'modern occurred_at missing');
  const occurredAtMs = Date.parse(r.occurred_at);
  if (Number.isNaN(occurredAtMs)) throw new UnnormalizableRecord(r, `unparseable occurred_at ${r.occurred_at}`);
  if (typeof r.amount_minor !== 'number' || !Number.isInteger(r.amount_minor)) {
    throw new UnnormalizableRecord(r, 'modern amount_minor not an integer');
  }
  if (r.direction !== 'debit' && r.direction !== 'credit') {
    throw new UnnormalizableRecord(r, `direction ${r.direction}`);
  }
  const currency = typeof r.currency === 'string' ? r.currency : '???';
  const fxInr = r.fx != null && typeof r.fx === 'object' && Number.isInteger(r.fx.inr_minor) ? r.fx.inr_minor : null;
  const cp = r.counterparty != null && typeof r.counterparty === 'object' ? r.counterparty : null;
  const isOwnTransfer = cp != null && cp.type === 'OWN_ACCOUNT';
  return {
    id: r.id,
    accountId: typeof r.account_id === 'string' ? r.account_id : null,
    occurredAtMs,
    direction: r.direction,
    amountMinor: Math.abs(r.amount_minor),
    currency,
    inrMinor: currency === 'INR' ? Math.abs(r.amount_minor) : fxInr,
    merchant: typeof r.merchant === 'string' ? r.merchant : '',
    category: typeof r.category === 'string' ? r.category : null,
    status: typeof r.status === 'string' ? r.status : 'UNKNOWN',
    updatedAtMs: typeof r.updated_at === 'string' && !Number.isNaN(Date.parse(r.updated_at)) ? Date.parse(r.updated_at) : null,
    isOwnTransfer,
    linkedAccountId: isOwnTransfer && typeof cp.account_id === 'string' ? cp.account_id : null,
    shape: 'modern',
    raw,
  };
}

// "Latest truth wins" (non-negotiable #6): between two versions of the same
// transaction, the one with the LATER updated_at is the truth. The changes
// feed is not ordered by updated_at, so callers must never apply feed entries
// blindly in order. A version with no updated_at (legacy rows) loses to any
// version that has one; two unknowns keep the incumbent (first wins).
// updated_at comparison. On an EXACT tie the incumbent is kept: the changes
// feed can hand the same record twice, and flipping on equal timestamps would
// make the result depend on feed order. Documented in docs/DECISIONS.md.
export function newerOf(a: CanonicalTxn | undefined | null, b: CanonicalTxn): CanonicalTxn {
  if (a == null) return b;
  if (a.updatedAtMs == null && b.updatedAtMs == null) return a;
  if (a.updatedAtMs == null) return b;
  if (b.updatedAtMs == null) return a;
  return b.updatedAtMs > a.updatedAtMs ? b : a;
}

// Apply a changes-feed item to the stored map. Deleted tombstones remove;
// upserts keep the newer updated_at. Returns false for tombstones of ids we
// never had (harmless, but callers may want to know).
export function applyChange(map: Map<string, CanonicalTxn>, item: any): boolean {
  if (item == null || typeof item.id !== 'string') return false;
  if (item.deleted === true) {
    return map.delete(item.id);
  }
  const incoming = normalizeRecord(item);
  map.set(item.id, newerOf(map.get(item.id), incoming));
  return true;
}
