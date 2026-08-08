-- Hűség 6.0: lejárati figyelések és kampányjavaslatok
CREATE TABLE IF NOT EXISTS loyalty_automation_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NULL,
  pass_expiry_days int NOT NULL DEFAULT 14,
  voucher_expiry_days int NOT NULL DEFAULT 14,
  inactive_guest_days int NOT NULL DEFAULT 90,
  birthday_window_days int NOT NULL DEFAULT 7,
  birthday_discount_percent numeric(8,2) NOT NULL DEFAULT 10,
  inactive_discount_percent numeric(8,2) NOT NULL DEFAULT 10,
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(location_id)
);

ALTER TABLE loyalty_accounts ADD COLUMN IF NOT EXISTS points_expires_at date NULL;

CREATE TABLE IF NOT EXISTS loyalty_campaign_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  suggestion_key text NOT NULL UNIQUE,
  customer_id text NULL,
  account_id uuid NULL REFERENCES loyalty_accounts(id) ON DELETE SET NULL,
  suggestion_type text NOT NULL CHECK (suggestion_type IN ('pass_expiry','voucher_expiry','inactive_guest','birthday','points_expiry')),
  title text NOT NULL,
  detail text NULL,
  discount_type text NULL,
  discount_value numeric(12,2) NULL,
  recommended_valid_until date NULL,
  status text NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested','approved','dismissed','converted')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_loyalty_campaign_suggestions_status ON loyalty_campaign_suggestions(status,created_at DESC);

INSERT INTO loyalty_automation_settings(location_id)
SELECT NULL WHERE NOT EXISTS (SELECT 1 FROM loyalty_automation_settings WHERE location_id IS NULL);
