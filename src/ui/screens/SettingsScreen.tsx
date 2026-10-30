import React, { useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useApp } from '../../state/state.tsx';
import { validateServerUrl } from '../../core/api.ts';
import { ScreenBackdrop } from '../components/Backdrop.tsx';
import { colors, fonts, grad, radius } from '../theme.ts';

// Where the mock server lives. Android emulator: 10.0.2.2; a real phone needs
// the computer's LAN IP (the mock server prints it on startup).
export default function SettingsScreen() {
  const { serverUrl, setServerUrl, refresh, syncing, syncProgress, lastSyncAt, lastSyncError, serverSwitchPending, confirmServerSwitch, dismissServerSwitch } = useApp();
  const [draft, setDraft] = useState(serverUrl);
  const [urlError, setUrlError] = useState<string | null>(null);
  return (
    <View style={styles.screen}>
      <ScreenBackdrop />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.label}>Track API server</Text>
        <View style={styles.inputWrap}>
          <Ionicons name="link-outline" size={15} color={colors.textFaint} />
          <TextInput
            style={[styles.input, { outlineStyle: 'none' } as any]}
            value={draft}
            onChangeText={setDraft}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            accessibilityLabel="Server URL"
            placeholderTextColor={colors.textFaint}
          />
        </View>
        <Text style={styles.hint}>
          Emulator: http://10.0.2.2:4010{'\n'}Dev build, same Wi-Fi: http://{'<'}computer LAN IP{'>'}:4010{'\n'}Release APK: use the https:// server URL
        </Text>
        <TouchableOpacity
          accessibilityRole="button"
          disabled={syncing}
          onPress={async () => {
            const invalid = validateServerUrl(draft);
            setUrlError(invalid);
            if (invalid) return;
            await setServerUrl(draft.trim());
            await refresh();
          }}>
          <LinearGradient colors={[...grad.accent]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
            style={[styles.button, syncing && styles.buttonDisabled]}>
            <Text style={styles.buttonText}>{syncing ? 'Syncing\u2026' : 'Save and sync'}</Text>
          </LinearGradient>
        </TouchableOpacity>
        {urlError ? (
          <View style={styles.errorRow}>
            <Ionicons name="warning-outline" size={14} color={colors.debit} />
            <Text style={styles.errorText}>{urlError}</Text>
          </View>
        ) : null}
        {serverSwitchPending && !syncing ? (
          <View style={styles.switchBox}>
            <View style={styles.switchTitleRow}>
              <Ionicons name="alert-circle-outline" size={17} color={colors.pending} />
              <Text style={styles.switchTitle}>History not recognised</Text>
            </View>
            <Text style={styles.switchBody}>
              {serverSwitchPending.previousUrl
                ? `This server does not recognise the history synced from ${serverSwitchPending.previousUrl}.`
                : 'This server does not recognise the history on this device; its original source was never recorded.'}
              {'\n\n'}Nothing has been changed or deleted yet. Replace downloads this server's history first, then swaps it in as one step. If the download fails or is interrupted, nothing changes.{'\n\n'}
              {serverSwitchPending.previousUrl
                ? 'Keep restores the old server URL and changes nothing.'
                : 'Keep changes nothing. Sync with this server will keep asking until you replace or enter the URL the history came from.'}
            </Text>
            <TouchableOpacity accessibilityRole="button" onPress={confirmServerSwitch}>
              <LinearGradient colors={[...grad.accent]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.button}>
                <Text style={styles.buttonText}>Replace with this server</Text>
              </LinearGradient>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.buttonFlat]} accessibilityRole="button" onPress={dismissServerSwitch}>
              <Text style={styles.buttonFlatText}>Keep my history</Text>
            </TouchableOpacity>
          </View>
        ) : null}
        {syncing && (
          <View style={styles.statusRow}>
            <ActivityIndicator color={colors.accent} />
            <Text style={styles.statusText}>{syncProgress || 'Starting sync\u2026'}</Text>
          </View>
        )}
        {!syncing && lastSyncError ? (
          <View style={styles.errorRow}>
            <Ionicons name="cloud-offline-outline" size={14} color={colors.debit} />
            <Text style={styles.errorText}>Sync failed: {lastSyncError}</Text>
          </View>
        ) : null}
        {!syncing && !lastSyncError && lastSyncAt ? (
          <View style={styles.statusRow}>
            <Ionicons name="checkmark-circle" size={15} color={colors.credit} />
            <Text style={styles.okText}>Last sync OK: {new Date(lastSyncAt).toLocaleTimeString()}</Text>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 20, paddingTop: 20, paddingBottom: 40 },
  label: { color: colors.textDim, fontSize: 13, fontFamily: fonts.bodySemi, marginBottom: 9, letterSpacing: 0.2 },
  inputWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 9,
    backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border,
    borderRadius: radius.md, paddingHorizontal: 13,
  },
  input: { flex: 1, color: colors.text, paddingVertical: 12, fontSize: 14, fontFamily: fonts.body },
  hint: { color: colors.textFaint, fontSize: 12, fontFamily: fonts.body, marginTop: 10, lineHeight: 18 },
  button: { borderRadius: radius.md, paddingVertical: 13, alignItems: 'center', marginTop: 20 },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: '#fff', fontFamily: fonts.bodyBold, fontSize: 15 },
  buttonFlat: {
    borderRadius: radius.md, paddingVertical: 13, alignItems: 'center', marginTop: 10,
    backgroundColor: colors.cardAlt, borderWidth: 1, borderColor: colors.border,
  },
  buttonFlatText: { color: colors.text, fontFamily: fonts.bodyBold, fontSize: 15 },
  statusRow: { flexDirection: 'row', alignItems: 'center', marginTop: 16, gap: 10 },
  statusText: { color: colors.textDim, fontSize: 13, fontFamily: fonts.body, flex: 1 },
  errorRow: { flexDirection: 'row', alignItems: 'flex-start', marginTop: 16, gap: 8 },
  errorText: { color: colors.debit, fontSize: 13, fontFamily: fonts.body, lineHeight: 19, flex: 1 },
  okText: { color: colors.textDim, fontSize: 13, fontFamily: fonts.body, flex: 1 },
  switchBox: {
    marginTop: 20, padding: 15, backgroundColor: 'rgba(245,181,68,0.06)',
    borderRadius: radius.md, borderWidth: 1, borderColor: 'rgba(245,181,68,0.25)',
  },
  switchTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  switchTitle: { color: colors.text, fontFamily: fonts.displayMid, fontSize: 15.5 },
  switchBody: { color: colors.textDim, fontSize: 13, fontFamily: fonts.body, lineHeight: 19 },
});
