BEGIN;
ALTER TABLE financial_accounts ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 100;
ALTER TABLE financial_accounts ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false;
ALTER TABLE financial_accounts ADD COLUMN IF NOT EXISTS allow_negative_balance boolean NOT NULL DEFAULT true;
ALTER TABLE financial_accounts ADD COLUMN IF NOT EXISTS account_number text;
ALTER TABLE financial_accounts ADD COLUMN IF NOT EXISTS archived_at timestamptz;

CREATE TABLE IF NOT EXISTS finance_partners (
  id bigserial PRIMARY KEY,location_id text,partner_type text NOT NULL DEFAULT 'supplier',name text NOT NULL,
  tax_number text,email text,phone text,contact_name text,address text,note text,active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
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
CREATE UNIQUE INDEX IF NOT EXISTS finance_partners_location_name_uq ON finance_partners(COALESCE(location_id,''),lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS finance_partners_external_uq ON finance_partners(external_source,external_id) WHERE external_source IS NOT NULL AND external_id IS NOT NULL;
COMMIT;
