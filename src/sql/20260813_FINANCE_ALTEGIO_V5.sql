BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Accounts / cash registers --------------------------------------------------
ALTER TABLE financial_accounts ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 100;
ALTER TABLE financial_accounts ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false;
ALTER TABLE financial_accounts ADD COLUMN IF NOT EXISTS allow_negative_balance boolean NOT NULL DEFAULT true;
ALTER TABLE financial_accounts ADD COLUMN IF NOT EXISTS account_number text;
ALTER TABLE financial_accounts ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE financial_accounts DROP CONSTRAINT IF EXISTS financial_accounts_type_ck;
ALTER TABLE financial_accounts ADD CONSTRAINT financial_accounts_type_ck
  CHECK (account_type IN ('cash','bank','card','online','voucher','other'));
CREATE INDEX IF NOT EXISTS financial_accounts_location_active_idx
  ON financial_accounts(location_id,active,sort_order,name);

-- Counterparties / partners -------------------------------------------------
CREATE TABLE IF NOT EXISTS finance_partners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid REFERENCES locations(id) ON DELETE CASCADE,
  partner_type text NOT NULL DEFAULT 'supplier',
  name text NOT NULL,
  company_name text,
  tax_number text,
  registration_number text,
  email text,
  phone text,
  contact_name text,
  address text,
  city text,
  postal_code text,
  country_code text NOT NULL DEFAULT 'HU',
  payment_terms_days integer NOT NULL DEFAULT 0,
  opening_balance numeric(14,2) NOT NULL DEFAULT 0,
  external_source text,
  external_id text,
  note text,
  active boolean NOT NULL DEFAULT true,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT finance_partners_type_ck CHECK(partner_type IN ('supplier','customer','employee','other'))
);
CREATE UNIQUE INDEX IF NOT EXISTS finance_partners_location_name_uq
  ON finance_partners(COALESCE(location_id,'00000000-0000-0000-0000-000000000000'::uuid),lower(name));
CREATE INDEX IF NOT EXISTS finance_partners_location_active_idx ON finance_partners(location_id,active,name);
CREATE UNIQUE INDEX IF NOT EXISTS finance_partners_external_uq
  ON finance_partners(external_source,external_id) WHERE external_source IS NOT NULL AND external_id IS NOT NULL;

-- Payment categories --------------------------------------------------------
ALTER TABLE financial_categories ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES financial_categories(id) ON DELETE SET NULL;
ALTER TABLE financial_categories ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 100;
ALTER TABLE financial_categories ADD COLUMN IF NOT EXISTS category_group text;
ALTER TABLE financial_categories ADD COLUMN IF NOT EXISTS locked boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS financial_categories_parent_idx ON financial_categories(parent_id,sort_order,name);

INSERT INTO financial_categories(direction,name,system_key,category_group,locked,sort_order)
VALUES
 ('income','Szolgáltatások értékesítése','service_sales','sales',true,10),
 ('income','Termékértékesítés','product_sales','sales',true,20),
 ('income','Bérlet / utalvány értékesítés','membership_sales','sales',true,30),
 ('expense','Alapanyag-beszerzés','materials_expense','procurement',true,40),
 ('expense','Bankkártya elfogadási díj','acquiring_fee','fees',true,50),
 ('expense','Bér és jutalék','payroll_expense','payroll',true,60),
 ('expense','Bérleti díj','rent_expense','overhead',false,70),
 ('expense','Rezsi / közüzem','utilities_expense','overhead',false,80),
 ('expense','Marketing','marketing_expense','overhead',false,90)
ON CONFLICT(system_key) DO UPDATE SET name=EXCLUDED.name,category_group=EXCLUDED.category_group,sort_order=EXCLUDED.sort_order;

-- Payment methods and fees --------------------------------------------------
CREATE TABLE IF NOT EXISTS finance_payment_methods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid REFERENCES locations(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  method_type text NOT NULL DEFAULT 'custom',
  account_id uuid REFERENCES financial_accounts(id) ON DELETE SET NULL,
  fee_percent numeric(8,4) NOT NULL DEFAULT 0,
  fee_fixed numeric(14,2) NOT NULL DEFAULT 0,
  processing_days integer NOT NULL DEFAULT 0,
  rounding_step numeric(10,2) NOT NULL DEFAULT 0,
  online boolean NOT NULL DEFAULT false,
  is_default boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 100,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT finance_payment_methods_type_ck CHECK(method_type IN ('cash','debit_card','credit_card','bank_transfer','online','voucher','custom')),
  CONSTRAINT finance_payment_methods_fee_ck CHECK(fee_percent>=0 AND fee_percent<=100 AND fee_fixed>=0 AND processing_days>=0)
);
CREATE UNIQUE INDEX IF NOT EXISTS finance_payment_methods_location_code_uq
  ON finance_payment_methods(COALESCE(location_id,'00000000-0000-0000-0000-000000000000'::uuid),lower(code));

INSERT INTO finance_payment_methods(code,name,method_type,online,sort_order)
VALUES
 ('cash','Készpénz','cash',false,10),
 ('card','Bankkártya','debit_card',false,20),
 ('transfer','Banki átutalás','bank_transfer',false,30),
 ('online','Online fizetés','online',true,40),
 ('voucher','Utalvány / ajándékkártya','voucher',false,50)
ON CONFLICT DO NOTHING;

-- Generic finance document register ----------------------------------------
CREATE TABLE IF NOT EXISTS finance_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
  document_type text NOT NULL,
  document_number text,
  document_date date NOT NULL DEFAULT CURRENT_DATE,
  direction text NOT NULL DEFAULT 'neutral',
  partner_id uuid REFERENCES finance_partners(id) ON DELETE SET NULL,
  partner_name text,
  gross_total numeric(14,2) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'HUF',
  reference_type text,
  reference_id text,
  status text NOT NULL DEFAULT 'active',
  note text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT finance_documents_direction_ck CHECK(direction IN ('income','expense','neutral')),
  CONSTRAINT finance_documents_status_ck CHECK(status IN ('draft','active','cancelled','archived'))
);
CREATE INDEX IF NOT EXISTS finance_documents_location_date_idx ON finance_documents(location_id,document_date DESC,created_at DESC);
CREATE INDEX IF NOT EXISTS finance_documents_partner_idx ON finance_documents(partner_id,document_date DESC);

-- Enrich the existing audited money movement ledger ------------------------
ALTER TABLE financial_movements ADD COLUMN IF NOT EXISTS partner_id uuid REFERENCES finance_partners(id) ON DELETE SET NULL;
ALTER TABLE financial_movements ADD COLUMN IF NOT EXISTS payment_method_id uuid REFERENCES finance_payment_methods(id) ON DELETE SET NULL;
ALTER TABLE financial_movements ADD COLUMN IF NOT EXISTS document_id uuid REFERENCES finance_documents(id) ON DELETE SET NULL;
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
CREATE INDEX IF NOT EXISTS financial_movements_partner_idx ON financial_movements(partner_id,occurred_at DESC);
CREATE INDEX IF NOT EXISTS financial_movements_payment_method_idx ON financial_movements(payment_method_id,occurred_at DESC);
CREATE INDEX IF NOT EXISTS financial_movements_reference_idx ON financial_movements(reference_type,reference_id);
CREATE INDEX IF NOT EXISTS financial_movements_dimensions_idx ON financial_movements(location_id,client_id,employee_id,occurred_at DESC);

-- Finance configuration (never stores provider secrets) --------------------
CREATE TABLE IF NOT EXISTS finance_settings_v5 (
  location_key text PRIMARY KEY,
  online_payment_enabled boolean NOT NULL DEFAULT false,
  online_payment_provider text,
  online_sale_memberships boolean NOT NULL DEFAULT false,
  online_booking_prepayment boolean NOT NULL DEFAULT false,
  payment_link_enabled boolean NOT NULL DEFAULT false,
  invoicing_provider text NOT NULL DEFAULT 'billingo',
  invoicing_connected boolean NOT NULL DEFAULT false,
  cash_rounding_step numeric(10,2) NOT NULL DEFAULT 0,
  require_partner_on_expense boolean NOT NULL DEFAULT false,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO finance_settings_v5(location_key) VALUES('__global__') ON CONFLICT(location_key) DO NOTHING;

-- Safe one-time projection of procurement suppliers into Finance partners.
-- The supplier remains the procurement source of truth; the finance row is a
-- counterparty projection linked by external_source/external_id.
DO $$
BEGIN
  IF to_regclass('public.suppliers') IS NOT NULL THEN
    INSERT INTO finance_partners(partner_type,name,company_name,tax_number,email,phone,contact_name,address,payment_terms_days,external_source,external_id,note)
    SELECT 'supplier',s.name,s.name,s.tax_number,s.email,s.phone,s.contact_name,s.address,COALESCE(s.payment_terms_days,0),'procurement_supplier',s.id::text,s.note
    FROM suppliers s
    WHERE COALESCE(s.active,true)=true
    ON CONFLICT(external_source,external_id) WHERE external_source IS NOT NULL AND external_id IS NOT NULL
    DO UPDATE SET name=EXCLUDED.name,company_name=EXCLUDED.company_name,tax_number=EXCLUDED.tax_number,email=EXCLUDED.email,phone=EXCLUDED.phone,contact_name=EXCLUDED.contact_name,address=EXCLUDED.address,payment_terms_days=EXCLUDED.payment_terms_days,updated_at=now();
  END IF;
END $$;

COMMIT;
