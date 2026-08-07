BEGIN;

CREATE TABLE IF NOT EXISTS notification_read_state (
  user_key text NOT NULL,
  notification_key text NOT NULL,
  read_at timestamptz,
  dismissed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_key, notification_key)
);

CREATE INDEX IF NOT EXISTS notification_read_state_user_idx
  ON notification_read_state (user_key, updated_at DESC);

COMMIT;
