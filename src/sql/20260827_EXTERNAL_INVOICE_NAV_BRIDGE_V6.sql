BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- NAV Online Számla konfiguráció jogi személyhez kötése.
ALTER TABLE nav_online_invoice_settings
  ADD COLUMN IF NOT EXISTS legal_entity_id uuid REFERENCES legal_entities(id) ON DELETE CASCADE;

-- A korábbi egy-telephely/egy-konfiguráció korlátozás feloldása. Több cég ugyanabban
-- a szalonban külön NAV technikai felhasználóval kezelhető.
ALTER TABLE nav_online_invoice_settings
  DROP CONSTRAINT IF EXISTS nav_online_invoice_settings_location_id_key;
DROP INDEX IF EXISTS nav_online_invoice_settings_location_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_nav_online_invoice_settings_entity_location
  ON nav_online_invoice_settings(
    COALESCE(legal_entity_id,'00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(location_id,'00000000-0000-0000-0000-000000000000'::uuid)
  );
CREATE INDEX IF NOT EXISTS nav_online_invoice_settings_entity_idx
  ON nav_online_invoice_settings(legal_entity_id,location_id,active);

-- Külső számla NAV-hoz szükséges ellenőrzött fejlécadatai.
ALTER TABLE external_financial_documents ADD COLUMN IF NOT EXISTS performance_date date;
ALTER TABLE external_financial_documents ADD COLUMN IF NOT EXISTS due_date date;
ALTER TABLE external_financial_documents ADD COLUMN IF NOT EXISTS customer_vat_status text;
ALTER TABLE external_financial_documents ADD COLUMN IF NOT EXISTS customer_country_code varchar(2) DEFAULT 'HU';
ALTER TABLE external_financial_documents ADD COLUMN IF NOT EXISTS customer_postal_code text;
ALTER TABLE external_financial_documents ADD COLUMN IF NOT EXISTS customer_city text;
ALTER TABLE external_financial_documents ADD COLUMN IF NOT EXISTS customer_address text;
ALTER TABLE external_financial_documents ADD COLUMN IF NOT EXISTS invoice_type text NOT NULL DEFAULT 'NORMAL';
ALTER TABLE external_financial_documents ADD COLUMN IF NOT EXISTS original_invoice_number text;
ALTER TABLE external_financial_documents ADD COLUMN IF NOT EXISTS modification_index integer;
ALTER TABLE external_financial_documents ADD COLUMN IF NOT EXISTS finance_invoice_id uuid REFERENCES finance_invoices(id) ON DELETE SET NULL;
ALTER TABLE external_financial_documents ADD COLUMN IF NOT EXISTS nav_prepared_at timestamptz;
ALTER TABLE external_financial_documents ADD COLUMN IF NOT EXISTS nav_submitted_at timestamptz;

CREATE TABLE IF NOT EXISTS external_financial_document_lines(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES external_financial_documents(id) ON DELETE CASCADE,
  line_number integer NOT NULL,
  description text NOT NULL,
  quantity numeric(14,4) NOT NULL DEFAULT 1,
  unit_of_measure text NOT NULL DEFAULT 'PIECE',
  unit_price_net numeric(14,4) NOT NULL DEFAULT 0,
  vat_rate numeric(8,4) NOT NULL DEFAULT 0.27,
  net_amount numeric(14,2) NOT NULL DEFAULT 0,
  vat_amount numeric(14,2) NOT NULL DEFAULT 0,
  gross_amount numeric(14,2) NOT NULL DEFAULT 0,
  nav_line_number_reference integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(document_id,line_number)
);

-- A NAV v3 életciklus mezői régebbi adatbázisokhoz is idempotensen létrejönnek.
ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS legal_entity_id uuid REFERENCES legal_entities(id) ON DELETE RESTRICT;
ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS document_kind text;
ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS issued_at timestamptz;
ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS issued_by text;
ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS customer_vat_status text;
ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS exchange_rate numeric(14,6) NOT NULL DEFAULT 1;
ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS original_invoice_number text;
ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS modification_index integer;
ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS nav_validation_status text NOT NULL DEFAULT 'not_validated';
ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS nav_validated_at timestamptz;
ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS nav_validation_errors jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS nav_xsd_validation_status text;
ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS nav_xsd_validated_at timestamptz;
ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS nav_xsd_validation_errors jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS nav_xsd_schema_revision text;
ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS nav_xsd_xml_sha256 text;
ALTER TABLE finance_invoice_lines ADD COLUMN IF NOT EXISTS nav_line_number_reference integer;

COMMIT;
