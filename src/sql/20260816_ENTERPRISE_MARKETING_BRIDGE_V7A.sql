BEGIN;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Create the same core campaign relation used by dailyActions.ensure(), but during
-- startup so enterprise tenant/location hardening exists before the first request.
CREATE TABLE IF NOT EXISTS daily_action_campaigns(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  headline text NOT NULL,
  description_html text NOT NULL,
  image_url text,
  cta_label text DEFAULT 'Foglalok',
  cta_url text DEFAULT '/foglalas',
  discount_text text,
  valid_from timestamptz NOT NULL,
  valid_until timestamptz NOT NULL,
  audience jsonb DEFAULT '{"type":"all"}'::jsonb,
  channels jsonb DEFAULT '["app"]'::jsonb,
  status text DEFAULT 'draft',
  recipient_count int DEFAULT 0,
  sent_email int DEFAULT 0,
  sent_sms int DEFAULT 0,
  sent_push int DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

COMMIT;
