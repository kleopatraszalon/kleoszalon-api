BEGIN;

CREATE TABLE IF NOT EXISTS ai_usage_log (
  id bigserial PRIMARY KEY,
  user_key text NOT NULL,
  model text NOT NULL,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  estimated_cost_usd numeric(14,6) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_usage_log_created_idx
  ON ai_usage_log (created_at DESC);
CREATE INDEX IF NOT EXISTS ai_usage_log_user_created_idx
  ON ai_usage_log (user_key, created_at DESC);

CREATE TABLE IF NOT EXISTS staff_chat_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_a text NOT NULL,
  participant_b text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_chat_participants_distinct CHECK (participant_a <> participant_b),
  CONSTRAINT staff_chat_participant_order CHECK (participant_a < participant_b),
  CONSTRAINT staff_chat_conversation_unique UNIQUE (participant_a, participant_b)
);

CREATE INDEX IF NOT EXISTS staff_chat_conversations_a_idx
  ON staff_chat_conversations (participant_a, updated_at DESC);
CREATE INDEX IF NOT EXISTS staff_chat_conversations_b_idx
  ON staff_chat_conversations (participant_b, updated_at DESC);

CREATE TABLE IF NOT EXISTS staff_chat_messages (
  id bigserial PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES staff_chat_conversations(id) ON DELETE CASCADE,
  sender_key text NOT NULL,
  sender_name text,
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  CONSTRAINT staff_chat_message_not_empty CHECK (length(btrim(content)) > 0)
);

CREATE INDEX IF NOT EXISTS staff_chat_messages_conversation_created_idx
  ON staff_chat_messages (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS staff_chat_messages_unread_idx
  ON staff_chat_messages (conversation_id, read_at)
  WHERE read_at IS NULL;

COMMIT;
