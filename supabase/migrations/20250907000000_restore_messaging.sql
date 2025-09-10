
-- Restore messaging tables (recreate chats, chat_participants, messages, message_statuses, message_reactions, typing_indicators)
-- Generated to fix lost messaging schema. Adjust roles/policies as needed for production.

create extension if not exists "pgcrypto";

-- Chats table
CREATE TABLE IF NOT EXISTS chats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text,
  is_group boolean DEFAULT false,
  created_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  group_key_version integer DEFAULT 1,
  last_message text,
  last_message_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Chat participants
CREATE TABLE IF NOT EXISTS chat_participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id uuid REFERENCES chats(id) ON DELETE CASCADE,
  user_id uuid REFERENCES profiles(id) ON DELETE CASCADE,
  role text DEFAULT 'member' CHECK (role IN ('admin','member')),
  joined_at timestamptz DEFAULT now(),
  left_at timestamptz,
  UNIQUE (chat_id, user_id)
);

-- Messages table
CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id uuid REFERENCES chats(id) ON DELETE CASCADE,
  sender_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  message_type text DEFAULT 'text' CHECK (message_type IN ('text','file','image','audio','video')),
  file_name text,
  file_size integer,
  reply_to uuid REFERENCES messages(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now(),
  expires_at timestamptz,
  content text, -- encrypted payload or text; app stores decrypted content locally
  delivered boolean DEFAULT false,
  deleted boolean DEFAULT false
);

-- Message statuses (per-user)
CREATE TABLE IF NOT EXISTS message_statuses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid REFERENCES messages(id) ON DELETE CASCADE,
  user_id uuid REFERENCES profiles(id) ON DELETE CASCADE,
  status text CHECK (status IN ('sent','delivered','seen')),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (message_id, user_id)
);

-- Message reactions
CREATE TABLE IF NOT EXISTS message_reactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid REFERENCES messages(id) ON DELETE CASCADE,
  user_id uuid REFERENCES profiles(id) ON DELETE CASCADE,
  reaction text,
  created_at timestamptz DEFAULT now(),
  UNIQUE (message_id, user_id, reaction)
);

-- Typing indicators
CREATE TABLE IF NOT EXISTS typing_indicators (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id uuid REFERENCES chats(id) ON DELETE CASCADE,
  user_id uuid REFERENCES profiles(id) ON DELETE CASCADE,
  started_at timestamptz DEFAULT now()
);

-- Simple RLS policies: allow authenticated users to INSERT/SELECT/UPDATE/DELETE on chats, chat_participants, messages and related tables.
-- NOTE: Adjust for security in production; this is permissive for development to restore functionality.

ALTER TABLE chats ENABLE ROW LEVEL SECURITY;
CREATE POLICY "chats_public" ON chats FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');

ALTER TABLE chat_participants ENABLE ROW LEVEL SECURITY;
CREATE POLICY "chat_participants_public" ON chat_participants FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "messages_public" ON messages FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');

ALTER TABLE message_statuses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "message_statuses_public" ON message_statuses FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');

ALTER TABLE message_reactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "message_reactions_public" ON message_reactions FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');

ALTER TABLE typing_indicators ENABLE ROW LEVEL SECURITY;
CREATE POLICY "typing_indicators_public" ON typing_indicators FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');

-- Trigger to update chats.updated_at when messages are inserted/updated
CREATE OR REPLACE FUNCTION update_chat_timestamp() RETURNS trigger AS $$
BEGIN
  UPDATE chats SET last_message = NEW.content, last_message_at = NEW.created_at, updated_at = now() WHERE id = NEW.chat_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_update_chat_ts ON messages;
CREATE TRIGGER trg_update_chat_ts AFTER INSERT OR UPDATE ON messages FOR EACH ROW EXECUTE PROCEDURE update_chat_timestamp();
