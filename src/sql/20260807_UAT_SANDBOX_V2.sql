BEGIN;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS uat_sandbox_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  uat_run_id uuid REFERENCES uat_test_runs(id) ON DELETE CASCADE,
  location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
  tag text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active',
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  cleaned_at timestamptz,
  CONSTRAINT uat_sandbox_runs_status_ck CHECK(status IN ('active','cleaned'))
);

CREATE TABLE IF NOT EXISTS uat_sandbox_entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sandbox_run_id uuid NOT NULL REFERENCES uat_sandbox_runs(id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  external_id text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS uat_sandbox_entities_run_idx ON uat_sandbox_entities(sandbox_run_id,entity_type);

CREATE TABLE IF NOT EXISTS uat_sandbox_finance_chain (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sandbox_run_id uuid NOT NULL REFERENCES uat_sandbox_runs(id) ON DELETE CASCADE,
  customer_name text NOT NULL,
  customer_email text NOT NULL,
  service_name text NOT NULL,
  appointment_at timestamptz NOT NULL,
  work_order_no text NOT NULL,
  payment_method text NOT NULL,
  gross_amount numeric(14,2) NOT NULL,
  invoice_no text NOT NULL,
  ledger_debit numeric(14,2) NOT NULL,
  ledger_credit numeric(14,2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS uat_sandbox_procurement_chain (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sandbox_run_id uuid NOT NULL REFERENCES uat_sandbox_runs(id) ON DELETE CASCADE,
  supplier_name text NOT NULL,
  purchase_order_no text NOT NULL,
  item_name text NOT NULL,
  quantity numeric(14,3) NOT NULL,
  unit_price numeric(14,2) NOT NULL,
  receipt_no text NOT NULL,
  incoming_invoice_no text NOT NULL,
  gross_amount numeric(14,2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
