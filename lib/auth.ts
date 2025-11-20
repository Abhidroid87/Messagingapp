import { supabase } from './supabase';
import { EncryptionManager } from './encryption';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { markActive } from './activity';

/**
 * Simplified anonymous-only AuthManager.
 * - Always uses supabase.auth.signInAnonymously()
 * - App is responsible for creating the profiles row (no DB trigger reliance)
 * - Generates username, short user_id, and stores keypair locally
 */

export interface UserProfile {
  id: string;            // uuid == auth.users.id
  user_id?: number;      // bigint (8-digit app id for QR) - optional at first
  username?: string;
  gender?: string;
  bio?: string;
  public_key?: string;
  created_at?: string;
  updated_at?: string;
  last_activity?: string;
  token?: string; // invite token / shareable uuid
}

export class AuthManager {
  private static instance: AuthManager;
  private currentUser: UserProfile | null = null;
  private encryptionManager: EncryptionManager;
  private refreshTimer: NodeJS.Timeout | null = null;

  private constructor() {
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

  private async generateUniqueUserId(): Promise<number> {
    let attempts = 0;
    while (attempts < 10) {
      const id = this.generateUserId();
      try {
        const { data } = await supabase.from('profiles').select('user_id').eq('user_id', id).maybeSingle();
        if (!data) return id;
      } catch (e) {
        // ignore and retry
      }
      attempts++;
    }
    throw new Error('Unable to generate unique user ID. Please try again.');
  }

  private generateRandomUsername(): string {
    const adjectives = ['cool','fast','silent','bright','dark','happy','red','blue','green'];
    const animals = ['tiger','wolf','lion','hawk','eagle','panther','fox','bear','shark'];
    const adj = adjectives[Math.floor(Math.random()*adjectives.length)];
    const animal = animals[Math.floor(Math.random()*animals.length)];
    const num = Math.floor(Math.random()*900)+100;
    return `${adj}_${animal}_${num}`;
  }

  // Ensure auth session exists (anonymous sign-in)
  private async ensureAuthSession(): Promise<string> {
    const { data: { session } } = await supabase.auth.getSession();
    if (session?.user?.id) return session.user.id;

    const { data, error } = await supabase.auth.signInAnonymously();
    if (error || !data?.user) {
      throw new Error(`Failed to start auth session: ${error?.message || 'Unknown error'}`);
    }
    return data.user.id;
  }

  // Create profile row in DB (app-driven)
  private async createProfileForAuthUser(authUid: string): Promise<UserProfile> {
    // generate keys and identifiers
    const keyPair = this.encryptionManager.generateKeyPair();
    if (!keyPair?.publicKey || !keyPair?.privateKey) {
      throw new Error('Failed to generate key pair');
    }
    const appUserId = await this.generateUniqueUserId();
    const username = this.generateRandomUsername();
    const token = (crypto && (crypto as any).randomUUID) ? (crypto as any).randomUUID() : ('tk_' + Date.now().toString(36) + Math.random().toString(36).slice(2,8));

    const payload: Partial<UserProfile> = {
      id: authUid,
      user_id: appUserId,
      username,
      public_key: keyPair.publicKey,
      token,
      created_at: new Date().toISOString()
    };

    const { data: created, error: insertErr } = await supabase
      .from('profiles')
      .insert(payload)
      .select()
      .single();

    if (insertErr || !created) {
      throw new Error(`Failed to create user profile: ${insertErr?.message || 'Unknown error'}`);
    }

    // persist private key + profile locally
    await AsyncStorage.multiSet([
      ['private_key', keyPair.privateKey],
      ['user_profile', JSON.stringify(created)]
    ]);

    // set local encryption manager private key
    this.encryptionManager.setKeyPair({ publicKey: created.public_key, privateKey: keyPair.privateKey });

    return created as UserProfile;
  }

  // Fetch profile
  private async fetchProfile(authUid: string): Promise<UserProfile | null> {
    const { data, error } = await supabase.from('profiles').select('*').eq('id', authUid).maybeSingle();
    if (error) {
      console.warn('fetchProfile error', error);
      return null;
    }
    return data as UserProfile || null;
  }

  private startSessionRefresh(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = setInterval(async () => {
      if (this.currentUser) await this.updateLastActivity(this.currentUser.id!);
    }, 24 * 60 * 60 * 1000);
  }

  // --- public api ------------------------------------------------------------

  // Legacy alias for compatibility (register -> signInAndEnsureProfile)
  async register(): Promise<UserProfile> {
    return await this.signInAndEnsureProfile();
  }


  // Sign in (anonymous) and ensure profile exists (app-managed)
  async signInAndEnsureProfile(): Promise<UserProfile> {
    const authUid = await this.ensureAuthSession();

    // fetch existing
    const existing = await this.fetchProfile(authUid);
    if (existing) {
      this.currentUser = existing;
      // restore private key if stored
      const privateKey = await AsyncStorage.getItem('private_key');
      if (privateKey) this.encryptionManager.setKeyPair({ publicKey: (existing as any).public_key, privateKey });
      await AsyncStorage.setItem('user_session', JSON.stringify({ profile: existing, timestamp: Date.now(), expiresAt: Date.now() + 30*24*3600*1000 }));
      this.startSessionRefresh();
      await markActive(authUid).catch(()=>{});
      return existing;
    }

    // create new profile (app controlled)
    const created = await this.createProfileForAuthUser(authUid);
    this.currentUser = created;
    await AsyncStorage.setItem('user_session', JSON.stringify({ profile: created, timestamp: Date.now(), expiresAt: Date.now() + 30*24*3600*1000 }));
    this.startSessionRefresh();
    await markActive(authUid).catch(()=>{});
    return created;
  }

  // Restore user from existing auth session (no profile creation)
  async loginWithSession(): Promise<UserProfile | null> {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.user?.id) return null;
    const profile = await this.fetchProfile(session.user.id);
    if (!profile) return null;
    this.currentUser = profile;
    const privateKey = await AsyncStorage.getItem('private_key');
    if (privateKey) this.encryptionManager.setKeyPair({ publicKey: (profile as any).public_key, privateKey });
    await markActive(profile.id).catch(()=>{});
    this.startSessionRefresh();
    return profile;
  }

  getCurrentUser(): UserProfile | null {
    return this.currentUser;
  }

  async getCurrentUserSafe(): Promise<UserProfile> {
    if (!this.currentUser) {
      throw new Error('No authenticated user. Please log in first.');
    }
    return this.currentUser;
  }

  async deleteProfile(): Promise<void> {
    if (!this.currentUser) {
      throw new Error('No authenticated user');
    }

    try {
      // Delete profile from database
      const { error } = await supabase
        .from('profiles')
        .delete()
        .eq('id', this.currentUser.id);

      if (error) {
        throw new Error(`Failed to delete profile: ${error.message}`);
      }

      // Sign out and clear local data
      await this.logout();
    } catch (error) {
      console.error('Delete profile error:', error);
      throw error;
    }
  }

  async updateLastActivity(profileId: string): Promise<void> {
    try {
      await supabase.rpc('update_last_activity', { profile_id: profileId });
    } catch (e) {
      console.warn('updateLastActivity failed (non-fatal):', e);
    }
  }

  async logout(): Promise<void> {
    try {
      if (this.refreshTimer) {
        clearInterval(this.refreshTimer);
        this.refreshTimer = null;
      }
      await supabase.auth.signOut();
      await AsyncStorage.multiRemove(['user_session','private_key','user_profile']);
      this.currentUser = null;
      this.encryptionManager.clearKeys();
    } catch (e) {
      console.warn('logout failed', e);
    }
  }
}

const authManager = AuthManager.getInstance();
export default authManager;


// Compatibility helper: static-like register()
export async function register(): Promise<UserProfile> {
  return await AuthManager.getInstance().signInAndEnsureProfile();
}
