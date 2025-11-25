/*
  # Remove Duplicate Policies

  Clean up duplicate policies that may conflict or cause issues.
*/

-- Remove the old policy that's still there
DROP POLICY IF EXISTS "Users can view own participations" ON chat_participants;
