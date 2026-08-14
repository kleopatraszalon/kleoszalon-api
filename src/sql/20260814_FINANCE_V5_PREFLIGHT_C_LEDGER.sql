BEGIN;
CREATE TABLE IF NOT EXISTS finance_documents (
  id bigserial PRIMARY KEY,location_id text,document_no text,document_type_code text,document_date date NOT NULL DEFAULT CURRENT_DATE,
  status text NOT NULL DEFAULT 'active',partner_id bigint,account_id uuid,direction text NOT NULL DEFAULT 'neutral',amount numeric(14,2) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'HUF',content text,note text,reference_type text,reference_id text,movement_id uuid,
  created_by text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE finance_documents ADD COLUMN IF NOT EXISTS document_type text;
ALTER TABLE finance_documents ADD COLUMN IF NOT EXISTS document_number text;
ALTER TABLE finance_documents ADD COLUMN IF NOT EXISTS partner_name text;
ALTER TABLE finance_documents ADD COLUMN IF NOT EXISTS gross_total numeric(14,2) NOT NULL DEFAULT 0;

ALTER TABLE financial_movements ADD COLUMN IF NOT EXISTS partner_id bigint;
ALTER TABLE financial_movements ADD COLUMN IF NOT EXISTS payment_method_id bigint;
ALTER TABLE financial_movements ADD COLUMN IF NOT EXISTS document_id bigint;
ALTER TABLE financial_movements ADD COLUMN IF NOT EXISTS client_id text;
ALTER TABLE financial_movements ADD COLUMN IF NOT EXISTS employee_id text;
ALTER TABLE financial_movements ADD COLUMN IF NOT EXISTS service_id text;
ALTER TABLE financial_movements ADD COLUMN IF NOT EXISTS product_id text;
ALTER TABLE financial_movements ADD COLUMN IF NOT EXISTS visit_id text;
ALTER TABLE financial_movements ADD COLUMN IF NOT EXISTS work_order_id text;
ALTER TABLE financial_movements ADD COLUMN IF NOT EXISTS payment_status text NOT NULL DEFAULT 'posted';
ALTER TABLE financial_movements ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
ALTER TABLE financial_movements ADD COLUMN IF NOT EXISTS cancelled_by text;
ALTER TABLE financial_movements ADD COLUMN IF NOT EXISTS fee_for_movement_id uuid REFERENCES financial_movements(id) ON DELETE SET NULL;
ALTER TABLE financial_movements ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
COMMIT;
