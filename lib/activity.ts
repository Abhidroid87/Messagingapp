import { supabase } from './supabase';

/**
 * Updates the user's last_activity timestamp in Supabase.
 */
export async function markActive(profileId: string) {
  try {
    // Check for active session before making the call
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      console.warn('No active session for markActive');
      return;
    }

    await supabase.rpc('touch_last_activity', { p_profile_id: profileId });
    console.log('last_activity updated for', profileId);
  } catch (err) {
    console.error('Failed to update last activity', err);
  }
}
