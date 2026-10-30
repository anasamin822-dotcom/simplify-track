import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, RefreshControl, SectionList, StatusBar, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { CanonicalTxn } from '../../core/types.ts';
import { formatINR } from '../../core/money.ts';
import { monthKeyIST, monthLabel, type MonthTotals } from '../../core/totals.ts';
import { useApp } from '../../state/state.tsx';
import { TxnRow } from '../components/TxnRow.tsx';
import { ScreenBackdrop } from '../components/Backdrop.tsx';
import { AnimatedINR } from '../components/AnimatedINR.tsx';
import { colors, fonts, grad, radius } from '../theme.ts';

type Row = { type: 'txn'; t: CanonicalTxn };

// One shared pulse for "something is alive" cues: the sync dot while syncing
// and the skeleton rows on first load. 1.2s breathe, respects nothing fancy.
function usePulse(active: boolean): Animated.Value {
  const v = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!active) { v.setValue(1); return; }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(v, { toValue: 0.35, duration: 600, useNativeDriver: true }),
        Animated.timing(v, { toValue: 1, duration: 600, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [active, v]);
  return v;
}

function SkeletonRows({ pulse }: { pulse: Animated.Value }) {
  return (
    <View style={{ paddingTop: 10 }}>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <Animated.View key={i} style={[styles.skelRow, { opacity: pulse }]}>
          <View style={styles.skelBubble} />
          <View style={{ flex: 1, gap: 8 }}>
            <View style={[styles.skelBar, { width: `${52 + (i * 13) % 30}%` }]} />
            <View style={[styles.skelBar, styles.skelBarDim, { width: `${34 + (i * 17) % 25}%` }]} />
          </View>
          <View style={[styles.skelBar, { width: 58 }]} />
        </Animated.View>
      ))}
    </View>
  );
}

// The headline card: latest month's spend and income with a count-up and a
// slim proportion bar. Pure decoration on top of the same MonthTotals the
// section headers use - one source of truth, no second math.
function HeroCard({ month }: { month: MonthTotals }) {
  const total = month.spendMinor + month.incomeMinor;
  const spendFlex = total > 0 ? Math.max(0.06, month.spendMinor / total) : 0.5;
  return (
    <View style={styles.hero}>
      <LinearGradient colors={['rgba(110,123,255,0.16)', 'rgba(157,107,255,0.05)', 'rgba(110,123,255,0)']}
        start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
      <View style={styles.heroGlow} />
      <Text style={styles.heroEyebrow}>THIS MONTH · {monthLabel(month.month).toUpperCase()}</Text>
      <View style={styles.heroSpendRow}>
        <AnimatedINR minor={month.spendMinor} style={styles.heroSpend} />
        <Text style={styles.heroSpendLabel}>spent</Text>
      </View>
      <View style={styles.heroMetaRow}>
        <View style={styles.heroMetaItem}>
          <Ionicons name="arrow-down" size={12} color={colors.credit} />
          <Text style={styles.heroIncome}><AnimatedINR minor={month.incomeMinor} style={styles.heroIncome} /> in</Text>
        </View>
        <Text style={styles.heroCount}>{month.count.toLocaleString('en-IN')} transactions</Text>
      </View>
      <View style={styles.barTrack}>
        <View style={[styles.barSpend, { flex: spendFlex }]} />
        <View style={[styles.barIncome, { flex: 1 - spendFlex }]} />
      </View>
      {month.pendingCount > 0 && (
        <View style={styles.heroPending}>
          <Ionicons name="time-outline" size={11} color={colors.pending} />
          <Text style={styles.heroPendingText}>{month.pendingCount} pending</Text>
        </View>
      )}
    </View>
  );
}

export default function TrackScreen({ navigation }: NativeStackScreenProps<any>) {
  const { ready, txns, accounts, months, syncing, syncProgress, lastSyncAt, lastSyncError, quarantined, refresh, serverUrl } = useApp();
  const [query, setQuery] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const pulse = usePulse(syncing || !ready);

  const sections = useMemo(() => {
    const byMonth = new Map<string, CanonicalTxn[]>();
    for (const t of txns) {
      const k = monthKeyIST(t.occurredAtMs);
      let arr = byMonth.get(k);
      if (!arr) byMonth.set(k, (arr = []));
      arr.push(t);
    }
    return months.map((m) => ({
      key: m.month,
      title: monthLabel(m.month),
      totals: m,
      data: (byMonth.get(m.month) ?? []).map((t) => ({ type: 'txn' as const, t })),
    }));
  }, [txns, months]);

  const searchResults = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    if (!q) return null;
    return txns.filter((t) => t.merchant.toLocaleLowerCase().includes(q));
  }, [query, txns]);

  const open = useCallback((t: CanonicalTxn) => navigation.navigate('Detail', { id: t.id }), [navigation]);

  const syncLine = syncing
    ? syncProgress || 'Syncing\u2026'
    : lastSyncError
      ? txns.length > 0
        ? 'Offline \u2014 showing saved data'
        : 'Can\u2019t reach the server'
      : lastSyncAt
        ? `Synced ${relative(lastSyncAt)}`
        : 'Not synced yet';

  return (
    <View style={styles.screen}>
      <StatusBar barStyle="light-content" />
      <ScreenBackdrop />
      <View style={styles.header}>
        <View style={styles.headerInner}>
        <View style={styles.titleRow}>
          <View>
            <Text style={styles.wordmark}>Track</Text>
            <View style={styles.syncRow}>
              <Animated.View style={[styles.syncDot, { opacity: syncing ? pulse : 1, backgroundColor: syncing ? colors.pending : lastSyncError ? colors.debit : colors.credit }]} />
              <Text style={styles.syncText} accessibilityLiveRegion="polite">{syncLine}</Text>
            </View>
          </View>
          <TouchableOpacity style={styles.gearBtn} onPress={() => navigation.navigate('Settings')} accessibilityRole="button" accessibilityLabel="Server settings">
            <Ionicons name="settings-outline" size={19} color={colors.textDim} />
          </TouchableOpacity>
        </View>
        {quarantined.count > 0 && (
          <View style={styles.quarantineRow} accessibilityLiveRegion="polite">
            <Ionicons name="warning-outline" size={14} color={colors.pending} style={{ marginTop: 1 }} />
            <Text style={styles.quarantineText}>
              {quarantined.truncated ? `Up to ${quarantined.count}` : quarantined.count} server {quarantined.count === 1 && !quarantined.truncated ? 'record' : 'records'} could not be read and {quarantined.count === 1 && !quarantined.truncated ? 'was' : 'were'} skipped - totals may be incomplete.{quarantined.truncated ? ' A full resync will confirm the exact count.' : ''}
            </Text>
          </View>
        )}
        <View style={[styles.searchBox, searchFocused && styles.searchBoxFocused]}>
          <Ionicons name="search-outline" size={15} color={searchFocused ? colors.accent : colors.textFaint} />
          <TextInput
            style={[styles.searchInput, { outlineStyle: 'none' } as any]}
            placeholder="Search merchant…"
            placeholderTextColor={colors.textFaint}
            value={query}
            onChangeText={setQuery}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel="Search transactions by merchant"
          />
          {query.length > 0 && (
            <TouchableOpacity onPress={() => setQuery('')} hitSlop={8} accessibilityRole="button" accessibilityLabel="Clear search">
              <Ionicons name="close-circle" size={16} color={colors.textFaint} />
            </TouchableOpacity>
          )}
        </View>
        </View>
      </View>

      {!ready || (txns.length === 0 && syncing) ? (
        <View style={{ flex: 1 }}>
          <SkeletonRows pulse={pulse} />
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>{syncProgress || 'Loading\u2026'}</Text>
            <Text style={styles.emptySub}>First sync pulls the whole history from the server. It survives being killed and resumes where it stopped.</Text>
          </View>
        </View>
      ) : txns.length === 0 && lastSyncError ? (
        // Fresh install (or wiped store) with an unreachable server: this is
        // not "offline with saved data" - there is nothing saved. Say what is
        // wrong and where to fix it, since the default address only works on
        // an emulator.
        <View style={styles.empty}>
          <View style={styles.emptyIconWrap}>
            <Ionicons name="cloud-offline-outline" size={26} color={colors.accent} />
          </View>
          <Text style={styles.emptyTitle}>Set up your Track API server</Text>
          <Text style={styles.emptySub}>
            Nothing could be loaded from {serverUrl}. Enter the mock server URL in Server settings, then Save and sync.
          </Text>
          <TouchableOpacity accessibilityRole="button" onPress={() => navigation.navigate('Settings')}>
            <LinearGradient colors={[...grad.accent]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.setupButton}>
              <Text style={styles.setupButtonText}>Open Server settings</Text>
            </LinearGradient>
          </TouchableOpacity>
        </View>
      ) : searchResults ? (
        <SectionList
          style={styles.list}
          sections={[{ key: 'search', title: `${searchResults.length} result${searchResults.length === 1 ? '' : 's'}`, totals: null, data: searchResults.map((t) => ({ type: 'txn' as const, t })) }]}
          keyExtractor={(item: Row) => item.t.id}
          renderItem={({ item }) => <TxnRow t={item.t} accounts={accounts} withYear onPress={open} />}
          renderSectionHeader={({ section }) => <Text style={styles.searchCount}>{section.title}</Text>}
          stickySectionHeadersEnabled={false}
          initialNumToRender={30}
          maxToRenderPerBatch={30}
          windowSize={11}
        />
      ) : (
        <SectionList
          style={styles.list}
          sections={sections}
          keyExtractor={(item: Row) => item.t.id}
          renderItem={({ item }) => <TxnRow t={item.t} accounts={accounts} onPress={open} />}
          ListHeaderComponent={months.length > 0 ? <HeroCard month={months[0]} /> : undefined}
          renderSectionHeader={({ section }) => (
            <View style={styles.monthHeader}>
              <View>
                <Text style={styles.monthTitle}>{section.title}</Text>
                {section.totals && section.totals.pendingCount > 0 && (
                  <Text style={styles.monthPending}>{section.totals.pendingCount} pending</Text>
                )}
              </View>
              <View style={styles.monthTotals}>
                <View style={styles.monthStatRow}>
                  <Ionicons name="arrow-up" size={10.5} color={colors.debit} />
                  <Text style={styles.monthSpend}>{formatINR(section.totals!.spendMinor)}</Text>
                </View>
                <View style={styles.monthStatRow}>
                  <Ionicons name="arrow-down" size={10.5} color={colors.credit} />
                  <Text style={styles.monthIncome}>{formatINR(section.totals!.incomeMinor)}</Text>
                </View>
                {section.totals!.unknownInr.length > 0 && (
                  <Text style={styles.monthUnknown}>+ {section.totals!.unknownInr.length} non-INR not in totals</Text>
                )}
              </View>
            </View>
          )}
          stickySectionHeadersEnabled
          initialNumToRender={25}
          maxToRenderPerBatch={25}
          windowSize={9}
          removeClippedSubviews
          refreshControl={
            <RefreshControl refreshing={syncing && txns.length > 0} onRefresh={() => { void refresh(); }} tintColor={colors.textDim} />
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <View style={styles.emptyIconWrap}>
                <Ionicons name="receipt-outline" size={26} color={colors.accent} />
              </View>
              <Text style={styles.emptyTitle}>No transactions yet</Text>
              <Text style={styles.emptySub}>The server is reachable but returned an empty history.</Text>
            </View>
          }
        />
      )}
    </View>
  );
}

function relative(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  // On tablets and desktop web the content column stays phone-width and
  // centered instead of stretching into a wall of text.
  list: { width: '100%', maxWidth: 760, alignSelf: 'center' },
  header: { paddingTop: 60, paddingHorizontal: 16, paddingBottom: 12 },
  headerInner: { width: '100%', maxWidth: 728, alignSelf: 'center' },
  titleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  wordmark: { color: colors.text, fontSize: 32, fontFamily: fonts.displayHeavy, letterSpacing: -0.8 },
  gearBtn: {
    width: 38, height: 38, borderRadius: 12, marginTop: 2,
    backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center',
  },
  syncRow: { flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 5 },
  syncDot: { width: 7, height: 7, borderRadius: 4 },
  syncText: { color: colors.textDim, fontSize: 12.5, fontFamily: fonts.bodyMed },
  quarantineRow: {
    marginTop: 10, backgroundColor: 'rgba(245,181,68,0.08)', borderRadius: radius.sm,
    padding: 10, borderLeftWidth: 3, borderLeftColor: colors.pending,
    flexDirection: 'row', gap: 8, alignItems: 'flex-start',
  },
  quarantineText: { color: colors.textDim, fontSize: 12, lineHeight: 17, fontFamily: fonts.body, flex: 1 },
  searchBox: {
    marginTop: 14, flexDirection: 'row', alignItems: 'center', gap: 9,
    backgroundColor: colors.card, borderRadius: radius.md, paddingHorizontal: 13,
    borderWidth: 1, borderColor: colors.border,
  },
  searchBoxFocused: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  searchInput: { flex: 1, color: colors.text, fontSize: 15, fontFamily: fonts.body, paddingVertical: 12 },
  hero: {
    marginHorizontal: 14, marginTop: 4, marginBottom: 8, borderRadius: radius.lg,
    padding: 18, overflow: 'hidden',
    backgroundColor: colors.cardSolid, borderWidth: 1, borderColor: colors.border,
  },
  heroGlow: {
    position: 'absolute', width: 220, height: 220, borderRadius: 110,
    top: -110, right: -60, backgroundColor: colors.accent2, opacity: 0.12,
  },
  heroEyebrow: { color: colors.textFaint, fontSize: 10.5, fontFamily: fonts.bodyBold, letterSpacing: 1.6 },
  heroSpendRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8, marginTop: 8 },
  heroSpend: { color: colors.text, fontSize: 34, fontFamily: fonts.displayHeavy, letterSpacing: -1, fontVariant: ['tabular-nums'] },
  heroSpendLabel: { color: colors.textDim, fontSize: 14, fontFamily: fonts.bodyMed },
  heroMetaRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 },
  heroMetaItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  heroIncome: { color: colors.credit, fontSize: 13.5, fontFamily: fonts.displayMid, fontVariant: ['tabular-nums'] },
  heroCount: { color: colors.textFaint, fontSize: 12, fontFamily: fonts.bodyMed },
  barTrack: {
    flexDirection: 'row', height: 6, borderRadius: 3, overflow: 'hidden',
    backgroundColor: 'rgba(148,163,255,0.10)', marginTop: 14, gap: 2,
  },
  barSpend: { backgroundColor: colors.debit, borderRadius: 3 },
  barIncome: { backgroundColor: colors.credit, borderRadius: 3 },
  heroPending: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 10 },
  heroPendingText: { color: colors.pending, fontSize: 11.5, fontFamily: fonts.bodySemi },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  emptyIconWrap: {
    width: 56, height: 56, borderRadius: 18, marginBottom: 16,
    backgroundColor: colors.accentSoft, borderWidth: 1, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center',
  },
  setupButton: { marginTop: 22, borderRadius: radius.md, paddingVertical: 13, paddingHorizontal: 22 },
  setupButtonText: { color: '#fff', fontSize: 15, fontFamily: fonts.bodyBold },
  emptyTitle: { color: colors.text, fontSize: 16, fontFamily: fonts.displayMid, textAlign: 'center' },
  emptySub: { color: colors.textDim, fontSize: 13, fontFamily: fonts.body, textAlign: 'center', marginTop: 10, lineHeight: 19 },
  monthHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end',
    paddingHorizontal: 16, paddingTop: 18, paddingBottom: 9,
    backgroundColor: '#070B15', borderBottomWidth: 1, borderBottomColor: colors.borderSoft,
  },
  monthTitle: { color: colors.text, fontSize: 16.5, fontFamily: fonts.display, letterSpacing: -0.2 },
  monthPending: { color: colors.pending, fontSize: 11, fontFamily: fonts.bodySemi, marginTop: 2 },
  monthTotals: { alignItems: 'flex-end', gap: 2 },
  monthStatRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  monthSpend: { color: colors.debit, fontSize: 12.5, fontFamily: fonts.displayMid, fontVariant: ['tabular-nums'] },
  monthIncome: { color: colors.credit, fontSize: 12.5, fontFamily: fonts.displayMid, fontVariant: ['tabular-nums'] },
  monthUnknown: { color: colors.textFaint, fontSize: 10.5, fontFamily: fonts.body },
  searchCount: { color: colors.textDim, fontSize: 12.5, fontFamily: fonts.bodyMed, paddingHorizontal: 16, paddingVertical: 10 },
  skelRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    marginHorizontal: 14, marginVertical: 4, paddingHorizontal: 13, paddingVertical: 14,
    backgroundColor: colors.card, borderRadius: radius.md, borderWidth: 1, borderColor: colors.borderSoft,
  },
  skelBubble: { width: 38, height: 38, borderRadius: 12, backgroundColor: colors.cardAlt },
  skelBar: { height: 11, borderRadius: 6, backgroundColor: colors.cardAlt },
  skelBarDim: { height: 9, opacity: 0.6 },
});
