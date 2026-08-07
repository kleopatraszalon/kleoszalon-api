BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS finance_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
  direction text NOT NULL,
  invoice_no text,
  partner_name text,
  partner_tax_no text,
  issue_date date NOT NULL DEFAULT CURRENT_DATE,
  performance_date date NOT NULL DEFAULT CURRENT_DATE,
  due_date date NOT NULL DEFAULT CURRENT_DATE,
  currency text NOT NULL DEFAULT 'HUF',
  net_total numeric(14,2) NOT NULL DEFAULT 0,
  vat_total numeric(14,2) NOT NULL DEFAULT 0,
  gross_total numeric(14,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'draft',
  work_order_id text,
  purchase_order_id text,
  payment_account_id uuid REFERENCES financial_accounts(id) ON DELETE SET NULL,
  payment_movement_id uuid REFERENCES financial_movements(id) ON DELETE SET NULL,
  journal_entry_id uuid REFERENCES accounting_journal_entries(id) ON DELETE SET NULL,
  note text,
  approved_at timestamptz,
  approved_by text,
  paid_at timestamptz,
  posted_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT finance_invoices_direction_ck CHECK(direction IN ('incoming','outgoing')),
  CONSTRAINT finance_invoices_status_ck CHECK(status IN ('draft','approved','overdue','paid','cancelled')),
  CONSTRAINT finance_invoices_amount_ck CHECK(net_total >= 0 AND vat_total >= 0 AND gross_total >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS finance_invoices_invoice_no_uq
ON finance_invoices(direction, invoice_no)
WHERE invoice_no IS NOT NULL;

CREATE INDEX IF NOT EXISTS finance_invoices_location_status_idx
ON finance_invoices(location_id, status, due_date);

CREATE INDEX IF NOT EXISTS finance_invoices_workorder_idx
ON finance_invoices(work_order_id)
WHERE work_order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS finance_invoices_purchase_order_idx
ON finance_invoices(purchase_order_id)
WHERE purchase_order_id IS NOT NULL;

UPDATE finance_invoices
SET status='overdue', updated_at=now()
WHERE status='approved' AND due_date < CURRENT_DATE;

COMMIT;
