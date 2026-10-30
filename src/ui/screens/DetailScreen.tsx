import React, { useMemo, useState } from 'react';
import { LayoutAnimation, Platform, ScrollView, StyleSheet, Text, TouchableOpacity, UIManager, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { formatAmount, formatINR } from '../../core/money.ts';
import { useApp } from '../../state/state.tsx';
import { accountLabel, cleanMerchant, dateTimeIST } from '../display.ts';
import { ScreenBackdrop } from '../components/Backdrop.tsx';
import { categoryColor, categoryLetter, categoryTint, colors, fonts, radius } from '../theme.ts';

// Everything we know about one transaction - including the verbatim record
// the server sent (expandable), because "trust" means being able to check.
export default function DetailScreen({ route }: NativeStackScreenProps<any>) {
  const { txns, accounts } = useApp();
  const [showRaw, setShowRaw] = useState(false);
  const t = useMemo(() => txns.find((x) => x.id === (route.params as any).id), [txns, route.params]);
  if (!t) {
    return (
      <View style={styles.screen}>
        <ScreenBackdrop />
        <Text style={styles.gone}>This transaction is no longer on the server.</Text>
      </View>
    );
  }
  const debit = t.direction === 'debit';

  return (
    <View style={styles.screen}>
      <ScreenBackdrop />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.hero}>
          <View style={[styles.heroBubble, { backgroundColor: categoryTint(t.category) }]}>
            <Text style={[styles.heroBubbleLetter, { color: categoryColor(t.category) }]}>{categoryLetter(t.category)}</Text>
          </View>
          <Text style={styles.merchant}>{cleanMerchant(t.merchant)}</Text>
          <Text style={[styles.amount, { color: t.isOwnTransfer ? colors.transfer : debit ? colors.debit : colors.credit }]}>
            {t.isOwnTransfer ? formatAmount(t) : formatINR(t.amountMinor, { sign: debit ? 'debit' : 'credit' })}
          </Text>
          {t.currency !== 'INR' && (
            <Text style={styles.fx}>
              Settled at {t.inrMinor != null ? formatINR(t.inrMinor) : 'an unknown INR amount'}
              {t.inrMinor != null ? ` (bank's fx value, used in totals)` : ' (excluded from totals)'}
            </Text>
          )}
          <View style={[styles.statusPill, t.status === 'PENDING' ? styles.statusPillPending : styles.statusPillPosted]}>
            <View style={[styles.statusDot, { backgroundColor: t.status === 'PENDING' ? colors.pending : colors.credit }]} />
            <Text style={[styles.statusPillText, { color: t.status === 'PENDING' ? colors.pending : colors.credit }]}>{t.status}</Text>
          </View>
        </View>

        <View style={styles.card}>
          <Row icon="calendar-outline" label="When" value={dateTimeIST(t.occurredAtMs)} />
          <Row icon="card-outline" label="Account" value={accountLabel(t, accounts)} />
          <Row icon="pricetag-outline" label="Category" value={t.category ?? 'Uncategorised'} color={categoryColor(t.category)} />
          <Row icon="swap-horizontal-outline" label="Direction" value={debit ? 'Money out' : 'Money in'} />
          {t.isOwnTransfer && (
            <Row icon="repeat-outline" label="Transfer" value={`Between your own accounts${t.linkedAccountId ? ` (to ${accountLabel({ ...t, accountId: t.linkedAccountId }, accounts)})` : ''} - not counted as spend or income`} />
          )}
          <Row icon="document-text-outline" label="Record shape" value={t.shape === 'legacy' ? 'Legacy bank export' : 'Modern API'} />
          <Row icon="time-outline" label="Last updated" value={t.updatedAtMs != null ? dateTimeIST(t.updatedAtMs) : 'Not provided'} />
          <Row icon="finger-print-outline" label="ID" value={t.id} mono last />
        </View>

        <TouchableOpacity style={styles.rawToggle} onPress={() => { LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut); setShowRaw((v) => !v); }} accessibilityRole="button" accessibilityState={{ expanded: showRaw }}>
          <Ionicons name="code-slash-outline" size={14} color={colors.accent} />
          <Text style={styles.rawToggleText}>{showRaw ? 'Hide' : 'Show'} the exact server record</Text>
          <Ionicons name={showRaw ? 'chevron-up' : 'chevron-down'} size={14} color={colors.accent} />
        </TouchableOpacity>
        {showRaw && <Text style={styles.raw}>{formatRaw(t.raw)}</Text>}
      </ScrollView>
    </View>
  );
}

// The web store keeps no raw payload (raw:''); a bad or missing raw record
// must not crash the screen.
function formatRaw(raw: string): string {
  if (!raw) return 'The verbatim server record is not stored on this platform.';
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function Row({ icon, label, value, color, mono, last }: { icon: keyof typeof Ionicons.glyphMap; label: string; value: string; color?: string; mono?: boolean; last?: boolean }) {
  return (
    <View style={[styles.rowLine, !last && styles.rowLineBorder]}>
      <View style={styles.rowLabelWrap}>
        <Ionicons name={icon} size={13} color={colors.textFaint} />
        <Text style={styles.rowLabel}>{label}</Text>
      </View>
      <Text selectable style={[styles.rowValue, color ? { color } : null, mono ? styles.mono : null]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 20, paddingTop: 20, paddingBottom: 40 },
  gone: { color: colors.textDim, padding: 24, fontSize: 15, fontFamily: fonts.body },
  hero: { alignItems: 'center', paddingVertical: 10 },
  heroBubble: {
    width: 62, height: 62, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center', marginBottom: 14,
    borderWidth: 1, borderColor: colors.border,
  },
  heroBubbleLetter: { fontFamily: fonts.displayHeavy, fontSize: 26 },
  merchant: { color: colors.text, fontSize: 21, fontFamily: fonts.display, textAlign: 'center', letterSpacing: -0.3 },
  amount: { fontSize: 36, fontFamily: fonts.displayHeavy, marginTop: 8, letterSpacing: -1, fontVariant: ['tabular-nums'] },
  fx: { color: colors.textDim, fontSize: 13, fontFamily: fonts.body, marginTop: 8, textAlign: 'center', lineHeight: 18 },
  statusPill: {
    flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 14,
    paddingHorizontal: 11, paddingVertical: 5, borderRadius: radius.pill, borderWidth: 1,
  },
  statusPillPosted: { backgroundColor: 'rgba(46,211,154,0.10)', borderColor: 'rgba(46,211,154,0.25)' },
  statusPillPending: { backgroundColor: 'rgba(245,181,68,0.10)', borderColor: 'rgba(245,181,68,0.25)' },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  statusPillText: { fontSize: 10.5, fontFamily: fonts.bodyBold, letterSpacing: 1.2 },
  card: {
    backgroundColor: colors.card, borderRadius: radius.lg, paddingHorizontal: 16, paddingVertical: 6,
    marginTop: 24, borderWidth: 1, borderColor: colors.borderSoft,
  },
  rowLine: { flexDirection: 'row', justifyContent: 'space-between', gap: 16, paddingVertical: 12, alignItems: 'flex-start' },
  rowLineBorder: { borderBottomWidth: 1, borderBottomColor: colors.borderSoft },
  rowLabelWrap: { flexDirection: 'row', alignItems: 'center', gap: 7, width: 118 },
  rowLabel: { color: colors.textFaint, fontSize: 12.5, fontFamily: fonts.bodyMed },
  rowValue: { color: colors.text, fontSize: 13, fontFamily: fonts.bodyMed, flex: 1, textAlign: 'right', lineHeight: 18 },
  mono: { fontFamily: 'monospace', fontSize: 11, flexShrink: 1 },
  rawToggle: {
    marginTop: 20, paddingVertical: 13, paddingHorizontal: 16, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 8,
    backgroundColor: colors.card, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border,
  },
  rawToggleText: { color: colors.accent, fontSize: 14, fontFamily: fonts.bodySemi },
  raw: {
    color: colors.textDim, fontFamily: 'monospace', fontSize: 11, lineHeight: 16,
    backgroundColor: colors.cardSolid, padding: 14, borderRadius: radius.md, marginTop: 10,
    borderWidth: 1, borderColor: colors.borderSoft,
  },
});
