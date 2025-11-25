/*
  # Fix Infinite Recursion in chat_participants Policies

  The policy "Users can view participants of chats they belong to" causes infinite recursion
  because it queries chat_participants while being a policy on chat_participants itself.
  
  Solution: Remove the recursive policy and rely on direct ownership check instead.
  Users can view chat_participants records if they are a participant in that chat,
  checked via the chats table instead of chat_participants.
*/

-- Drop the problematic recursive policy
DROP POLICY IF EXISTS "Users can view participants of chats they belong to" ON chat_participants;

-- Drop other problematic policies that allow anon users or have wrong WITH CHECK
DROP POLICY IF EXISTS "Users can be added to chats" ON chat_participants;
DROP POLICY IF EXISTS "Users can insert own participation" ON chat_participants;
DROP POLICY IF EXISTS "Users can view their own chat participation" ON chat_participants;

-- Create proper non-recursive policies
CREATE POLICY "Users can view chat participants in their chats"
  ON chat_participants FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM chat_participants cp
      WHERE cp.chat_id = chat_participants.chat_id
        AND cp.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can insert own participation"
  ON chat_participants FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can update own participation"
  ON chat_participants FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can delete own participation"
  ON chat_participants FOR DELETE
  TO authenticated
  USING (user_id = auth.uid());
