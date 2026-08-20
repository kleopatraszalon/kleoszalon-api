BEGIN;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS migration_runs(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK(provider IN('altegio','booksy','fresha','excel','csv')),
  entity_type text NOT NULL CHECK(entity_type IN('clients','employees','services','products','appointments')),
  source_mode text NOT NULL DEFAULT 'file',
  status text NOT NULL DEFAULT 'draft' CHECK(status IN('draft','uploaded','analyzed','ready','applying','completed','partial','failed','rolled_back')),
  filename text,
  duplicate_policy text NOT NULL DEFAULT 'review' CHECK(duplicate_policy IN('review','skip','merge','create_new')),
  mapping jsonb NOT NULL DEFAULT '{}'::jsonb,
  target_contract jsonb NOT NULL DEFAULT '{}'::jsonb,
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  rolled_back_at timestamptz
);
CREATE INDEX IF NOT EXISTS migration_runs_tenant_idx ON migration_runs(tenant_id,created_at DESC);

CREATE TABLE IF NOT EXISTS migration_items(
  id bigserial PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES migration_runs(id) ON DELETE CASCADE,
  row_number integer NOT NULL,
  source_data jsonb NOT NULL,
  mapped_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  duplicate_target_pk text,
  disposition text NOT NULL DEFAULT 'pending' CHECK(disposition IN('pending','ready','duplicate','review_required','skipped','created','merged','failed')),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(run_id,row_number)
);
CREATE INDEX IF NOT EXISTS migration_items_run_idx ON migration_items(run_id,row_number);

CREATE TABLE IF NOT EXISTS migration_operations(
  id bigserial PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES migration_runs(id) ON DELETE CASCADE,
  item_id bigint REFERENCES migration_items(id) ON DELETE SET NULL,
  action text NOT NULL CHECK(action IN('create','update')),
  table_name text NOT NULL,
  pk_column text NOT NULL,
  target_pk text NOT NULL,
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS migration_operations_run_idx ON migration_operations(run_id,id DESC);

CREATE TABLE IF NOT EXISTS migration_events(
  id bigserial PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES migration_runs(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  actor text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMIT;
