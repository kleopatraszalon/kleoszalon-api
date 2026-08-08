BEGIN;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS invoice_number_counters(
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

ALTER TABLE finance_invoices
  ADD COLUMN IF NOT EXISTS document_kind text NOT NULL DEFAULT 'internal_draft',
  ADD COLUMN IF NOT EXISTS issued_at timestamptz,
  ADD COLUMN IF NOT EXISTS issued_by text,
  ADD COLUMN IF NOT EXISTS pdf_generated_at timestamptz,
  ADD COLUMN IF NOT EXISTS emailed_at timestamptz,
  ADD COLUMN IF NOT EXISTS emailed_to text,
  ADD COLUMN IF NOT EXISTS accounting_posted_at timestamptz,
  ADD COLUMN IF NOT EXISTS journal_entry_id uuid,
  ADD COLUMN IF NOT EXISTS accounting_entry_id uuid;

-- A régi munkalap-számlázási ág accounting_entry_id mezőjét átvezetjük
-- a pénzügyi modul által használt kanonikus journal_entry_id mezőbe.
UPDATE finance_invoices
SET journal_entry_id=accounting_entry_id
WHERE journal_entry_id IS NULL AND accounting_entry_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS finance_invoices_work_order_outgoing_uq
ON finance_invoices(work_order_id) WHERE direction='outgoing' AND work_order_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS invoice_delivery_log(
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
CREATE INDEX IF NOT EXISTS invoice_delivery_log_invoice_idx ON invoice_delivery_log(invoice_id,created_at DESC);

-- A főkönyv kanonikus sémája a payrollAccounting.ts által használt oszlopkészlet.
ALTER TABLE accounting_journal_entries
  ADD COLUMN IF NOT EXISTS document_no text,
  ADD COLUMN IF NOT EXISTS source_type text,
  ADD COLUMN IF NOT EXISTS source_id text,
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS created_by text,
  ADD COLUMN IF NOT EXISTS approved_by text,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE accounting_journal_lines
  ADD COLUMN IF NOT EXISTS journal_entry_id uuid,
  ADD COLUMN IF NOT EXISTS account_code text,
  ADD COLUMN IF NOT EXISTS account_name text,
  ADD COLUMN IF NOT EXISTS debit numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS credit numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS employee_id uuid,
  ADD COLUMN IF NOT EXISTS note text,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

-- Korábbi kísérleti sémák kötelező, eltérő nevű mezői blokkolhatják a kanonikus INSERT-et.
-- Az adatokat megtartjuk; csak a NOT NULL követelményt oldjuk fel.
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='accounting_journal_entries' AND column_name='entry_no') THEN
    EXECUTE 'ALTER TABLE accounting_journal_entries ALTER COLUMN entry_no DROP NOT NULL';
  END IF;
  IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='accounting_journal_entries' AND column_name='reference_type') THEN
    EXECUTE 'ALTER TABLE accounting_journal_entries ALTER COLUMN reference_type DROP NOT NULL';
  END IF;
  IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='accounting_journal_lines' AND column_name='entry_id') THEN
    EXECUTE 'ALTER TABLE accounting_journal_lines ALTER COLUMN entry_id DROP NOT NULL';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS accounting_journal_lines_journal_entry_idx ON accounting_journal_lines(journal_entry_id);
COMMIT;
