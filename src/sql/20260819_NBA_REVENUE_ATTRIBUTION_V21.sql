-- Customer Intelligence v21: NBA -> Marketing -> Booking -> Revenue attribution
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS crm_nba_marketing_touches(
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL,
  job_id uuid NOT NULL REFERENCES crm_nba_marketing_jobs(id) ON DELETE CASCADE,
  event_type text NOT NULL DEFAULT 'landing' CHECK(event_type IN('landing')),
  fingerprint_hash text,
  referrer text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_nba_marketing_touches_job_idx ON crm_nba_marketing_touches(tenant_id,job_id,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS crm_nba_marketing_touches_dedupe_uq ON crm_nba_marketing_touches(job_id,fingerprint_hash) WHERE fingerprint_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS crm_nba_revenue_attribution(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL,
  job_id uuid NOT NULL REFERENCES crm_nba_marketing_jobs(id) ON DELETE CASCADE,
  client_id text NOT NULL,
  appointment_id uuid NOT NULL,
  work_order_id uuid,
  expected_booking_value numeric(14,2) NOT NULL DEFAULT 0,
  booked_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(job_id,appointment_id)
);
CREATE INDEX IF NOT EXISTS crm_nba_revenue_attr_tenant_idx ON crm_nba_revenue_attribution(tenant_id,booked_at DESC);
CREATE INDEX IF NOT EXISTS crm_nba_revenue_attr_client_idx ON crm_nba_revenue_attribution(tenant_id,client_id,booked_at DESC);
