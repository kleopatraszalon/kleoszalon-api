BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Külső pénzügyi dokumentumok alap-sémája itt is létrejön, hogy a NAV bridge
-- migráció tiszta adatbázison se függjön attól, hogy egy HTTP route runtime
-- ensureSchema() bootstrapja korábban lefutott-e.
CREATE TABLE IF NOT EXISTS external_financial_import_batches(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id) ON DELETE RESTRICT,
  location_id uuid REFERENCES locations(id) ON DELETE RESTRICT,
  source text NOT NULL,
  import_profile text NOT NULL DEFAULT 'generic_file',
  file_name text NOT NULL,
  mime_type text NOT NULL,
  content_sha256 text NOT NULL,
  payload bytea NOT NULL,
  imported_count integer NOT NULL DEFAULT 0,
  duplicate_count integer NOT NULL DEFAULT 0,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(source IN('invee','google_drive','altegio','file_upload','manual'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_external_import_batch_hash
  ON external_financial_import_batches(legal_entity_id,source,content_sha256);

CREATE TABLE IF NOT EXISTS external_financial_documents(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id) ON DELETE RESTRICT,
  location_id uuid REFERENCES locations(id) ON DELETE RESTRICT,
  import_batch_id uuid REFERENCES external_financial_import_batches(id) ON DELETE SET NULL,
  source text NOT NULL,
  document_type text NOT NULL DEFAULT 'other',
  external_id text,
  external_document_number text,
  issue_date date,
  counterparty_name text,
  counterparty_tax_number text,
  currency text NOT NULL DEFAULT 'HUF',
  net_amount numeric(14,2) NOT NULL DEFAULT 0,
  vat_amount numeric(14,2) NOT NULL DEFAULT 0,
  gross_amount numeric(14,2) NOT NULL DEFAULT 0,
  payment_method text,
  work_order_id text,
  source_url text,
  source_file_id text,
  file_name text,
  mime_type text,
  content_sha256 text,
  status text NOT NULL DEFAULT 'pending_review',
  nav_reporting_owner text NOT NULL DEFAULT 'external',
  nav_excluded boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text,
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(source IN('invee','google_drive','altegio','file_upload','manual')),
  CHECK(document_type IN('invoice','receipt','credit_note','void_receipt','transaction','other')),
  CHECK(status IN('pending_review','approved','rejected','duplicate','voided')),
  CHECK(nav_reporting_owner IN('vir','external','not_applicable')),
  CHECK(nav_reporting_owner<>'external' OR nav_excluded=true)
);
ALTER TABLE external_financial_documents
  ADD COLUMN IF NOT EXISTS import_batch_id uuid REFERENCES external_financial_import_batches(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_external_document_source_id
  ON external_financial_documents(legal_entity_id,source,external_id) WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_external_document_hash
  ON external_financial_documents(legal_entity_id,content_sha256) WHERE content_sha256 IS NOT NULL;
CREATE INDEX IF NOT EXISTS external_financial_documents_review_idx
  ON external_financial_documents(status,legal_entity_id,issue_date DESC,created_at DESC);

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
