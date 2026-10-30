import React, { useRef } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import type { Account, CanonicalTxn } from '../../core/types.ts';
import { formatAmount, formatINR } from '../../core/money.ts';
import { categoryColor, categoryLetter, categoryTint, colors, fonts, radius } from '../theme.ts';
import { accountLabel, cleanMerchant, dayLabelIST, timeIST } from '../display.ts';

interface Props {
  t: CanonicalTxn;
  accounts: Map<string, Account>;
  withYear?: boolean; // search results span the whole year - say which one
  onPress(t: CanonicalTxn): void;
}

function TxnRowInner({ t, accounts, withYear, onPress }: Props) {
  const transfer = t.isOwnTransfer;
  const debit = t.direction === 'debit';
  const amountColor = transfer ? colors.transfer : debit ? colors.debit : colors.credit;
  const amountText = transfer
    ? formatAmount(t)
    : formatINR(t.amountMinor, { sign: debit ? 'debit' : 'credit' });
  const scale = useRef(new Animated.Value(1)).current;
  const press = (to: number) =>
    Animated.spring(scale, { toValue: to, useNativeDriver: true, speed: 40, bounciness: 0 }).start();
  return (
    <Pressable onPress={() => onPress(t)} onPressIn={() => press(0.975)} onPressOut={() => press(1)}
      accessibilityRole="button"
      accessibilityLabel={`${cleanMerchant(t.merchant)}, ${amountText}${t.status === 'PENDING' ? ', pending' : ''}`}>
      <Animated.View style={[styles.row, { transform: [{ scale }] }]}>
        <View style={[styles.bubble, { backgroundColor: categoryTint(t.category) }]}>
          <Text style={[styles.bubbleLetter, { color: categoryColor(t.category) }]}>{categoryLetter(t.category)}</Text>
        </View>
        <View style={styles.mid}>
          <Text style={styles.merchant} numberOfLines={1}>{cleanMerchant(t.merchant)}</Text>
          <Text style={styles.sub} numberOfLines={1}>
            {dayLabelIST(t.occurredAtMs)}{withYear ? ` ${new Date(t.occurredAtMs + 19800000).getUTCFullYear()}` : ''} · {timeIST(t.occurredAtMs)} · {accountLabel(t, accounts)}
            {transfer ? ' · Transfer' : ''}
          </Text>
        </View>
        <View style={styles.right}>
          <Text style={[styles.amount, { color: amountColor }]}>{amountText}</Text>
          {t.currency !== 'INR' && t.inrMinor != null && (
            <Text style={styles.fx}>= {formatINR(t.inrMinor)}</Text>
          )}
          {t.status === 'PENDING' && (
            <View style={styles.badge}><Text style={styles.badgeText}>PENDING</Text></View>
          )}
        </View>
      </Animated.View>
    </Pressable>
  );
}

export const TxnRow = React.memo(TxnRowInner);

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    marginHorizontal: 14, marginVertical: 4,
    paddingHorizontal: 13, paddingVertical: 12,
    backgroundColor: colors.card, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.borderSoft,
  },
  bubble: {
    width: 38, height: 38, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
  },
  bubbleLetter: { fontFamily: fonts.display, fontSize: 15 },
  mid: { flex: 1 },
  merchant: { color: colors.text, fontSize: 15, fontFamily: fonts.bodySemi, letterSpacing: -0.1 },
  sub: { color: colors.textFaint, fontSize: 12, fontFamily: fonts.body, marginTop: 3 },
  right: { alignItems: 'flex-end' },
  amount: { fontSize: 15, fontFamily: fonts.display, fontVariant: ['tabular-nums'] },
  fx: { color: colors.textFaint, fontSize: 11, fontFamily: fonts.body, marginTop: 2 },
  badge: {
    marginTop: 4, backgroundColor: 'rgba(245,181,68,0.14)', borderRadius: 5,
    paddingHorizontal: 6, paddingVertical: 2,
    borderWidth: 1, borderColor: 'rgba(245,181,68,0.25)',
  },
  badgeText: { color: colors.pending, fontSize: 9, fontFamily: fonts.bodyBold, letterSpacing: 0.6 },
});
