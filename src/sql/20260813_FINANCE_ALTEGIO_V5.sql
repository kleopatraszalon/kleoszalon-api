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
-- The cashier/legacy Altegio module predates Finance V5 and created this table
-- with bigint ids and text location ids. Finance V5 intentionally keeps that
-- physical key format so existing partner references remain valid.
CREATE TABLE IF NOT EXISTS finance_partners (
  id bigserial PRIMARY KEY,
  location_id text,
  partner_type text NOT NULL DEFAULT 'supplier',
  name text NOT NULL,
  tax_number text,
  email text,
  phone text,
  contact_name text,
  address text,
  note text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE finance_partners ADD COLUMN IF NOT EXISTS company_name text;
ALTER TABLE finance_partners ADD COLUMN IF NOT EXISTS registration_number text;
ALTER TABLE finance_partners ADD COLUMN IF NOT EXISTS city text;
ALTER TABLE finance_partners ADD COLUMN IF NOT EXISTS postal_code text;
ALTER TABLE finance_partners ADD COLUMN IF NOT EXISTS country_code text NOT NULL DEFAULT 'HU';
ALTER TABLE finance_partners ADD COLUMN IF NOT EXISTS payment_terms_days integer NOT NULL DEFAULT 0;
ALTER TABLE finance_partners ADD COLUMN IF NOT EXISTS opening_balance numeric(14,2) NOT NULL DEFAULT 0;
ALTER TABLE finance_partners ADD COLUMN IF NOT EXISTS external_source text;
ALTER TABLE finance_partners ADD COLUMN IF NOT EXISTS external_id text;
ALTER TABLE finance_partners ADD COLUMN IF NOT EXISTS supplier_id text;
ALTER TABLE finance_partners ADD COLUMN IF NOT EXISTS created_by text;
ALTER TABLE finance_partners DROP CONSTRAINT IF EXISTS finance_partners_type_ck;
ALTER TABLE finance_partners ADD CONSTRAINT finance_partners_type_ck
  CHECK(partner_type IN ('supplier','customer','employee','company','other')) NOT VALID;
CREATE UNIQUE INDEX IF NOT EXISTS finance_partners_location_name_uq
  ON finance_partners(COALESCE(location_id,''),lower(name));
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
-- Keep bigint/text keys for compatibility with cashierAltegioParity and the
-- older financeAltegio router; V5 adds its richer attributes to the same rows.
CREATE TABLE IF NOT EXISTS finance_payment_methods (
  id bigserial PRIMARY KEY,
  location_id text,
  code text NOT NULL,
  name text NOT NULL,
  method_type text NOT NULL DEFAULT 'custom',
  account_id uuid,
  fee_percent numeric(9,4) NOT NULL DEFAULT 0,
  fee_fixed numeric(14,2) NOT NULL DEFAULT 0,
  processing_days integer NOT NULL DEFAULT 0,
  brand_fees jsonb NOT NULL DEFAULT '{}'::jsonb,
  allow_installments boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE finance_payment_methods ADD COLUMN IF NOT EXISTS rounding_step numeric(10,2) NOT NULL DEFAULT 0;
ALTER TABLE finance_payment_methods ADD COLUMN IF NOT EXISTS online boolean NOT NULL DEFAULT false;
ALTER TABLE finance_payment_methods ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false;
ALTER TABLE finance_payment_methods ADD COLUMN IF NOT EXISTS note text;
ALTER TABLE finance_payment_methods DROP CONSTRAINT IF EXISTS finance_payment_methods_type_ck;
ALTER TABLE finance_payment_methods ADD CONSTRAINT finance_payment_methods_type_ck
  CHECK(method_type IN ('cash','card','debit_card','credit_card','bank_transfer','online','online_card','voucher','custom')) NOT VALID;
ALTER TABLE finance_payment_methods DROP CONSTRAINT IF EXISTS finance_payment_methods_fee_ck;
ALTER TABLE finance_payment_methods ADD CONSTRAINT finance_payment_methods_fee_ck
  CHECK(fee_percent>=0 AND fee_percent<=100 AND fee_fixed>=0 AND processing_days>=0) NOT VALID;
CREATE UNIQUE INDEX IF NOT EXISTS finance_payment_methods_location_code_uq
  ON finance_payment_methods(COALESCE(location_id,''),lower(code));

INSERT INTO finance_payment_methods(code,name,method_type,online,sort_order)
VALUES
 ('cash','Készpénz','cash',false,10),
 ('card','Bankkártya','card',false,20),
 ('transfer','Banki átutalás','bank_transfer',false,30),
 ('online','Online fizetés','online_card',true,40),
 ('voucher','Utalvány / ajándékkártya','voucher',false,50)
ON CONFLICT DO NOTHING;

-- Generic finance document register ----------------------------------------
-- The older finance module may already own this table with bigint ids. Extend
-- it rather than creating an incompatible UUID duplicate.
CREATE TABLE IF NOT EXISTS finance_documents (
  id bigserial PRIMARY KEY,
  location_id text,
  document_no text,
  document_type_code text,
  document_date date NOT NULL DEFAULT CURRENT_DATE,
  status text NOT NULL DEFAULT 'active',
  partner_id bigint,
  account_id uuid,
  direction text NOT NULL DEFAULT 'neutral',
  amount numeric(14,2) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'HUF',
  content text,
  note text,
  reference_type text,
  reference_id text,
  movement_id uuid,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE finance_documents ADD COLUMN IF NOT EXISTS document_type text;
ALTER TABLE finance_documents ADD COLUMN IF NOT EXISTS document_number text;
ALTER TABLE finance_documents ADD COLUMN IF NOT EXISTS partner_name text;
ALTER TABLE finance_documents ADD COLUMN IF NOT EXISTS gross_total numeric(14,2) NOT NULL DEFAULT 0;
UPDATE finance_documents
SET document_type=COALESCE(document_type,document_type_code,'other'),
    document_number=COALESCE(document_number,document_no),
    gross_total=CASE WHEN gross_total=0 THEN COALESCE(amount,0) ELSE gross_total END;
CREATE INDEX IF NOT EXISTS finance_documents_location_date_idx ON finance_documents(location_id,document_date DESC,created_at DESC);
CREATE INDEX IF NOT EXISTS finance_documents_partner_idx ON finance_documents(partner_id,document_date DESC);

-- Enrich the existing audited money movement ledger ------------------------
-- partner/payment/document ids follow the already deployed bigint master
-- tables. Account/category/movement ids remain UUID as originally designed.
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
