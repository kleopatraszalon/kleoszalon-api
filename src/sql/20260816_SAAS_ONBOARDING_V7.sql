BEGIN;

-- ============================================================
-- VIR SaaS Onboarding v7
-- Resumable, audited tenant activation workflow.
-- The source-of-truth remains the normal tenant/business tables;
-- these tables only persist orchestration state and audit events.
-- ============================================================

CREATE TABLE IF NOT EXISTS tenant_onboarding (
  tenant_id bigint PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'in_progress'
    CHECK (status IN ('in_progress','blocked','ready')),
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

CREATE INDEX IF NOT EXISTS tenant_onboarding_events_tenant_idx
  ON tenant_onboarding_events(tenant_id, created_at DESC);

INSERT INTO tenant_onboarding(tenant_id,status,current_step,created_by)
SELECT t.id,
       CASE
         WHEN EXISTS(SELECT 1 FROM tenant_users tu WHERE tu.tenant_id=t.id AND tu.active=true AND tu.tenant_role IN ('owner','admin'))
          AND EXISTS(SELECT 1 FROM locations l WHERE l.tenant_id=t.id)
          AND EXISTS(SELECT 1 FROM subscriptions s WHERE s.tenant_id=t.id AND s.status IN ('trial','active'))
         THEN 'in_progress'
         ELSE 'in_progress'
       END,
       'company',
       'migration-v7'
  FROM tenants t
ON CONFLICT(tenant_id) DO NOTHING;

COMMIT;
