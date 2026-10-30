// Month bucketing and honest spend/income totals.
//
// Rules (non-negotiables #1-#4, #7), each justified from the brief + schema:
//
//  - Months are calendar months in Asia/Kolkata. The app's users are in India
//    (brief, non-negotiable #3); a salary landing 30 Sep 11:59 PM IST is
//    September money to them, not October (UTC would say so). +05:30 is fixed
//    - India has no DST - so a constant offset is exact, not approximate.
//  - Own-account transfers are neither spend nor income (brief, non-negotiable
//    #4). Detected structurally: modern records name the other side in
//    counterparty.type === "OWN_ACCOUNT"; legacy records name it in
//    linked_account. We do NOT infer transfers from merchant strings - the
//    record schema tells us.
//  - Spend = debits (minus nothing else). Money sent to another person
//    (e.g. category TRANSFERS_OUT with no own-account marker) IS spend - it
//    left the user's money for good.
//  - Income = credits. A REFUND credit is money back in; it lands in income
//    rather than erasing spend, because it can arrive in a different month
//    than the original purchase. (Documented inference: the brief does not
//    prescribe refund treatment.)
//  - PENDING rows count. They are real authorisations against the user's
//    money, and the sync layer replaces them with their POSTED versions when
//    the changes feed says so (latest truth wins). If a pending row is later
//    deleted, it disappears. Totals always reflect the latest known state.
//    (Documented inference.)
//  - INR totals use inrMinor: exact for INR rows, the bank-settled fx.inr_minor
//    for FX rows (never a guessed rate). Rows whose INR value is unknown are
//    excluded from INR totals and surfaced in `unknownInr` so the number we
//    show is never silently incomplete - "your numbers are honest" (#7).

import type { CanonicalTxn } from './types.ts';

export const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

export function monthKeyIST(occurredAtMs: number): string {
  const d = new Date(occurredAtMs + IST_OFFSET_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

export function monthLabel(key: string): string {
  const [y, m] = key.split('-');
  return `${MONTH_NAMES[Number(m) - 1]} ${y}`;
}

export interface MonthTotals {
  month: string; // "2026-10"
  spendMinor: number; // INR minor units
  incomeMinor: number;
  count: number; // every transaction that month, including transfers (brief #1: every transaction appears)
  ownTransferCount: number;
  pendingCount: number;
  unknownInr: { id: string; currency: string; amountMinor: number }[];
}

export function computeMonthTotals(txns: Iterable<CanonicalTxn>): MonthTotals[] {
  const byMonth = new Map<string, MonthTotals>();
  for (const t of txns) {
    const key = monthKeyIST(t.occurredAtMs);
    let mt = byMonth.get(key);
    if (!mt) {
      mt = { month: key, spendMinor: 0, incomeMinor: 0, count: 0, ownTransferCount: 0, pendingCount: 0, unknownInr: [] };
      byMonth.set(key, mt);
    }
    mt.count += 1;
    if (t.isOwnTransfer) {
      mt.ownTransferCount += 1;
      continue; // neither spend nor income
    }
    if (t.status === 'PENDING') mt.pendingCount += 1;
    if (t.inrMinor == null) {
      mt.unknownInr.push({ id: t.id, currency: t.currency, amountMinor: t.amountMinor });
      continue;
    }
    if (t.direction === 'debit') mt.spendMinor += t.inrMinor;
    else mt.incomeMinor += t.inrMinor;
  }
  return [...byMonth.values()].sort((a, b) => (a.month < b.month ? 1 : -1));
}
