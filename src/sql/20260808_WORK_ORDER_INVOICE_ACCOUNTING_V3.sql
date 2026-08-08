BEGIN;

CREATE TABLE IF NOT EXISTS invoice_number_counters (
  year integer PRIMARY KEY,
  last_value bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION next_internal_invoice_number()
RETURNS text LANGUAGE plpgsql AS $$
DECLARE y integer:=EXTRACT(YEAR FROM CURRENT_DATE)::integer; n bigint;
BEGIN
  INSERT INTO invoice_number_counters(year,last_value) VALUES(y,1)
  ON CONFLICT(year) DO UPDATE SET last_value=invoice_number_counters.last_value+1,updated_at=now()
  RETURNING last_value INTO n;
  RETURN format('KLEO-SZ-%s-%s',y,lpad(n::text,6,'0'));
END $$;

ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS document_kind text NOT NULL DEFAULT 'internal_draft';
ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS issued_at timestamptz;
ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS issued_by text;
ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS pdf_generated_at timestamptz;
ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS emailed_at timestamptz;
ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS emailed_to text;
ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS accounting_posted_at timestamptz;
ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS accounting_entry_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS finance_invoices_work_order_outgoing_uq
ON finance_invoices(work_order_id) WHERE direction='outgoing' AND work_order_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS finance_invoices_invoice_no_uq
ON finance_invoices(invoice_no) WHERE invoice_no IS NOT NULL;

CREATE TABLE IF NOT EXISTS accounting_journal_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid,
  entry_no text NOT NULL UNIQUE,
  entry_date date NOT NULL DEFAULT CURRENT_DATE,
  reference_type text NOT NULL,
  reference_id text,
  description text,
  status text NOT NULL DEFAULT 'posted',
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS accounting_journal_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id uuid NOT NULL REFERENCES accounting_journal_entries(id) ON DELETE RESTRICT,
  account_code text NOT NULL,
  account_name text NOT NULL,
  debit numeric(14,2) NOT NULL DEFAULT 0,
  credit numeric(14,2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (debit>=0 AND credit>=0 AND NOT(debit>0 AND credit>0))
);
CREATE INDEX IF NOT EXISTS accounting_journal_lines_entry_idx ON accounting_journal_lines(entry_id);

CREATE TABLE IF NOT EXISTS invoice_delivery_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES finance_invoices(id) ON DELETE RESTRICT,
  recipient text NOT NULL,
  delivery_type text NOT NULL DEFAULT 'email',
  status text NOT NULL,
  provider_message_id text,
  error_message text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
