-- VIR P23-P25 business digital twin, what-if simulation and governed multi-objective optimization.
-- Tenant boundary remains tenants.id BIGINT. No optimizer output executes directly; promotion creates a P17 pending approval operation.

CREATE TABLE IF NOT EXISTS vir_p23_twin_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
  model_key text NOT NULL DEFAULT 'business_digital_twin_v1',
  completeness numeric(5,4) NOT NULL DEFAULT 0,
  freshness_at timestamptz NOT NULL DEFAULT now(),
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vir_p23_completeness_ck CHECK (completeness >= 0 AND completeness <= 1)
);
CREATE INDEX IF NOT EXISTS vir_p23_tenant_created_idx ON vir_p23_twin_snapshots(tenant_id,created_at DESC);
CREATE INDEX IF NOT EXISTS vir_p23_tenant_location_idx ON vir_p23_twin_snapshots(tenant_id,location_id,created_at DESC);

CREATE TABLE IF NOT EXISTS vir_p24_scenario_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
  twin_snapshot_id uuid REFERENCES vir_p23_twin_snapshots(id) ON DELETE SET NULL,
  scenario_name text NOT NULL,
  levers jsonb NOT NULL DEFAULT '{}'::jsonb,
  baseline jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence numeric(5,4) NOT NULL DEFAULT 0.5000,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vir_p24_confidence_ck CHECK (confidence >= 0 AND confidence <= 1)
);
CREATE INDEX IF NOT EXISTS vir_p24_tenant_created_idx ON vir_p24_scenario_runs(tenant_id,created_at DESC);
CREATE INDEX IF NOT EXISTS vir_p24_tenant_location_idx ON vir_p24_scenario_runs(tenant_id,location_id,created_at DESC);

CREATE TABLE IF NOT EXISTS vir_p25_optimization_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
  twin_snapshot_id uuid REFERENCES vir_p23_twin_snapshots(id) ON DELETE SET NULL,
  objective_weights jsonb NOT NULL DEFAULT '{}'::jsonb,
  constraints jsonb NOT NULL DEFAULT '{}'::jsonb,
  candidate_count integer NOT NULL DEFAULT 0,
  champion jsonb NOT NULL DEFAULT '{}'::jsonb,
  alternatives jsonb NOT NULL DEFAULT '[]'::jsonb,
  score numeric(10,4) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'recommended',
  promoted_operation_id uuid REFERENCES vir_p17_operations(id) ON DELETE SET NULL,
  created_by text NOT NULL,
  promoted_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  promoted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vir_p25_status_ck CHECK (status IN ('recommended','promoted','dismissed'))
);
CREATE INDEX IF NOT EXISTS vir_p25_tenant_created_idx ON vir_p25_optimization_runs(tenant_id,created_at DESC);
CREATE INDEX IF NOT EXISTS vir_p25_tenant_status_idx ON vir_p25_optimization_runs(tenant_id,status,created_at DESC);

DROP TRIGGER IF EXISTS vir_p23_twin_tenant_guard ON vir_p23_twin_snapshots;
CREATE TRIGGER vir_p23_twin_tenant_guard BEFORE INSERT OR UPDATE OF tenant_id,location_id ON vir_p23_twin_snapshots FOR EACH ROW EXECUTE FUNCTION public.vir_p17_p19_enforce_location_tenant();
DROP TRIGGER IF EXISTS vir_p24_scenario_tenant_guard ON vir_p24_scenario_runs;
CREATE TRIGGER vir_p24_scenario_tenant_guard BEFORE INSERT OR UPDATE OF tenant_id,location_id ON vir_p24_scenario_runs FOR EACH ROW EXECUTE FUNCTION public.vir_p17_p19_enforce_location_tenant();
DROP TRIGGER IF EXISTS vir_p25_optimizer_tenant_guard ON vir_p25_optimization_runs;
CREATE TRIGGER vir_p25_optimizer_tenant_guard BEFORE INSERT OR UPDATE OF tenant_id,location_id ON vir_p25_optimization_runs FOR EACH ROW EXECUTE FUNCTION public.vir_p17_p19_enforce_location_tenant();