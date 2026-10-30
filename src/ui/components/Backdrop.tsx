import React from 'react';
import { StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { colors, grad } from '../theme.ts';

// Deep-space base with two soft light blooms. Pure views and one gradient so
// it costs nothing to render behind a long list.
export function ScreenBackdrop() {
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <LinearGradient colors={[...grad.screen]} style={StyleSheet.absoluteFill} />
      <View style={[styles.bloom, styles.bloomAccent]} />
      <View style={[styles.bloom, styles.bloomViolet]} />
    </View>
  );
}

const styles = StyleSheet.create({
  bloom: { position: 'absolute', width: 340, height: 340, borderRadius: 170 },
  bloomAccent: { top: -150, left: -110, backgroundColor: colors.accent, opacity: 0.13 },
  bloomViolet: { top: -90, right: -160, backgroundColor: colors.accent2, opacity: 0.10 },
});
