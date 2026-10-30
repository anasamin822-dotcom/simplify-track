// Display-only helpers: IST wall-clock rendering and merchant cleanup.
import type { Account, CanonicalTxn } from '../core/types.ts';

const IST = (5 * 60 + 30) * 60 * 1000;

export function timeIST(ms: number): string {
  const d = new Date(ms + IST);
  let h = d.getUTCHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${String(d.getUTCMinutes()).padStart(2, '0')} ${ampm}`;
}

export function dayLabelIST(ms: number): string {
  const d = new Date(ms + IST);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]}`;
}

export function dateIST(ms: number): string {
  const d = new Date(ms + IST);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function dateTimeIST(ms: number): string {
  return `${dateIST(ms)}, ${timeIST(ms)} IST`;
}

// Merchant strings are real-shaped: shouty bank prefixes, unicode, mixed case.
// Clean for display only; the raw string is preserved on the record.
export function cleanMerchant(raw: string): string {
  let s = raw.trim();
  s = s.replace(/^UPI\//, '');
  s = s.replace(/\*/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > 2 && s === s.toUpperCase() && /[A-Z]/.test(s)) {
    s = s.toLowerCase().replace(/(^|\s)(\S)/g, (_, p, c) => p + c.toUpperCase());
  }
  return s || raw;
}

export function accountLabel(t: CanonicalTxn, accounts: Map<string, Account>): string {
  const a = t.accountId ? accounts.get(t.accountId) : undefined;
  if (a) return a.nickname || `${a.bank} \u2022\u2022${a.last4}`;
  return t.accountId ? t.accountId.replace('acc_', '\u2022\u2022') : 'Unknown account';
}
