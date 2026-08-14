BEGIN;
ALTER TABLE financial_categories ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES financial_categories(id) ON DELETE SET NULL;
ALTER TABLE financial_categories ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 100;
ALTER TABLE financial_categories ADD COLUMN IF NOT EXISTS category_group text;
ALTER TABLE financial_categories ADD COLUMN IF NOT EXISTS locked boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS finance_payment_methods (
  id bigserial PRIMARY KEY,location_id text,code text NOT NULL,name text NOT NULL,method_type text NOT NULL DEFAULT 'custom',
  account_id uuid,fee_percent numeric(9,4) NOT NULL DEFAULT 0,fee_fixed numeric(14,2) NOT NULL DEFAULT 0,
  processing_days integer NOT NULL DEFAULT 0,brand_fees jsonb NOT NULL DEFAULT '{}'::jsonb,allow_installments boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,sort_order integer NOT NULL DEFAULT 100,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE finance_payment_methods ADD COLUMN IF NOT EXISTS rounding_step numeric(10,2) NOT NULL DEFAULT 0;
ALTER TABLE finance_payment_methods ADD COLUMN IF NOT EXISTS online boolean NOT NULL DEFAULT false;
ALTER TABLE finance_payment_methods ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false;
ALTER TABLE finance_payment_methods ADD COLUMN IF NOT EXISTS note text;
CREATE UNIQUE INDEX IF NOT EXISTS finance_payment_methods_location_code_uq ON finance_payment_methods(COALESCE(location_id,''),lower(code));
COMMIT;
