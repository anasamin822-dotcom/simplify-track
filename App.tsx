import React from 'react';
import { View } from 'react-native';
import { NavigationContainer, DarkTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useFonts, Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold } from '@expo-google-fonts/inter';
import { Sora_600SemiBold, Sora_700Bold, Sora_800ExtraBold } from '@expo-google-fonts/sora';
import { AppProvider } from './src/state/state.tsx';
import TrackScreen from './src/ui/screens/TrackScreen.tsx';
import DetailScreen from './src/ui/screens/DetailScreen.tsx';
import SettingsScreen from './src/ui/screens/SettingsScreen.tsx';
import { colors, fonts } from './src/ui/theme.ts';

const Stack = createNativeStackNavigator();

const navTheme = {
  ...DarkTheme,
  colors: { ...DarkTheme.colors, background: colors.bg, card: colors.bg, text: colors.text, border: colors.border },
};

export default function App() {
  const [loaded] = useFonts({
    Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold,
    Sora_600SemiBold, Sora_700Bold, Sora_800ExtraBold,
  });
  if (!loaded) {
    // One beat of plain background while the two font files unpack; avoids a
    // visible swap from system type to Sora/Inter on launch.
    return <View style={{ flex: 1, backgroundColor: colors.bg }} />;
  }
  return (
    <SafeAreaProvider>
      <AppProvider>
        <NavigationContainer theme={navTheme}>
          <Stack.Navigator
            screenOptions={{
              headerStyle: { backgroundColor: colors.bg },
              headerTintColor: colors.accent,
              headerTitleStyle: { fontFamily: fonts.display, color: colors.text },
              contentStyle: { backgroundColor: colors.bg },
            }}>
            <Stack.Screen name="Track" component={TrackScreen} options={{ headerShown: false }} />
            <Stack.Screen name="Detail" component={DetailScreen} options={{ title: 'Transaction' }} />
            <Stack.Screen name="Settings" component={SettingsScreen} options={{ title: 'Server' }} />
          </Stack.Navigator>
        </NavigationContainer>
      </AppProvider>
    </SafeAreaProvider>
  );
}
