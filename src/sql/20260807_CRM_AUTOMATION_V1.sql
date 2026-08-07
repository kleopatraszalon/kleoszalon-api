BEGIN;

CREATE TABLE IF NOT EXISTS crm_guest_profiles (
  id bigserial PRIMARY KEY,
  contact_key text NOT NULL UNIQUE,
  client_name text,
  client_email text,
  client_phone text,
  first_visit_at timestamptz,
  last_visit_at timestamptz,
  visit_count integer NOT NULL DEFAULT 0,
  total_spent numeric(14,2) NOT NULL DEFAULT 0,
  total_discount numeric(14,2) NOT NULL DEFAULT 0,
  total_tip numeric(14,2) NOT NULL DEFAULT 0,
  last_service_names jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_product_names jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_location_id text,
  last_employee_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS crm_guest_profiles_email_idx
  ON crm_guest_profiles (lower(client_email))
  WHERE client_email IS NOT NULL;

CREATE INDEX IF NOT EXISTS crm_guest_profiles_phone_idx
  ON crm_guest_profiles (client_phone)
  WHERE client_phone IS NOT NULL;

CREATE INDEX IF NOT EXISTS crm_guest_profiles_last_visit_idx
  ON crm_guest_profiles (last_visit_at DESC);

CREATE TABLE IF NOT EXISTS crm_visit_history (
  id bigserial PRIMARY KEY,
  profile_id bigint NOT NULL REFERENCES crm_guest_profiles(id) ON DELETE CASCADE,
  work_order_id text NOT NULL UNIQUE,
  visited_at timestamptz NOT NULL,
  location_id text,
  employee_id text,
  gross_total numeric(14,2) NOT NULL DEFAULT 0,
  discount_amount numeric(14,2) NOT NULL DEFAULT 0,
  tip_amount numeric(14,2) NOT NULL DEFAULT 0,
  amount_paid numeric(14,2) NOT NULL DEFAULT 0,
  service_names jsonb NOT NULL DEFAULT '[]'::jsonb,
  product_names jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS crm_visit_history_profile_date_idx
  ON crm_visit_history (profile_id, visited_at DESC);

COMMIT;
