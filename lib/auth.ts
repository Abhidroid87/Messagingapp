import { supabase } from './supabase';
import { EncryptionManager } from './encryption';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { markActive } from './activity';

export interface UserProfile {
  id: string;
  user_id: number;
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

  // Helper: Generate unique 8-digit user ID
  private generateUserId(): number {
    return Math.floor(10000000 + Math.random() * 90000000);
  }

  // Helper: Validate username format
  private validateUsername(username: string): void {
    if (!username || username.length < 3) {
      throw new Error('Username must be at least 3 characters long');
    }
    if (username.length > 20) {
      throw new Error('Username must be less than 20 characters');
    }
    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      throw new Error('Username can only contain letters, numbers, and underscores');
    }
  }

  // Helper: Generate unique user ID with collision checking
  private async generateUniqueUserId(): Promise<number> {
    try {
      let attempts = 0;
      const maxAttempts = 10;

      while (attempts < maxAttempts) {
        const userId = this.generateUserId();
        
        const { data: existingId } = await supabase
          .from('profiles')
          .select('user_id')
          .eq('user_id', userId)
          .single();

        if (!existingId) {
          return userId;
        }
        
        attempts++;
      }

      throw new Error('Unable to generate unique user ID. Please try again.');
    } catch (error) {
      console.warn('Database not available for ID checking, using random ID');
      return this.generateUserId();
    }
  }

  // Helper: Create profile in database
  private async createProfileInDatabase(
    userId: number,
    username: string,
    publicKey: string,
    gender?: string,
    bio?: string
  ): Promise<UserProfile> {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .insert({
          user_id: userId,
          username,
          gender,
          bio,
          public_key: publicKey,
        })
        .select()
        .single();

      if (error) {
        console.error('Profile creation error:', error);
        if (error.code === 'PGRST116') {
          throw new Error('Unable to connect to database. Please check your internet connection.');
        } else if (error.message?.includes('duplicate')) {
          throw new Error('Username or ID already exists. Please try again.');
        } else {
          throw new Error('Failed to create user profile. Please try again.');
        }
      }

      if (!data) {
        throw new Error('Failed to create user profile. Please try again.');
      }

      return data;
    } catch (error) {
      console.warn('Database not available, creating local profile:', error);
      
      const mockProfile: UserProfile = {
        id: `mock_${userId}`,
        user_id: userId,
        username,
        gender,
        bio,
        public_key: publicKey,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        last_activity: new Date().toISOString(),
      };

      return mockProfile;
    }
  }

  // Helper: Store credentials locally with encryption
  private async storeCredentials(profile: UserProfile, privateKey: string): Promise<void> {
    const sessionData = {
      profile,
      timestamp: Date.now(),
      expiresAt: Date.now() + (30 * 24 * 60 * 60 * 1000) // 30 days
    };

    await AsyncStorage.multiSet([
      ['user_session', JSON.stringify(sessionData)],
      ['private_key', privateKey],
      ['user_profile', JSON.stringify(profile)]
    ]);
  }

  // Helper: Start session refresh timer
  private startSessionRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }

    // Refresh session every 24 hours
    this.refreshTimer = setInterval(async () => {
      if (this.currentUser) {
        await this.updateLastActivity(this.currentUser.id);
      }
    }, 24 * 60 * 60 * 1000);
  }

  // Register new user
  async register(username: string, gender?: string, bio?: string): Promise<UserProfile> {
    try {
      this.validateUsername(username);

      // Generate encryption keys with proper entropy
      const keyPair = this.encryptionManager.generateKeyPair();
      if (!keyPair || !keyPair.publicKey || !keyPair.privateKey) {
        throw new Error('Failed to generate security keys.');
      }

      const userId = await this.generateUniqueUserId();
      const profile = await this.createProfileInDatabase(
        userId,
        username,
        keyPair.publicKey,
        gender,
        bio
      );

      await this.storeCredentials(profile, keyPair.privateKey);
      this.currentUser = profile;
      this.startSessionRefresh();

      return profile;
    } catch (error) {
      console.error('Registration error:', error);
      if (error instanceof Error) {
        throw error;
      } else {
        throw new Error('Registration failed due to an unexpected error. Please try again.');
      }
    }
  }

  // Login with stored session
  async loginWithSession(): Promise<UserProfile | null> {
    try {
      // Check for active Supabase session
      const { data: { session }, error: sessionError } = await supabase.auth.getSession();
      
      if (sessionError) {
        console.error('Session error:', sessionError);
        await this.logout();
        return null;
      }

      if (!session || !session.user) {
        console.log('No active session found');
        await this.logout();
        return null;
      }

      const user = session.user;
      
      const sessionData = await AsyncStorage.getItem('user_session');
      const privateKey = await AsyncStorage.getItem('private_key');

      if (!sessionData || !privateKey) {
        console.log('No local session data found');
        return null;
      }

      const session = JSON.parse(sessionData);
      
      // Check if session is expired
      if (Date.now() > session.expiresAt) {
        console.log('Local session expired');
        await this.logout();
        return null;
      }

      const profile = session.profile;
      
      // Verify that the stored profile matches the current auth user
      if (user && profile.id !== user.id) {
        console.warn('Profile ID mismatch with auth user, logging out');
        await this.logout();
        return null;
      }
      
      // Restore encryption keys
      this.encryptionManager.setKeyPair({
        publicKey: profile.public_key,
        privateKey,
      });

      // Update last activity
      await this.updateLastActivity(profile.id).catch(err => console.warn('Failed to update activity:', err));

      this.currentUser = profile;
      this.startSessionRefresh();
      return profile;
    } catch (error) {
      console.error('Session login error:', error);
      // Clear invalid session on error
      await this.logout();
      return null;
    }
  }

  // Update last activity timestamp
  async updateLastActivity(profileId: string): Promise<void> {
    try {
      // Check if we have an active session
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        console.warn('No active session for updateLastActivity');
        return;
      }

      await supabase.rpc('update_last_activity', { profile_id: profileId });
    } catch (error) {
      console.warn('Failed to update last activity:', error);
    }
  }

  // Delete user profile permanently
  async deleteProfile(): Promise<void> {
    if (!this.currentUser) {
      throw new Error('No user logged in');
    }

    try {
      // Check if we have an active session
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        console.warn('No active session for deleteProfile');
        await this.logout();
        return;
      }

      // Delete from database
      const { error } = await supabase
        .from('profiles')
        .delete()
        .eq('id', this.currentUser.id);

      if (error) {
        console.warn('Failed to delete profile from database:', error);
      }

      // Clear local storage
      await this.logout();
    } catch (error) {
      console.warn('Profile deletion error:', error);
      await this.logout();
    }
  }

  // Search users by username or ID
  async searchUser(query: string): Promise<UserProfile[]> {
    try {
      // Check if we have an active session
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        console.warn('No active session for search');
        return [];
      }

      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .or(`username.ilike.%${query}%,user_id.eq.${parseInt(query) || 0}`)
        .limit(10);

      if (error) throw error;
      return data || [];
    } catch (error) {
      console.warn('Database search not available:', error);
      return [];
    }
  }

  // Get user by ID
  async getUserById(userId: number): Promise<UserProfile | null> {
    try {
      // Check if we have an active session
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        console.warn('No active session for getUserById');
        return null;
      }

      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('user_id', userId)
        .single();

      if (error) return null;
      return data;
    } catch (error) {
      console.warn('Database getUserById not available:', error);
      return null;
    }
  }

  // Get current user
  getCurrentUser(): UserProfile | null {
    return this.currentUser;
  }

  // Logout and clear session
  async logout(): Promise<void> {
    try {
      if (this.refreshTimer) {
        clearInterval(this.refreshTimer);
        this.refreshTimer = null;
      }

      await AsyncStorage.multiRemove(['user_session', 'private_key', 'user_profile']);
      this.currentUser = null;
      this.encryptionManager.clearKeys();
    } catch (error) {
      throw new Error(`Logout failed: ${error}`);
    }
  }
}