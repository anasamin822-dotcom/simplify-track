// Money display. Non-negotiables #2 and #3: exact, and reads the way users
// in India read it -> integer minor units everywhere, en-IN grouping
// (1,00,000), rupee symbol, two decimals only when paise are non-zero.

export function formatINR(minor: number, opts: { sign?: 'debit' | 'credit' | null } = {}): string {
  const abs = Math.abs(minor);
  const rupees = Math.floor(abs / 100);
  const paise = abs % 100;
  const grouped = groupIndian(rupees);
  const body = paise === 0 ? grouped : `${grouped}.${String(paise).padStart(2, '0')}`;
  const prefix = opts.sign === 'debit' ? '-\u20B9' : opts.sign === 'credit' ? '+\u20B9' : '\u20B9';
  return `${prefix}${body}`;
}

// 12345678 -> "1,23,45,678" (Indian digit grouping), no Intl dependency so
// Hermes/JSC/old Android all render identically.
export function groupIndian(n: number): string {
  const s = String(n);
  if (s.length <= 3) return s;
  const last3 = s.slice(-3);
  let rest = s.slice(0, -3);
  let out = '';
  while (rest.length > 2) {
    out = ',' + rest.slice(-2) + out;
    rest = rest.slice(0, -2);
  }
  return rest + out + ',' + last3;
}

export function formatAmount(t: { amountMinor: number; currency: string; inrMinor: number | null }): string {
  if (t.currency === 'INR') return formatINR(t.amountMinor);
  // Foreign currency: show the original amount; INR equivalent (when the
  // record carries one) is shown separately by the caller.
  const major = t.amountMinor / 100;
  return `${t.currency} ${major.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
