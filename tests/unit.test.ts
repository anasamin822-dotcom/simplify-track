import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decimalStringToMinor, normalizeRecord, isLegacyShape } from '../src/core/normalize.ts';
import { formatINR, groupIndian, formatAmount } from '../src/core/money.ts';
import { monthKeyIST, computeMonthTotals } from '../src/core/totals.ts';
import type { CanonicalTxn } from '../src/core/types.ts';

test('decimalStringToMinor is exact', () => {
  assert.equal(decimalStringToMinor('516.49'), 51649);
  assert.equal(decimalStringToMinor('516'), 51600);
  assert.equal(decimalStringToMinor('0.01'), 1);
  assert.equal(decimalStringToMinor('-3.5'), -350);
  assert.throws(() => decimalStringToMinor('1.999')); // sub-paise precision must not be dropped silently
  assert.throws(() => decimalStringToMinor('abc'));
});

test('legacy shape normalizes correctly', () => {
  const t = normalizeRecord({ id: '115509', account: '4821', txn_time: 1774981380, amount: '516.49', type: 'DR', merchant_name: 'BLINKIT', category: 'GROCERIES', status: 'POSTED' });
  assert.equal(t.shape, 'legacy');
  assert.equal(t.accountId, 'acc_4821');
  assert.equal(t.direction, 'debit');
  assert.equal(t.amountMinor, 51649);
  assert.equal(t.inrMinor, 51649);
  assert.equal(t.currency, 'INR');
  assert.equal(t.merchant, 'BLINKIT');
  assert.equal(t.occurredAtMs, 1774981380000);
  assert.equal(t.updatedAtMs, null);
  assert.equal(t.isOwnTransfer, false);
});

test('legacy CR + linked_account = own transfer credit', () => {
  const t = normalizeRecord({ id: '132083', account: '3310', txn_time: 1773848160, amount: '21579.63', type: 'CR', merchant_name: 'PAYMENT RECEIVED - THANK YOU', category: 'TRANSFER', status: 'POSTED', linked_account: '9075' });
  assert.equal(t.direction, 'credit');
  assert.equal(t.isOwnTransfer, true);
  assert.equal(t.linkedAccountId, 'acc_9075');
});

test('modern FX row keeps USD amount and settled INR value', () => {
  const t = normalizeRecord({ id: 'txn_X', account_id: 'acc_3310', occurred_at: '2026-10-08T21:45:00Z', direction: 'debit', amount_minor: 1000, currency: 'USD', merchant: 'NOTION', category: 'SUBSCRIPTIONS', status: 'POSTED', updated_at: '2026-10-08T23:14:00Z', fx: { inr_minor: 86661 } });
  assert.equal(t.currency, 'USD');
  assert.equal(t.amountMinor, 1000);
  assert.equal(t.inrMinor, 86661); // bank-settled, never a guessed rate
});

test('modern own-transfer detection comes from counterparty, not merchant text', () => {
  const own = normalizeRecord({ id: 'a', account_id: 'acc_4821', occurred_at: '2026-10-03T04:42:00Z', direction: 'debit', amount_minor: 2500000, currency: 'INR', merchant: 'SELF TRANSFER TO XX9075', category: 'TRANSFER', status: 'POSTED', updated_at: '2026-10-03T04:56:00Z', counterparty: { type: 'OWN_ACCOUNT', account_id: 'acc_9075' } });
  assert.equal(own.isOwnTransfer, true);
  // A transfer-looking merchant WITHOUT the own-account marker is a real
  // payment to another person (rent etc.) and must stay spend.
  const other = normalizeRecord({ id: 'b', account_id: 'acc_4821', occurred_at: '2026-10-03T04:42:00Z', direction: 'debit', amount_minor: 174900, currency: 'INR', merchant: 'UPI/RAHUL SHARMA', category: 'TRANSFERS_OUT', status: 'POSTED', updated_at: '2026-10-03T04:56:00Z' });
  assert.equal(other.isOwnTransfer, false);
});

test('modern shape detection: legacy only when txn_time present and occurred_at absent', () => {
  assert.equal(isLegacyShape({ txn_time: 1, amount: '1.00' }), true);
  assert.equal(isLegacyShape({ occurred_at: '2026-01-01T00:00:00Z' }), false);
});

test('Indian digit grouping', () => {
  assert.equal(groupIndian(999), '999');
  assert.equal(groupIndian(1000), '1,000');
  assert.equal(groupIndian(100000), '1,00,000');
  assert.equal(groupIndian(12345678), '1,23,45,678');
});

test('formatINR: paise only when non-zero, optional sign', () => {
  assert.equal(formatINR(10978498), '₹1,09,784.98');
  assert.equal(formatINR(24513500), '₹2,45,135');
  assert.equal(formatINR(500, { sign: 'debit' }), '-₹5');
  assert.equal(formatINR(500, { sign: 'credit' }), '+₹5');
});

test('formatAmount keeps foreign currency original', () => {
  assert.equal(formatAmount({ amountMinor: 1299, currency: 'USD', inrMinor: 110000 }), 'USD 12.99');
});

test('monthKeyIST: UTC/IST month boundary', () => {
  // 30 Sep 2026 19:00 UTC = 1 Oct 00:30 IST -> October to an Indian user
  assert.equal(monthKeyIST(Date.parse('2026-09-30T19:00:00Z')), '2026-10');
  assert.equal(monthKeyIST(Date.parse('2026-09-30T18:29:00Z')), '2026-09');
});

const mk = (o: any): CanonicalTxn => ({
  id: o.id ?? Math.random().toString(36), accountId: 'acc_1', occurredAtMs: o.ts ?? 0,
  direction: o.direction ?? 'debit', amountMinor: o.minor ?? 0, currency: o.currency ?? 'INR',
  inrMinor: o.inr !== undefined ? o.inr : (o.minor ?? 0), merchant: '', category: o.category ?? null,
  status: o.status ?? 'POSTED', updatedAtMs: null, isOwnTransfer: o.own ?? false,
  linkedAccountId: null, shape: 'modern' as const, raw: '{}',
});

test('totals: own transfers excluded, refunds are income, pending counted, unknown INR surfaced', () => {
  const oct = Date.parse('2026-10-10T05:00:00Z');
  const [mt] = computeMonthTotals([
    mk({ id: 'spend', ts: oct, minor: 10000 }),
    mk({ id: 'own-out', ts: oct, minor: 50000, own: true }),
    mk({ id: 'own-in', ts: oct, minor: 50000, own: true, direction: 'credit' }),
    mk({ id: 'refund', ts: oct, minor: 3000, direction: 'credit', category: 'REFUND' }),
    mk({ id: 'salary', ts: oct, minor: 200000, direction: 'credit', category: 'SALARY' }),
    mk({ id: 'pending', ts: oct, minor: 7000, status: 'PENDING' }),
    mk({ id: 'fx-mystery', ts: oct, minor: 500, currency: 'EUR', inr: null }),
  ]);
  assert.equal(mt.spendMinor, 17000);
  assert.equal(mt.incomeMinor, 203000);
  assert.equal(mt.count, 7); // every transaction appears exactly once
  assert.equal(mt.ownTransferCount, 2);
  assert.equal(mt.pendingCount, 1);
  assert.equal(mt.unknownInr.length, 1);
  assert.equal(mt.unknownInr[0].currency, 'EUR');
});
