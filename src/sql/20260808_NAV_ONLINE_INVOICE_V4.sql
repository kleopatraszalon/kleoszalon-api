BEGIN;

CREATE TABLE IF NOT EXISTS nav_online_invoice_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NULL,
  active boolean NOT NULL DEFAULT true,
  environment text NOT NULL DEFAULT 'test' CHECK(environment IN ('test','live')),
  supplier_name text NOT NULL,
  supplier_tax_number varchar(11) NOT NULL,
  supplier_group_member_tax_number varchar(11),
  supplier_bank_account text,
  supplier_country_code varchar(2) NOT NULL DEFAULT 'HU',
  supplier_postal_code text NOT NULL,
  supplier_city text NOT NULL,
  supplier_address text NOT NULL,
  invoice_prefix text NOT NULL DEFAULT 'KLEO',
  default_vat_rate numeric(6,4) NOT NULL DEFAULT 0.27,
  currency varchar(3) NOT NULL DEFAULT 'HUF',
  technical_login text,
  technical_password text,
  signing_key text,
  exchange_key text,
  software_id varchar(18) NOT NULL DEFAULT 'KLEOSZALONVIR0001',
  software_name text NOT NULL DEFAULT 'Kleoszalon VIR',
  software_operation text NOT NULL DEFAULT 'ONLINE_SERVICE',
  software_main_version text NOT NULL DEFAULT '1.0',
  software_dev_name text NOT NULL DEFAULT 'Kleoszalon Kft.',
  software_dev_contact text,
  software_dev_country_code varchar(2) NOT NULL DEFAULT 'HU',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(location_id)
);

CREATE TABLE IF NOT EXISTS nav_invoice_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL,
  work_order_id uuid,
  invoice_number text NOT NULL,
  operation text NOT NULL DEFAULT 'CREATE' CHECK(operation IN ('CREATE','MODIFY','STORNO')),
  environment text NOT NULL CHECK(environment IN ('test','live')),
  request_id text,
  transaction_id text,
  status text NOT NULL DEFAULT 'prepared' CHECK(status IN ('prepared','submitting','submitted','processing','done','warning','error','aborted')),
  invoice_xml text,
  request_xml text,
  response_xml text,
  nav_result jsonb,
  error_code text,
  error_message text,
  submitted_at timestamptz,
  completed_at timestamptz,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS nav_invoice_submissions_invoice_idx ON nav_invoice_submissions(invoice_id,created_at DESC);
CREATE INDEX IF NOT EXISTS nav_invoice_submissions_transaction_idx ON nav_invoice_submissions(transaction_id) WHERE transaction_id IS NOT NULL;

ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS nav_status text NOT NULL DEFAULT 'not_submitted';
ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS nav_transaction_id text;
ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS nav_submission_id uuid;
ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS invoice_type text NOT NULL DEFAULT 'NORMAL';
ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS original_invoice_id uuid;
ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS customer_name text;
ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS customer_tax_number text;
ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS customer_country_code varchar(2) DEFAULT 'HU';
ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS customer_postal_code text;
ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS customer_city text;
ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS customer_address text;
ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS payment_method text;
ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS payment_date date;
ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS appearance text NOT NULL DEFAULT 'ELECTRONIC';

CREATE TABLE IF NOT EXISTS finance_invoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES finance_invoices(id) ON DELETE RESTRICT,
  line_number integer NOT NULL,
  description text NOT NULL,
  quantity numeric(14,4) NOT NULL DEFAULT 1,
  unit_of_measure text NOT NULL DEFAULT 'PIECE',
  unit_price_net numeric(14,4) NOT NULL DEFAULT 0,
  vat_rate numeric(8,4) NOT NULL DEFAULT 0.27,
  net_amount numeric(14,2) NOT NULL,
  vat_amount numeric(14,2) NOT NULL,
  gross_amount numeric(14,2) NOT NULL,
  service_id text,
  product_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(invoice_id,line_number)
);

COMMIT;
