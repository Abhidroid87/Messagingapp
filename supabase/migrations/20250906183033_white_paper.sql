/*
  # Complete Chat Database Schema with RLS Policies

  1. New Tables
    - `profiles` - Enhanced user profiles with activity tracking
    - `chats` - Conversation containers (direct and group chats)
    - `chat_participants` - Many-to-many relationship between users and chats
    - `messages` - Chat messages with encryption support
    - `message_reactions` - Emoji reactions to messages
    - `typing_indicators` - Real-time typing status
    - `message_status` - Per-user message delivery tracking
    - `group_keys` - Encrypted group chat keys for E2E encryption

  2. Security
    - Enable RLS on all tables
    - Comprehensive policies for authenticated users
    - Performance-optimized policy checks using auth.uid()

  3. Indexes
    - Optimized indexes for RLS policy performance
    - Query performance for chat operations

  4. Functions
    - Activity tracking functions
    - Cleanup functions for maintenance
    - Group key rotation support
*/

-- Enhance profiles table (keep existing structure, add missing fields)
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS avatar_url text;

-- Create chats table
CREATE TABLE IF NOT EXISTS chats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text,
  is_group boolean DEFAULT false,
  created_by uuid REFERENCES profiles(id) ON DELETE CASCADE,
  group_key_version integer DEFAULT 1,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Create chat_participants table
CREATE TABLE IF NOT EXISTS chat_participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id uuid REFERENCES chats(id) ON DELETE CASCADE,
  user_id uuid REFERENCES profiles(id) ON DELETE CASCADE,
  role text DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  joined_at timestamptz DEFAULT now(),
  left_at timestamptz,
  UNIQUE(chat_id, user_id)
);

-- Create messages table
CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id uuid REFERENCES chats(id) ON DELETE CASCADE,
  sender_id uuid REFERENCES profiles(id) ON DELETE CASCADE,
  message_type text DEFAULT 'text' CHECK (message_type IN ('text', 'file', 'image', 'audio', 'video')),
  file_name text,
  file_size bigint,
  reply_to uuid REFERENCES messages(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now(),
  expires_at timestamptz DEFAULT (now() + interval '7 days')
);

-- Create message_status table
CREATE TABLE IF NOT EXISTS message_status (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid REFERENCES messages(id) ON DELETE CASCADE,
  user_id uuid REFERENCES profiles(id) ON DELETE CASCADE,
  status text DEFAULT 'sent' CHECK (status IN ('sent', 'delivered', 'seen')),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(message_id, user_id)
);

-- Create message_reactions table
CREATE TABLE IF NOT EXISTS message_reactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid REFERENCES messages(id) ON DELETE CASCADE,
  user_id uuid REFERENCES profiles(id) ON DELETE CASCADE,
  emoji text NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE(message_id, user_id, emoji)
);

-- Create typing_indicators table
CREATE TABLE IF NOT EXISTS typing_indicators (
  chat_id uuid REFERENCES chats(id) ON DELETE CASCADE,
  user_id uuid REFERENCES profiles(id) ON DELETE CASCADE,
  is_typing boolean DEFAULT false,
  updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (chat_id, user_id)
);

-- Create group_keys table for E2E encryption
CREATE TABLE IF NOT EXISTS group_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id uuid REFERENCES chats(id) ON DELETE CASCADE,
  user_id uuid REFERENCES profiles(id) ON DELETE CASCADE,
  key_version integer NOT NULL,
  encrypted_key text NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE(chat_id, user_id, key_version)
);

-- Enable Row Level Security on all tables
ALTER TABLE chats ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE typing_indicators ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_keys ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- RLS POLICIES
-- ============================================================================

-- PROFILES POLICIES (Enhanced)
DROP POLICY IF EXISTS "Profiles are publicly readable for search" ON profiles;
DROP POLICY IF EXISTS "Users can create their own profile" ON profiles;
DROP POLICY IF EXISTS "Users can update their own profile" ON profiles;
DROP POLICY IF EXISTS "Users can delete their own profile" ON profiles;

CREATE POLICY "Profiles are publicly readable for search"
  ON profiles FOR SELECT
  TO authenticated, anon
  USING (true);

CREATE POLICY "Anyone can create profile"
  ON profiles FOR INSERT
  TO authenticated, anon
  WITH CHECK (true);

CREATE POLICY "Users can update any profile"
  ON profiles FOR UPDATE
  TO authenticated, anon
  USING (true);

CREATE POLICY "Users can delete any profile"
  ON profiles FOR DELETE
  TO authenticated, anon
  USING (true);

-- CHATS POLICIES
CREATE POLICY "Users can view chats they participate in"
  ON chats FOR SELECT
  TO authenticated
  USING (
    id IN (
      SELECT chat_id FROM chat_participants 
      WHERE user_id = (SELECT id FROM profiles WHERE id = (SELECT auth.uid()))
      AND left_at IS NULL
    )
  );

CREATE POLICY "Users can create chats"
  ON chats FOR INSERT
  TO authenticated
  WITH CHECK (
    created_by = (SELECT id FROM profiles WHERE id = (SELECT auth.uid()))
  );

CREATE POLICY "Chat creators and admins can update chats"
  ON chats FOR UPDATE
  TO authenticated
  USING (
    created_by = (SELECT id FROM profiles WHERE id = (SELECT auth.uid()))
    OR (SELECT id FROM profiles WHERE id = (SELECT auth.uid())) IN (
      SELECT user_id FROM chat_participants 
      WHERE chat_id = chats.id AND role = 'admin' AND left_at IS NULL
    )
  );

CREATE POLICY "Chat creators and admins can delete chats"
  ON chats FOR DELETE
  TO authenticated
  USING (
    created_by = (SELECT id FROM profiles WHERE id = (SELECT auth.uid()))
    OR (SELECT id FROM profiles WHERE id = (SELECT auth.uid())) IN (
      SELECT user_id FROM chat_participants 
      WHERE chat_id = chats.id AND role = 'admin' AND left_at IS NULL
    )
  );

-- CHAT_PARTICIPANTS POLICIES
CREATE POLICY "Users can view participants of their chats"
  ON chat_participants FOR SELECT
  TO authenticated
  USING (
    chat_id IN (
      SELECT chat_id FROM chat_participants 
      WHERE user_id = (SELECT id FROM profiles WHERE id = (SELECT auth.uid()))
      AND left_at IS NULL
    )
  );

CREATE POLICY "Chat admins can add participants"
  ON chat_participants FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT id FROM profiles WHERE id = (SELECT auth.uid())) IN (
      SELECT user_id FROM chat_participants 
      WHERE chat_id = NEW.chat_id AND role = 'admin' AND left_at IS NULL
    )
    OR (SELECT id FROM profiles WHERE id = (SELECT auth.uid())) IN (
      SELECT created_by FROM chats WHERE id = NEW.chat_id
    )
  );

CREATE POLICY "Chat admins can update participants"
  ON chat_participants FOR UPDATE
  TO authenticated
  USING (
    (SELECT id FROM profiles WHERE id = (SELECT auth.uid())) IN (
      SELECT user_id FROM chat_participants 
      WHERE chat_id = chat_participants.chat_id AND role = 'admin' AND left_at IS NULL
    )
    OR user_id = (SELECT id FROM profiles WHERE id = (SELECT auth.uid()))
  );

CREATE POLICY "Chat admins can remove participants"
  ON chat_participants FOR DELETE
  TO authenticated
  USING (
    (SELECT id FROM profiles WHERE id = (SELECT auth.uid())) IN (
      SELECT user_id FROM chat_participants cp2
      WHERE cp2.chat_id = chat_participants.chat_id AND cp2.role = 'admin' AND cp2.left_at IS NULL
    )
    OR user_id = (SELECT id FROM profiles WHERE id = (SELECT auth.uid()))
  );

-- MESSAGES POLICIES
CREATE POLICY "Messages visible to chat participants"
  ON messages FOR SELECT
  TO authenticated
  USING (
    (SELECT id FROM profiles WHERE id = (SELECT auth.uid())) IN (
      SELECT user_id FROM chat_participants 
      WHERE chat_id = messages.chat_id AND left_at IS NULL
    )
  );

CREATE POLICY "Chat participants can send messages"
  ON messages FOR INSERT
  TO authenticated
  WITH CHECK (
    sender_id = (SELECT id FROM profiles WHERE id = (SELECT auth.uid()))
    AND (SELECT id FROM profiles WHERE id = (SELECT auth.uid())) IN (
      SELECT user_id FROM chat_participants 
      WHERE chat_id = NEW.chat_id AND left_at IS NULL
    )
  );

CREATE POLICY "Senders can update their own messages"
  ON messages FOR UPDATE
  TO authenticated
  USING (sender_id = (SELECT id FROM profiles WHERE id = (SELECT auth.uid())))
  WITH CHECK (sender_id = (SELECT id FROM profiles WHERE id = (SELECT auth.uid())));

CREATE POLICY "Senders and admins can delete messages"
  ON messages FOR DELETE
  TO authenticated
  USING (
    sender_id = (SELECT id FROM profiles WHERE id = (SELECT auth.uid()))
    OR (SELECT id FROM profiles WHERE id = (SELECT auth.uid())) IN (
      SELECT user_id FROM chat_participants 
      WHERE chat_id = messages.chat_id AND role = 'admin' AND left_at IS NULL
    )
  );

-- MESSAGE_STATUS POLICIES
CREATE POLICY "Users can view message status for their chats"
  ON message_status FOR SELECT
  TO authenticated
  USING (
    message_id IN (
      SELECT id FROM messages WHERE chat_id IN (
        SELECT chat_id FROM chat_participants 
        WHERE user_id = (SELECT id FROM profiles WHERE id = (SELECT auth.uid()))
        AND left_at IS NULL
      )
    )
  );

CREATE POLICY "Users can create message status for themselves"
  ON message_status FOR INSERT
  TO authenticated
  WITH CHECK (
    user_id = (SELECT id FROM profiles WHERE id = (SELECT auth.uid()))
    AND message_id IN (
      SELECT id FROM messages WHERE chat_id IN (
        SELECT chat_id FROM chat_participants 
        WHERE user_id = (SELECT id FROM profiles WHERE id = (SELECT auth.uid()))
        AND left_at IS NULL
      )
    )
  );

CREATE POLICY "Users can update their own message status"
  ON message_status FOR UPDATE
  TO authenticated
  USING (user_id = (SELECT id FROM profiles WHERE id = (SELECT auth.uid())))
  WITH CHECK (user_id = (SELECT id FROM profiles WHERE id = (SELECT auth.uid())));

-- MESSAGE_REACTIONS POLICIES
CREATE POLICY "Users can view reactions on messages they can see"
  ON message_reactions FOR SELECT
  TO authenticated
  USING (
    message_id IN (
      SELECT id FROM messages WHERE chat_id IN (
        SELECT chat_id FROM chat_participants 
        WHERE user_id = (SELECT id FROM profiles WHERE id = (SELECT auth.uid()))
        AND left_at IS NULL
      )
    )
  );

CREATE POLICY "Users can add reactions to messages they can see"
  ON message_reactions FOR INSERT
  TO authenticated
  WITH CHECK (
    user_id = (SELECT id FROM profiles WHERE id = (SELECT auth.uid()))
    AND message_id IN (
      SELECT id FROM messages WHERE chat_id IN (
        SELECT chat_id FROM chat_participants 
        WHERE user_id = (SELECT id FROM profiles WHERE id = (SELECT auth.uid()))
        AND left_at IS NULL
      )
    )
  );

CREATE POLICY "Users can remove their own reactions"
  ON message_reactions FOR DELETE
  TO authenticated
  USING (user_id = (SELECT id FROM profiles WHERE id = (SELECT auth.uid())));

-- TYPING_INDICATORS POLICIES
CREATE POLICY "Users can view typing indicators for their chats"
  ON typing_indicators FOR SELECT
  TO authenticated
  USING (
    chat_id IN (
      SELECT chat_id FROM chat_participants 
      WHERE user_id = (SELECT id FROM profiles WHERE id = (SELECT auth.uid()))
      AND left_at IS NULL
    )
  );

CREATE POLICY "Users can manage their typing status"
  ON typing_indicators FOR INSERT
  TO authenticated
  WITH CHECK (
    user_id = (SELECT id FROM profiles WHERE id = (SELECT auth.uid()))
    AND chat_id IN (
      SELECT chat_id FROM chat_participants 
      WHERE user_id = (SELECT id FROM profiles WHERE id = (SELECT auth.uid()))
      AND left_at IS NULL
    )
  );

CREATE POLICY "Users can update their typing status"
  ON typing_indicators FOR UPDATE
  TO authenticated
  USING (user_id = (SELECT id FROM profiles WHERE id = (SELECT auth.uid())));

CREATE POLICY "Users can delete their typing status"
  ON typing_indicators FOR DELETE
  TO authenticated
  USING (user_id = (SELECT id FROM profiles WHERE id = (SELECT auth.uid())));

-- GROUP_KEYS POLICIES
CREATE POLICY "Users can view their group keys"
  ON group_keys FOR SELECT
  TO authenticated
  USING (user_id = (SELECT id FROM profiles WHERE id = (SELECT auth.uid())));

CREATE POLICY "Chat admins can create group keys"
  ON group_keys FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT id FROM profiles WHERE id = (SELECT auth.uid())) IN (
      SELECT user_id FROM chat_participants 
      WHERE chat_id = NEW.chat_id AND role = 'admin' AND left_at IS NULL
    )
    OR (SELECT id FROM profiles WHERE id = (SELECT auth.uid())) IN (
      SELECT created_by FROM chats WHERE id = NEW.chat_id
    )
  );

-- ============================================================================
-- PERFORMANCE INDEXES
-- ============================================================================

-- Profiles indexes
CREATE INDEX IF NOT EXISTS idx_profiles_user_id ON profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_profiles_username ON profiles(username);
CREATE INDEX IF NOT EXISTS idx_profiles_last_activity ON profiles(last_activity);

-- Chat participants indexes
CREATE INDEX IF NOT EXISTS idx_chat_participants_chat_id ON chat_participants(chat_id);
CREATE INDEX IF NOT EXISTS idx_chat_participants_user_id ON chat_participants(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_participants_chat_user ON chat_participants(chat_id, user_id);
CREATE INDEX IF NOT EXISTS idx_chat_participants_active ON chat_participants(chat_id, user_id) WHERE left_at IS NULL;

-- Messages indexes
CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);
CREATE INDEX IF NOT EXISTS idx_messages_sender_id ON messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_chat_created ON messages(chat_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_expires_at ON messages(expires_at);

-- Message status indexes
CREATE INDEX IF NOT EXISTS idx_message_status_message_id ON message_status(message_id);
CREATE INDEX IF NOT EXISTS idx_message_status_user_id ON message_status(user_id);
CREATE INDEX IF NOT EXISTS idx_message_status_message_user ON message_status(message_id, user_id);

-- Message reactions indexes
CREATE INDEX IF NOT EXISTS idx_message_reactions_message_id ON message_reactions(message_id);
CREATE INDEX IF NOT EXISTS idx_message_reactions_user_id ON message_reactions(user_id);

-- Typing indicators indexes
CREATE INDEX IF NOT EXISTS idx_typing_indicators_chat_id ON typing_indicators(chat_id);
CREATE INDEX IF NOT EXISTS idx_typing_indicators_updated_at ON typing_indicators(updated_at);

-- Group keys indexes
CREATE INDEX IF NOT EXISTS idx_group_keys_chat_id ON group_keys(chat_id);
CREATE INDEX IF NOT EXISTS idx_group_keys_user_id ON group_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_group_keys_chat_user_version ON group_keys(chat_id, user_id, key_version);

-- ============================================================================
-- UTILITY FUNCTIONS
-- ============================================================================

-- Function to touch last activity (enhanced)
CREATE OR REPLACE FUNCTION touch_last_activity(p_profile_id uuid)
RETURNS void AS $$
BEGIN
  UPDATE profiles 
  SET last_activity = CURRENT_TIMESTAMP 
  WHERE id = p_profile_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to rotate group key version
CREATE OR REPLACE FUNCTION rotate_group_key(chat_uuid uuid)
RETURNS void AS $$
BEGIN
  UPDATE chats 
  SET group_key_version = group_key_version + 1,
      updated_at = CURRENT_TIMESTAMP
  WHERE id = chat_uuid;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to cleanup expired messages
CREATE OR REPLACE FUNCTION cleanup_expired_messages()
RETURNS void AS $$
BEGIN
  DELETE FROM messages 
  WHERE expires_at < CURRENT_TIMESTAMP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to get chat participants (helper for app)
CREATE OR REPLACE FUNCTION get_chat_participants(chat_uuid uuid)
RETURNS TABLE(
  user_id uuid,
  username text,
  role text,
  joined_at timestamptz
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    cp.user_id,
    p.username,
    cp.role,
    cp.joined_at
  FROM chat_participants cp
  JOIN profiles p ON cp.user_id = p.id
  WHERE cp.chat_id = chat_uuid 
  AND cp.left_at IS NULL
  ORDER BY cp.joined_at;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant execute permissions on functions
GRANT EXECUTE ON FUNCTION touch_last_activity(uuid) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION rotate_group_key(uuid) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION cleanup_expired_messages() TO authenticated, anon;
GRANT EXECUTE ON FUNCTION get_chat_participants(uuid) TO authenticated, anon;

-- ============================================================================
-- TRIGGERS
-- ============================================================================

-- Update updated_at timestamp trigger
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Add triggers for updated_at
DROP TRIGGER IF EXISTS update_chats_updated_at ON chats;
CREATE TRIGGER update_chats_updated_at 
  BEFORE UPDATE ON chats 
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Trigger to update chat updated_at when new message is sent
CREATE OR REPLACE FUNCTION update_chat_on_message()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE chats 
  SET updated_at = CURRENT_TIMESTAMP 
  WHERE id = NEW.chat_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_chat_on_new_message ON messages;
CREATE TRIGGER update_chat_on_new_message
  AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION update_chat_on_message();

-- ============================================================================
-- STORAGE SETUP
-- ============================================================================

-- Create storage bucket for files
DO $$
BEGIN
  INSERT INTO storage.buckets (id, name, public) 
  VALUES ('chat-files', 'chat-files', false);
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Storage policies for chat files
CREATE POLICY "Chat participants can upload files"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'chat-files'
    AND (SELECT auth.uid()) IN (
      SELECT user_id FROM chat_participants 
      WHERE chat_id::text = (storage.foldername(name))[1]
      AND left_at IS NULL
    )
  );

CREATE POLICY "Chat participants can view files"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'chat-files'
    AND (SELECT auth.uid()) IN (
      SELECT user_id FROM chat_participants 
      WHERE chat_id::text = (storage.foldername(name))[1]
      AND left_at IS NULL
    )
  );

CREATE POLICY "File owners can delete files"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'chat-files'
    AND owner = (SELECT auth.uid())
  );