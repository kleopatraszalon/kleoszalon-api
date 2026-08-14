BEGIN;

ALTER TABLE nav_online_invoice_settings
  ADD COLUMN IF NOT EXISTS live_submit_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS live_enabled_at timestamptz,
  ADD COLUMN IF NOT EXISTS live_enabled_by text;

ALTER TABLE work_orders
  ADD COLUMN IF NOT EXISTS invoice_status text NOT NULL DEFAULT 'not_requested',
  ADD COLUMN IF NOT EXISTS billing_name text,
  ADD COLUMN IF NOT EXISTS billing_vat_status text,
  ADD COLUMN IF NOT EXISTS billing_tax_number text,
  ADD COLUMN IF NOT EXISTS billing_country_code varchar(2) DEFAULT 'HU',
  ADD COLUMN IF NOT EXISTS billing_postal_code text,
  ADD COLUMN IF NOT EXISTS billing_city text,
  ADD COLUMN IF NOT EXISTS billing_address text;

ALTER TABLE finance_invoices
  ADD COLUMN IF NOT EXISTS customer_vat_status text,
  ADD COLUMN IF NOT EXISTS exchange_rate numeric(18,6) NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS nav_last_polled_at timestamptz,
  ADD COLUMN IF NOT EXISTS nav_last_result jsonb,
  ADD COLUMN IF NOT EXISTS nav_warning_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS nav_error_count integer NOT NULL DEFAULT 0;

ALTER TABLE nav_invoice_queue
  ADD COLUMN IF NOT EXISTS submission_id uuid,
  ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz;

CREATE INDEX IF NOT EXISTS nav_invoice_queue_due_idx
  ON nav_invoice_queue(status,next_attempt_at)
  WHERE status IN ('queued','processing','submitted');

CREATE INDEX IF NOT EXISTS finance_invoices_workorder_nav_idx
  ON finance_invoices(work_order_id,nav_status,created_at DESC)
  WHERE direction='outgoing' AND work_order_id IS NOT NULL;

COMMIT;
