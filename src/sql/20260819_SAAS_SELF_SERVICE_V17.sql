BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS tenant_onboarding (
  tenant_id bigint PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'in_progress' CHECK(status IN('in_progress','blocked','ready')),
  current_step text NOT NULL DEFAULT 'company',
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenant_onboarding_events (
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  step_key text NOT NULL,
  event_type text NOT NULL,
  actor_user_id text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tenant_onboarding_events_tenant_idx ON tenant_onboarding_events(tenant_id,created_at DESC);

CREATE TABLE IF NOT EXISTS saas_self_service_signups(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_key text NOT NULL UNIQUE,
  tenant_id bigint NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  plan_code text NOT NULL,
  billing_interval text NOT NULL DEFAULT 'month' CHECK(billing_interval IN('month','year')),
  owner_email text NOT NULL,
  ip_hash text,
  status text NOT NULL DEFAULT 'pending_activation' CHECK(status IN('pending_activation','invited','active','invite_failed','expired','cancelled')),
  terms_version text NOT NULL,
  privacy_version text NOT NULL,
  marketing_consent boolean NOT NULL DEFAULT false,
  activation_expires_at timestamptz NOT NULL DEFAULT now()+interval '48 hours',
  invited_at timestamptz,
  activated_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS saas_self_service_email_idx ON saas_self_service_signups(lower(owner_email),created_at DESC);
CREATE INDEX IF NOT EXISTS saas_self_service_ip_idx ON saas_self_service_signups(ip_hash,created_at DESC) WHERE ip_hash IS NOT NULL;

COMMIT;
