-- VIR P20-P22 predictive learning, AI decision support and closed-loop optimization
-- Tenant boundary remains tenants.id BIGINT; external execution remains P17-governed.

CREATE TABLE IF NOT EXISTS vir_p20_model_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
  horizon_days integer NOT NULL,
  model_key text NOT NULL DEFAULT 'ensemble_linear_weekday_momentum_v1',
  history_days integer NOT NULL DEFAULT 0,
  confidence numeric(5,4) NOT NULL DEFAULT 0.5000,
  mae numeric(14,4) NOT NULL DEFAULT 0,
  mape_percent numeric(9,4) NOT NULL DEFAULT 0,
  revenue_forecast numeric(14,2) NOT NULL DEFAULT 0,
  revenue_lower numeric(14,2) NOT NULL DEFAULT 0,
  revenue_upper numeric(14,2) NOT NULL DEFAULT 0,
  booking_forecast integer NOT NULL DEFAULT 0,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  forecast jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vir_p20_horizon_ck CHECK (horizon_days IN (7,30,90)),
  CONSTRAINT vir_p20_confidence_ck CHECK (confidence >= 0 AND confidence <= 1),
  CONSTRAINT vir_p20_interval_ck CHECK (revenue_lower >= 0 AND revenue_upper >= revenue_lower)
);
CREATE INDEX IF NOT EXISTS vir_p20_tenant_created_idx ON vir_p20_model_runs(tenant_id,created_at DESC);
CREATE INDEX IF NOT EXISTS vir_p20_tenant_location_idx ON vir_p20_model_runs(tenant_id,location_id,created_at DESC);

CREATE TABLE IF NOT EXISTS vir_p21_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
  decision_key text NOT NULL,
  operation_type text NOT NULL,
  title text NOT NULL,
  rationale text NOT NULL,
  priority text NOT NULL DEFAULT 'medium',
  confidence numeric(5,4) NOT NULL DEFAULT 0.5000,
  score numeric(10,4) NOT NULL DEFAULT 0,
  expected_impact jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  alternatives jsonb NOT NULL DEFAULT '[]'::jsonb,
  risks jsonb NOT NULL DEFAULT '[]'::jsonb,
  learning jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'proposed',
  promoted_operation_id uuid REFERENCES vir_p17_operations(id) ON DELETE SET NULL,
  created_by text NOT NULL,
  decided_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vir_p21_priority_ck CHECK (priority IN ('low','medium','high','critical')),
  CONSTRAINT vir_p21_confidence_ck CHECK (confidence >= 0 AND confidence <= 1),
  CONSTRAINT vir_p21_status_ck CHECK (status IN ('proposed','promoted','dismissed'))
);
CREATE UNIQUE INDEX IF NOT EXISTS vir_p21_active_decision_uq ON vir_p21_decisions(tenant_id,decision_key) WHERE status='proposed';
CREATE INDEX IF NOT EXISTS vir_p21_tenant_status_idx ON vir_p21_decisions(tenant_id,status,priority,created_at DESC);

CREATE TABLE IF NOT EXISTS vir_p22_cycles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
  decision_id uuid NOT NULL REFERENCES vir_p21_decisions(id) ON DELETE CASCADE,
  operation_id uuid NOT NULL REFERENCES vir_p17_operations(id) ON DELETE CASCADE,
  operation_type text NOT NULL,
  objective text NOT NULL DEFAULT 'balanced_growth',
  observation_days integer NOT NULL DEFAULT 7,
  baseline jsonb NOT NULL DEFAULT '{}'::jsonb,
  outcome jsonb NOT NULL DEFAULT '{}'::jsonb,
  optimization_score numeric(10,4),
  outcome_class text,
  status text NOT NULL DEFAULT 'observing',
  created_by text NOT NULL,
  evaluated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  evaluated_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vir_p22_observation_ck CHECK (observation_days IN (7,14,30)),
  CONSTRAINT vir_p22_status_ck CHECK (status IN ('observing','evaluated','cancelled')),
  CONSTRAINT vir_p22_outcome_ck CHECK (outcome_class IS NULL OR outcome_class IN ('positive','neutral','negative'))
);
CREATE UNIQUE INDEX IF NOT EXISTS vir_p22_active_operation_uq ON vir_p22_cycles(tenant_id,operation_id) WHERE status='observing';
CREATE INDEX IF NOT EXISTS vir_p22_tenant_status_idx ON vir_p22_cycles(tenant_id,status,created_at DESC);

DROP TRIGGER IF EXISTS vir_p20_model_runs_tenant_guard ON vir_p20_model_runs;
CREATE TRIGGER vir_p20_model_runs_tenant_guard BEFORE INSERT OR UPDATE OF tenant_id,location_id ON vir_p20_model_runs FOR EACH ROW EXECUTE FUNCTION public.vir_p17_p19_enforce_location_tenant();
DROP TRIGGER IF EXISTS vir_p21_decisions_tenant_guard ON vir_p21_decisions;
CREATE TRIGGER vir_p21_decisions_tenant_guard BEFORE INSERT OR UPDATE OF tenant_id,location_id ON vir_p21_decisions FOR EACH ROW EXECUTE FUNCTION public.vir_p17_p19_enforce_location_tenant();
DROP TRIGGER IF EXISTS vir_p22_cycles_tenant_guard ON vir_p22_cycles;
CREATE TRIGGER vir_p22_cycles_tenant_guard BEFORE INSERT OR UPDATE OF tenant_id,location_id ON vir_p22_cycles FOR EACH ROW EXECUTE FUNCTION public.vir_p17_p19_enforce_location_tenant();
