-- VIR P17-P19 unified control, automation and predictive intelligence
-- Canonical SaaS tenant boundary uses tenants.id BIGINT.

CREATE TABLE IF NOT EXISTS vir_p17_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
  operation_type text NOT NULL,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'pending_approval',
  execution_mode text NOT NULL DEFAULT 'controlled_manual',
  approval_required boolean NOT NULL DEFAULT true,
  risk_level text NOT NULL DEFAULT 'medium',
  source_layer text NOT NULL DEFAULT 'manual',
  source_ref text,
  idempotency_key text,
  preview_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  approval_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  execution_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  verification_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  rollback_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text NOT NULL,
  approved_by text,
  executed_by text,
  verified_by text,
  rolled_back_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  executed_at timestamptz,
  verified_at timestamptz,
  rolled_back_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vir_p17_operations_status_ck CHECK (status IN ('pending_approval','approved','executed','verified','rolled_back','rejected')),
  CONSTRAINT vir_p17_operations_mode_ck CHECK (execution_mode IN ('controlled_manual','internal_reversible')),
  CONSTRAINT vir_p17_operations_risk_ck CHECK (risk_level IN ('low','medium','high','critical'))
);
CREATE UNIQUE INDEX IF NOT EXISTS vir_p17_operations_tenant_idempotency_uq ON vir_p17_operations(tenant_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS vir_p17_operations_tenant_status_idx ON vir_p17_operations(tenant_id,status,created_at DESC);
CREATE INDEX IF NOT EXISTS vir_p17_operations_tenant_location_idx ON vir_p17_operations(tenant_id,location_id,created_at DESC);

CREATE TABLE IF NOT EXISTS vir_p17_operation_events (
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  operation_id uuid NOT NULL REFERENCES vir_p17_operations(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  actor_id text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vir_p17_operation_events_tenant_operation_idx ON vir_p17_operation_events(tenant_id,operation_id,created_at);

CREATE TABLE IF NOT EXISTS vir_p18_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
  proposal_key text NOT NULL,
  source_type text NOT NULL,
  operation_type text NOT NULL,
  title text NOT NULL,
  reason text NOT NULL,
  priority text NOT NULL DEFAULT 'medium',
  confidence numeric(5,4) NOT NULL DEFAULT 0.5000,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'proposed',
  promoted_operation_id uuid REFERENCES vir_p17_operations(id) ON DELETE SET NULL,
  created_by text NOT NULL,
  decided_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vir_p18_status_ck CHECK (status IN ('proposed','promoted','dismissed')),
  CONSTRAINT vir_p18_priority_ck CHECK (priority IN ('low','medium','high','critical')),
  CONSTRAINT vir_p18_confidence_ck CHECK (confidence >= 0 AND confidence <= 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS vir_p18_active_proposal_uq ON vir_p18_proposals(tenant_id,proposal_key) WHERE status='proposed';
CREATE INDEX IF NOT EXISTS vir_p18_tenant_status_idx ON vir_p18_proposals(tenant_id,status,priority,created_at DESC);

CREATE TABLE IF NOT EXISTS vir_p19_forecast_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
  horizon_days integer NOT NULL,
  model_key text NOT NULL DEFAULT 'deterministic_trend_v1',
  confidence numeric(5,4) NOT NULL DEFAULT 0.5000,
  revenue_forecast numeric(14,2) NOT NULL DEFAULT 0,
  booking_forecast integer NOT NULL DEFAULT 0,
  no_show_risk_percent numeric(7,3) NOT NULL DEFAULT 0,
  capacity_pressure text NOT NULL DEFAULT 'normal',
  inputs jsonb NOT NULL DEFAULT '{}'::jsonb,
  forecast jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vir_p19_horizon_ck CHECK (horizon_days IN (7,30,90)),
  CONSTRAINT vir_p19_confidence_ck CHECK (confidence >= 0 AND confidence <= 1),
  CONSTRAINT vir_p19_capacity_ck CHECK (capacity_pressure IN ('low','normal','high','critical'))
);
CREATE INDEX IF NOT EXISTS vir_p19_tenant_created_idx ON vir_p19_forecast_snapshots(tenant_id,created_at DESC);

CREATE OR REPLACE FUNCTION public.vir_p17_p19_enforce_location_tenant()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.location_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM locations l WHERE l.id=NEW.location_id AND l.tenant_id::text=NEW.tenant_id::text
  ) THEN
    RAISE EXCEPTION 'tenant_location_mismatch';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS vir_p17_operations_tenant_guard ON vir_p17_operations;
CREATE TRIGGER vir_p17_operations_tenant_guard BEFORE INSERT OR UPDATE OF tenant_id,location_id ON vir_p17_operations FOR EACH ROW EXECUTE FUNCTION public.vir_p17_p19_enforce_location_tenant();
DROP TRIGGER IF EXISTS vir_p18_proposals_tenant_guard ON vir_p18_proposals;
CREATE TRIGGER vir_p18_proposals_tenant_guard BEFORE INSERT OR UPDATE OF tenant_id,location_id ON vir_p18_proposals FOR EACH ROW EXECUTE FUNCTION public.vir_p17_p19_enforce_location_tenant();
DROP TRIGGER IF EXISTS vir_p19_forecast_tenant_guard ON vir_p19_forecast_snapshots;
CREATE TRIGGER vir_p19_forecast_tenant_guard BEFORE INSERT OR UPDATE OF tenant_id,location_id ON vir_p19_forecast_snapshots FOR EACH ROW EXECUTE FUNCTION public.vir_p17_p19_enforce_location_tenant();
