-- VIR Customer Intelligence -> Marketing Automation v20
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS crm_nba_marketing_settings(
  tenant_id bigint PRIMARY KEY,
  auto_dispatch boolean NOT NULL DEFAULT false,
  require_explicit_approval boolean NOT NULL DEFAULT true,
  default_channel text NOT NULL DEFAULT 'email',
  max_daily_dispatch integer NOT NULL DEFAULT 100 CHECK(max_daily_dispatch BETWEEN 1 AND 5000),
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm_nba_marketing_jobs(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL,
  client_id text NOT NULL,
  nba_event_id uuid NOT NULL,
  action_code text NOT NULL,
  recommendation_version text NOT NULL DEFAULT 'nba-v1',
  channel text NOT NULL CHECK(channel IN('email','sms','push','callback')),
  status text NOT NULL DEFAULT 'draft' CHECK(status IN('draft','approved','queued','ready','waiting_provider','sent','completed','cancelled','failed','blocked')),
  subject text,
  message text NOT NULL,
  scheduled_at timestamptz,
  consent_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  recommendation_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  attribution_key text NOT NULL UNIQUE,
  error text,
  approved_by text,
  approved_at timestamptz,
  sent_at timestamptz,
  completed_at timestamptz,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,nba_event_id,channel)
);
CREATE INDEX IF NOT EXISTS crm_nba_marketing_jobs_tenant_status_idx ON crm_nba_marketing_jobs(tenant_id,status,created_at DESC);
CREATE INDEX IF NOT EXISTS crm_nba_marketing_jobs_client_idx ON crm_nba_marketing_jobs(tenant_id,client_id,created_at DESC);

CREATE TABLE IF NOT EXISTS crm_nba_marketing_job_events(
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL,
  job_id uuid NOT NULL REFERENCES crm_nba_marketing_jobs(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  actor text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_nba_marketing_job_events_job_idx ON crm_nba_marketing_job_events(job_id,id DESC);
