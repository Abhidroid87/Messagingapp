import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, processLock } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

// Get Supabase credentials from environment variables
const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

// Warn when credentials missing
if (!supabaseUrl || !supabaseKey) {
  console.warn('Supabase credentials are missing in environment variables. Using fallback configuration for development.');
}

// Create client with React Native-friendly auth storage (AsyncStorage)
export const supabase = createClient<Database>(
  supabaseUrl || 'https://placeholder.supabase.co',
  supabaseKey || 'placeholder-key',
  {
    auth: {
      // Important for React Native / Expo: use AsyncStorage so sessions persist across restarts
      storage: AsyncStorage,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
      lock: processLock
    },
    db: {
      schema: 'public'
    }
  }
);
