-- P17 Autonomous Operations Control 1.0
-- Canonical tenant boundary: tenants.id / *.tenant_id are BIGINT.
-- All state changes are explicit, auditable and reversible.

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

CREATE UNIQUE INDEX IF NOT EXISTS vir_p17_operations_tenant_idempotency_uq
  ON vir_p17_operations(tenant_id,idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS vir_p17_operations_tenant_status_idx
  ON vir_p17_operations(tenant_id,status,created_at DESC);
CREATE INDEX IF NOT EXISTS vir_p17_operations_tenant_location_idx
  ON vir_p17_operations(tenant_id,location_id,created_at DESC);

CREATE TABLE IF NOT EXISTS vir_p17_operation_events (
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  operation_id uuid NOT NULL REFERENCES vir_p17_operations(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  actor_id text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vir_p17_operation_events_tenant_operation_idx
  ON vir_p17_operation_events(tenant_id,operation_id,created_at);

-- The location foreign key alone is not sufficient for multi-tenant safety, so
-- enforce tenant/location consistency at the database boundary as a second line
-- of defence behind the API tenant resolver.
CREATE OR REPLACE FUNCTION public.vir_p17_enforce_location_tenant()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.location_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM locations l
     WHERE l.id=NEW.location_id AND l.tenant_id=NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'tenant_location_mismatch';
  END IF;
  NEW.updated_at=now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS vir_p17_operations_tenant_guard ON vir_p17_operations;
CREATE TRIGGER vir_p17_operations_tenant_guard
BEFORE INSERT OR UPDATE OF tenant_id,location_id,status ON vir_p17_operations
FOR EACH ROW EXECUTE FUNCTION public.vir_p17_enforce_location_tenant();
