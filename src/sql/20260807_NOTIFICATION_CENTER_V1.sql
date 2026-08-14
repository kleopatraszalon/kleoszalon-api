BEGIN;

-- Persisted notification envelope. Most operational notifications are still
-- calculated dynamically, but durable/system generated notifications need a
-- canonical table and system-health expects the notification subsystem schema.
CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_key text,
  location_id text,
  notification_key text,
  type text NOT NULL DEFAULT 'system',
  severity text NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','critical')),
  title text NOT NULL,
  detail text,
  route text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  dismissed_at timestamptz
);
CREATE INDEX IF NOT EXISTS notifications_user_created_idx
  ON notifications(user_key,created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_location_created_idx
  ON notifications(location_id,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS notifications_user_key_uq
  ON notifications(user_key,notification_key)
  WHERE user_key IS NOT NULL AND notification_key IS NOT NULL AND dismissed_at IS NULL;

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
