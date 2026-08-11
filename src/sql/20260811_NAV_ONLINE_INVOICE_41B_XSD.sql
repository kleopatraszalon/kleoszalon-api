BEGIN;

ALTER TABLE finance_invoices
  ADD COLUMN IF NOT EXISTS nav_xsd_validation_status text NOT NULL DEFAULT 'not_validated',
  ADD COLUMN IF NOT EXISTS nav_xsd_validated_at timestamptz,
  ADD COLUMN IF NOT EXISTS nav_xsd_validation_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS nav_xsd_schema_revision text,
  ADD COLUMN IF NOT EXISTS nav_xsd_xml_sha256 text;

ALTER TABLE nav_invoice_submissions
  ADD COLUMN IF NOT EXISTS xsd_validation_status text NOT NULL DEFAULT 'not_validated',
  ADD COLUMN IF NOT EXISTS xsd_validated_at timestamptz,
  ADD COLUMN IF NOT EXISTS xsd_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS xsd_schema_revision text,
  ADD COLUMN IF NOT EXISTS invoice_xml_sha256 text;

ALTER TABLE finance_invoices DROP CONSTRAINT IF EXISTS finance_invoices_nav_xsd_status_ck;
ALTER TABLE finance_invoices ADD CONSTRAINT finance_invoices_nav_xsd_status_ck CHECK(
  nav_xsd_validation_status IN ('not_validated','passed','failed','engine_error')
) NOT VALID;

ALTER TABLE nav_invoice_submissions DROP CONSTRAINT IF EXISTS nav_invoice_submissions_xsd_status_ck;
ALTER TABLE nav_invoice_submissions ADD CONSTRAINT nav_invoice_submissions_xsd_status_ck CHECK(
  xsd_validation_status IN ('not_validated','passed','failed','engine_error')
) NOT VALID;

CREATE TABLE IF NOT EXISTS nav_invoice_xsd_validation_runs(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES finance_invoices(id) ON DELETE CASCADE,
  submission_id uuid,
  status text NOT NULL CHECK(status IN ('passed','failed','engine_error')),
  xml_sha256 text,
  schema_revision text,
  schema_name text,
  validator text,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  raw_output text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS nav_invoice_xsd_runs_invoice_idx
  ON nav_invoice_xsd_validation_runs(invoice_id,created_at DESC);
CREATE INDEX IF NOT EXISTS nav_invoice_xsd_runs_submission_idx
  ON nav_invoice_xsd_validation_runs(submission_id,created_at DESC)
  WHERE submission_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS finance_invoices_nav_xsd_status_idx
  ON finance_invoices(nav_xsd_validation_status,nav_xsd_validated_at DESC);

COMMIT;
