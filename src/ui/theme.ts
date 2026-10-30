// Track design system v2 - "premium dark fintech": a deep-space base, one
// indigo->violet accent, tinted glass surfaces, Sora for display numerals and
// Inter for text. Semantic money colors stay distinct from the accent so
// spend/income meaning never depends on decoration.

export const colors = {
  bg: '#05070D',
  bgElev: '#0A0F1C',
  card: 'rgba(148,163,255,0.055)',
  cardSolid: '#0D1322',
  cardAlt: 'rgba(148,163,255,0.10)',
  border: 'rgba(148,163,255,0.11)',
  borderSoft: 'rgba(148,163,255,0.07)',
  text: '#F4F6FC',
  textDim: '#A4AECB',
  textFaint: '#6E7994',
  accent: '#6E7BFF',
  accent2: '#9D6BFF',
  accentSoft: 'rgba(110,123,255,0.15)',
  debit: '#FF5D73',
  credit: '#2ED39A',
  transfer: '#8A94AB',
  pending: '#F5B544',
};

export const fonts = {
  display: 'Sora_700Bold',
  displayHeavy: 'Sora_800ExtraBold',
  displayMid: 'Sora_600SemiBold',
  body: 'Inter_400Regular',
  bodyMed: 'Inter_500Medium',
  bodySemi: 'Inter_600SemiBold',
  bodyBold: 'Inter_700Bold',
};

export const grad = {
  accent: ['#6E7BFF', '#9D6BFF'] as const,
  screen: ['#0A1020', '#05070D'] as const,
  heroGlow: ['rgba(110,123,255,0.20)', 'rgba(110,123,255,0)'] as const,
  hairline: ['rgba(110,123,255,0)', 'rgba(110,123,255,0.45)', 'rgba(157,107,255,0)'] as const,
};

export const radius = { sm: 10, md: 14, lg: 20, pill: 999 };

export const CATEGORY_COLORS: Record<string, string> = {
  FOOD: '#FF9F43',
  GROCERIES: '#2ED573',
  TRAVEL: '#54A0FF',
  SHOPPING: '#FF6B81',
  BILLS: '#A55EEA',
  HEALTH: '#26DE81',
  ENTERTAINMENT: '#FD9644',
  TRANSFER: '#778CA3',
  TRANSFERS_OUT: '#778CA3',
  REFUND: '#45AAF2',
  SUBSCRIPTIONS: '#FC5C65',
  SALARY: '#20BF6B',
  RENT: '#8854D0',
  BNPL_EMI: '#F7B731',
  INSURANCE_PREMIUM: '#4B6584',
};

export function categoryColor(category: string | null): string {
  return (category && CATEGORY_COLORS[category]) || '#6B7A8D';
}

// Tinted square behind a category monogram: the category hue at low alpha.
export function categoryTint(category: string | null): string {
  return categoryColor(category) + '22';
}

export function categoryLetter(category: string | null): string {
  if (!category) return '?';
  const c = category.replace(/_/g, ' ').trim();
  return c ? c[0].toUpperCase() : '?';
}
