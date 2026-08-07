BEGIN;

CREATE TABLE IF NOT EXISTS staff_chat_presence (
  user_key text PRIMARY KEY,
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE staff_chat_conversations
  ADD COLUMN IF NOT EXISTS is_group boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS title text,
  ADD COLUMN IF NOT EXISTS created_by text;

CREATE TABLE IF NOT EXISTS staff_chat_members (
  conversation_id uuid NOT NULL REFERENCES staff_chat_conversations(id) ON DELETE CASCADE,
  member_key text NOT NULL,
  joined_at timestamptz NOT NULL DEFAULT now(),
  last_read_at timestamptz,
  PRIMARY KEY (conversation_id, member_key)
);

CREATE INDEX IF NOT EXISTS staff_chat_members_member_idx
  ON staff_chat_members (member_key, conversation_id);

CREATE INDEX IF NOT EXISTS staff_chat_presence_last_seen_idx
  ON staff_chat_presence (last_seen_at DESC);

INSERT INTO staff_chat_members (conversation_id, member_key, joined_at)
SELECT id, participant_a, created_at FROM staff_chat_conversations
ON CONFLICT DO NOTHING;

INSERT INTO staff_chat_members (conversation_id, member_key, joined_at)
SELECT id, participant_b, created_at FROM staff_chat_conversations
ON CONFLICT DO NOTHING;

COMMIT;
