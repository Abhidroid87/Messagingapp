import React, { createContext, useContext, useEffect, useState } from 'react';
import { AuthManager, UserProfile } from '@/lib/auth';
import { cleanupManager } from '@/lib/cleanup';
import { supabase } from '@/lib/supabase';

interface AuthContextType {
  user: UserProfile | null;
  loading: boolean;
  login: (username: string, gender?: string, bio?: string) => Promise<void>;
  logout: () => Promise<void>;
  deleteProfile: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const authManager = AuthManager.getInstance();

  useEffect(() => {
    let isMounted = true;
    let authSubscription: any = null;
    
    const initializeAuth = async () => {
      try {
        // First check if we have a valid Supabase session
        const { data: { session }, error: sessionError } = await supabase.auth.getSession();
        
        if (sessionError) {
          console.error('Session error:', sessionError);
          if (isMounted) {
            setLoading(false);
          }
          return;
        }

        if (!session) {
          console.log('No active session found');
          if (isMounted) {
            setUser(null);
            setLoading(false);
          }
          return;
        }

        // Try to restore user data from session
        const userData = await authManager.loginWithSession();
        if (isMounted) {
          setUser(userData);
        }
      } catch (error) {
        console.error('Auth initialization failed:', error);
        if (isMounted) {
          setUser(null);
        }
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    };

    // Subscribe to auth state changes
    const setupAuthListener = () => {
      authSubscription = supabase.auth.onAuthStateChange(async (event, session) => {
        console.log('Auth state changed:', event, session?.user?.id);
        
        if (!isMounted) return;

        if (event === 'SIGNED_OUT' || !session) {
          setUser(null);
          setLoading(false);
          return;
        }

        if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
          try {
            const userData = await authManager.loginWithSession();
            setUser(userData);
          } catch (error) {
            console.error('Failed to restore user after auth change:', error);
            setUser(null);
          }
          setLoading(false);
        }
      });
    };
    
    // Start cleanup process
    cleanupManager.startCleanupProcess();
    
    initializeAuth();
    setupAuthListener();
    
    return () => {
      isMounted = false;
      if (authSubscription) {
        authSubscription.data?.subscription?.unsubscribe();
      }
      cleanupManager.stopCleanupProcess();
    };
  }, []);

  const login = async (username: string, gender?: string, bio?: string) => {
    try {
      const userData = await authManager.register(username, gender, bio);
      setUser(userData);
    } catch (error) {
      throw error;
    }
  };

  const logout = async () => {
    try {
      await authManager.logout();
      setUser(null);
    } catch (error) {
      throw error;
    }
  };

  const deleteProfile = async () => {
    try {
      await authManager.deleteProfile();
      setUser(null);
    } catch (error) {
      throw error;
    }
  };

  const refreshUser = async () => {
    try {
      const userData = await authManager.loginWithSession();
      setUser(userData);
    } catch (error) {
      console.error('Failed to refresh user:', error);
    }
  };

  return (
    <AuthContext.Provider value={{ 
      user, 
      loading, 
      login, 
      logout, 
      deleteProfile,
      refreshUser 
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}