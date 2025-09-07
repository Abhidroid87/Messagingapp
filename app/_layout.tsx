// --- Polyfills & shims ---
import 'react-native-get-random-values';
import { decode, encode } from 'base-64';
import * as Crypto from 'expo-crypto';
import 'react-native-url-polyfill/auto';

// --- React / RN imports ---
import { AppState } from 'react-native';
import { useEffect } from 'react';

// --- Project imports ---
import { markActive } from '../lib/activity'; // ⬅ adjust path if lib is in app/
import { AuthProvider, useAuth } from '@/contexts/AuthContext';
import { useFrameworkReady } from '@/hooks/useFrameworkReady';

// --- Expo Router ---
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

// ----------------------------
// Component to track activity
// ----------------------------
function ActivityTracker() {
  const { profile } = useAuth();

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active' && profile?.id) {
        markActive(profile.id);
      }
    });

    return () => subscription.remove();
  }, [profile?.id]);

  return null;
}

// ----------------------------
// Root Layout (single export)
// ----------------------------
export default function RootLayout() {
  useFrameworkReady();

  return (
    <AuthProvider>
      <ActivityTracker />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(auth)" options={{ headerShown: false }} />
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="+not-found" />
      </Stack>
      <StatusBar style="auto" />
    </AuthProvider>
  );
}

// ----------------------------
// Extra Polyfills (crypto)
// ----------------------------
if (!global.atob) global.atob = decode;
if (!global.btoa) global.btoa = encode;

if (!global.crypto) {
  global.crypto = {
    getRandomValues: (array: Uint8Array) => {
      try {
        const randomBytes = Crypto.getRandomBytes(array.length);
        array.set(randomBytes);
        return array;
      } catch (error) {
        console.warn('Expo crypto failed, using fallback:', error);
        for (let i = 0; i < array.length; i++) {
          array[i] = Math.floor(Math.random() * 256);
        }
        return array;
      }
    },
    subtle: {
      digest: async (_algorithm: string, data: ArrayBuffer) => {
        const uint8Array = new Uint8Array(data);
        const hex = Array.from(uint8Array, b => b.toString(16).padStart(2, '0')).join('');
        return new TextEncoder().encode(hex).buffer;
      },
    },
  } as any;
}
