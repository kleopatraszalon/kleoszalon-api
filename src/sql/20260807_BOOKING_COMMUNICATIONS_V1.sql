BEGIN;

CREATE TABLE IF NOT EXISTS booking_communication_settings (
  location_id uuid PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
  confirmation_enabled boolean NOT NULL DEFAULT true,
  reminder_48h_enabled boolean NOT NULL DEFAULT true,
  reminder_24h_enabled boolean NOT NULL DEFAULT true,
  cancellation_enabled boolean NOT NULL DEFAULT true,
  waitlist_enabled boolean NOT NULL DEFAULT true,
  review_request_enabled boolean NOT NULL DEFAULT true,
  review_delay_hours integer NOT NULL DEFAULT 24,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO booking_communication_settings(location_id)
SELECT id FROM locations
ON CONFLICT(location_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS booking_communication_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id uuid REFERENCES appointments(id) ON DELETE CASCADE,
  waitlist_id uuid REFERENCES booking_waitlist(id) ON DELETE CASCADE,
  location_id uuid REFERENCES locations(id) ON DELETE CASCADE,
  client_id uuid REFERENCES clients(id) ON DELETE SET NULL,
  channel text NOT NULL DEFAULT 'email',
  event_type text NOT NULL,
  recipient text NOT NULL,
  subject text NOT NULL,
  body_text text NOT NULL,
  body_html text,
  scheduled_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  failed_at timestamptz,
  error_text text,
  attempt_count integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT booking_communication_queue_channel_ck CHECK(channel IN ('email','sms','push')),
  CONSTRAINT booking_communication_queue_status_ck CHECK(status IN ('pending','processing','sent','failed','cancelled'))
);

CREATE INDEX IF NOT EXISTS booking_communication_queue_due_idx
ON booking_communication_queue(status,scheduled_at)
WHERE status='pending';

CREATE INDEX IF NOT EXISTS booking_communication_queue_appointment_idx
ON booking_communication_queue(appointment_id,event_type,scheduled_at);

CREATE UNIQUE INDEX IF NOT EXISTS booking_communication_unique_event_idx
ON booking_communication_queue(appointment_id,event_type,scheduled_at)
WHERE appointment_id IS NOT NULL AND status <> 'cancelled';

COMMIT;
