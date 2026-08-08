-- NAV Online Számla V5 - validáció, javító/sztornó életciklus és automatikus sor
CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE nav_online_invoice_settings
  ADD COLUMN IF NOT EXISTS auto_submit boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_refresh boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS auto_submit_test_only boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS default_payment_method text DEFAULT 'OTHER',
  ADD COLUMN IF NOT EXISTS validation_strict boolean NOT NULL DEFAULT true;

ALTER TABLE finance_invoices
  ADD COLUMN IF NOT EXISTS nav_validation_status text NOT NULL DEFAULT 'not_validated',
  ADD COLUMN IF NOT EXISTS nav_validated_at timestamptz,
  ADD COLUMN IF NOT EXISTS nav_validation_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS original_invoice_number text,
  ADD COLUMN IF NOT EXISTS modification_index integer,
  ADD COLUMN IF NOT EXISTS correction_reason text,
  ADD COLUMN IF NOT EXISTS nav_queue_status text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS nav_queued_at timestamptz;

CREATE TABLE IF NOT EXISTS nav_invoice_validation_runs(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES finance_invoices(id) ON DELETE CASCADE,
  status text NOT NULL CHECK(status IN ('passed','warning','failed')),
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  snapshot jsonb,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS nav_invoice_validation_invoice_idx ON nav_invoice_validation_runs(invoice_id,created_at DESC);

CREATE TABLE IF NOT EXISTS nav_invoice_queue(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES finance_invoices(id) ON DELETE CASCADE,
  operation text NOT NULL CHECK(operation IN ('CREATE','MODIFY','STORNO')),
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','submitted','done','warning','error','cancelled')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS nav_invoice_queue_open_uq ON nav_invoice_queue(invoice_id) WHERE status IN ('queued','processing','submitted');
CREATE INDEX IF NOT EXISTS nav_invoice_queue_status_idx ON nav_invoice_queue(status,next_attempt_at);

-- a számla korrekciós lánc egyértelmű indexe
CREATE INDEX IF NOT EXISTS finance_invoices_original_idx ON finance_invoices(original_invoice_id, modification_index);
