import { supabase } from './supabase';
import { EncryptionManager } from './encryption';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { markActive } from './activity';

/**
 * IMPORTANT ALIGNMENT NOTES
 * - We now rely on REAL Supabase Auth (anonymous sign-in) so RLS policies that use auth.uid() will pass.
 * - profiles.id == auth.users.id (uuid). We still keep profiles.user_id (bigint) for QR/lookup.
 * - Session persistence is handled by supabase-js using AsyncStorage (make sure your Supabase client is configured accordingly).
 */

export interface UserProfile {
  id: string;            // uuid == auth.users.id
  user_id: number;       // bigint (8-digit app id for QR)
  username: string;
  gender?: string;
  bio?: string;
  public_key: string;
  created_at: string;
  updated_at: string;
  last_activity: string;
}

export class AuthManager {
  private static instance: AuthManager;
  private currentUser: UserProfile | null = null;
  private encryptionManager: EncryptionManager;
  private refreshTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.encryptionManager = EncryptionManager.getInstance();
  }

  static getInstance(): AuthManager {
    if (!AuthManager.instance) {
      AuthManager.instance = new AuthManager();
    }
    return AuthManager.instance;
  }

  // --- helpers ---------------------------------------------------------------

  // Generate 8-digit app id
  private generateUserId(): number {
    return Math.floor(10000000 + Math.random() * 90000000);
  }

  private validateUsername(username: string): void {
    if (!username || username.length < 3) throw new Error('Username must be at least 3 characters');
    if (username.length > 20) throw new Error('Username must be less than 20 characters');
    if (!/^[a-zA-Z0-9_]+$/.test(username)) throw new Error('Username can only contain letters, numbers, underscores');
  }

  private async generateUniqueUserId(): Promise<number> {
    let attempts = 0;
    while (attempts < 10) {
      const id = this.generateUserId();
      const { data } = await supabase.from('profiles').select('user_id').eq('user_id', id).maybeSingle();
      if (!data) return id;
      attempts++;
    }
    throw new Error('Unable to generate unique user ID. Please try again.');
  }

  private async ensureAuthSession(): Promise<string> {
    // Returns auth.uid(); signs in anonymously if needed.
    const { data: { session } } = await supabase.auth.getSession();
    if (session?.user?.id) return session.user.id;

    const { data, error } = await supabase.auth.signInAnonymously();
    if (error || !data.user) {
      throw new Error(`Failed to start auth session: ${error?.message || 'Unknown error'}`);
    }
    return data.user.id;
  }

  private async createOrFetchProfileForAuthUser(authUid: string, username?: string, gender?: string, bio?: string): Promise<UserProfile> {
    // Try fetch existing
    const { data: existing, error: fetchErr } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', authUid)
      .maybeSingle();

    if (fetchErr) {
      console.warn('profiles fetch error:', fetchErr);
    }
    if (existing) return existing as UserProfile;

    // Need username for new profile
    if (!username) throw new Error('Username required to create profile');

    const keyPair = this.encryptionManager.generateKeyPair();
    if (!keyPair?.publicKey || !keyPair?.privateKey) throw new Error('Failed to generate key pair');

    const appUserId = await this.generateUniqueUserId();

    const { data: created, error: insertErr } = await supabase
      .from('profiles')
      .insert({
        id: authUid,             // IMPORTANT: link to auth.users.id
        user_id: appUserId,
        username,
        gender,
        bio,
        public_key: keyPair.publicKey,
      })
      .select()
      .single();

    if (insertErr || !created) {
      throw new Error(`Failed to create user profile: ${insertErr?.message || 'Unknown error'}`);
    }

    // Persist keys + profile locally
    await AsyncStorage.multiSet([
      ['private_key', keyPair.privateKey],
      ['user_profile', JSON.stringify(created)],
    ]);

    return created as UserProfile;
  }

  private startSessionRefresh(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = setInterval(async () => {
      if (this.currentUser) await this.updateLastActivity(this.currentUser.id);
    }, 24 * 60 * 60 * 1000);
  }

  // --- public api ------------------------------------------------------------

  /**
   * Register (or init) the user:
   * - Ensures a Supabase Auth session (anonymous sign-in).
   * - Creates a profile row if it doesn't exist (id == auth.uid()).
   * - Generates & stores encryption keys.
   */
  async register(username: string, gender?: string, bio?: string): Promise<UserProfile> {
    this.validateUsername(username);

    // Ensure auth session (anonymous)
    const authUid = await this.ensureAuthSession();

    // Create or fetch profile bound to authUid
    const profile = await this.createOrFetchProfileForAuthUser(authUid, username, gender, bio);

    // Store a lightweight app session (optional, for UI restore)
    const sessionStamp = {
      profile,
      timestamp: Date.now(),
      // 30 days soft expiration for local UI; auth session is handled by supabase-js
      expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
    };
    await AsyncStorage.setItem('user_session', JSON.stringify(sessionStamp));

    this.currentUser = profile;
    this.startSessionRefresh();
    return profile;
  }

  /**
   * Restore user from Supabase auth session.
   * If a profile does not exist for the auth user, returns null (call register to create).
   */
  async loginWithSession(): Promise<UserProfile | null> {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.user?.id) return null;

    // Fetch profile by auth uid
    const { data: profile, error } = await supabase.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
    if (error) {
      console.warn('loginWithSession: profile fetch error', error);
      return null;
    }
    if (!profile) {
      // Auth exists but profile missing – user must go through register(username)
      return null;
    }

    // Restore private key if stored
    const privateKey = await AsyncStorage.getItem('private_key');
    if (privateKey) {
      this.encryptionManager.setKeyPair({ publicKey: (profile as any).public_key, privateKey });
    }

    // Update activity + local stamp
    await this.updateLastActivity(session.user.id);
    await AsyncStorage.setItem('user_session', JSON.stringify({ profile, timestamp: Date.now(), expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000 }));

    this.currentUser = profile as UserProfile;
    this.startSessionRefresh();
    return this.currentUser;
  }

  async updateLastActivity(profileId: string): Promise<void> {
    try {
      await supabase.rpc('update_last_activity', { profile_id: profileId });
    } catch (e) {
      console.warn('updateLastActivity failed (non-fatal):', e);
    }
  }

  getCurrentUser(): UserProfile | null {
    return this.currentUser;
  }

  async logout(): Promise<void> {
    try {
      if (this.refreshTimer) {
        clearInterval(this.refreshTimer);
        this.refreshTimer = null;
      }
      await supabase.auth.signOut(); // clear supabase session
      await AsyncStorage.multiRemove(['user_session', 'private_key', 'user_profile']);
      this.currentUser = null;
      this.encryptionManager.clearKeys();
    } catch (error) {
      throw new Error(`Logout failed: ${error}`);
    }
  }
}