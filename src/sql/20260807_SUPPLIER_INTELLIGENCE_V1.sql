BEGIN;

CREATE TABLE IF NOT EXISTS suppliers (
  id bigserial PRIMARY KEY,
  name text NOT NULL UNIQUE,
  tax_number text,
  email text,
  phone text,
  contact_name text,
  address text,
  website text,
  payment_terms_days integer NOT NULL DEFAULT 0,
  default_lead_time_days integer NOT NULL DEFAULT 3,
  active boolean NOT NULL DEFAULT true,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS suppliers_active_name_idx ON suppliers(active, lower(name));

CREATE TABLE IF NOT EXISTS product_supplier_terms (
  id bigserial PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  supplier_id bigint NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  supplier_product_code text,
  unit_price numeric(14,2) NOT NULL DEFAULT 0,
  minimum_order_quantity numeric(14,3) NOT NULL DEFAULT 1,
  lead_time_days integer NOT NULL DEFAULT 3,
  preferred boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(product_id, supplier_id),
  CONSTRAINT product_supplier_terms_price_check CHECK (unit_price >= 0),
  CONSTRAINT product_supplier_terms_moq_check CHECK (minimum_order_quantity > 0),
  CONSTRAINT product_supplier_terms_lead_check CHECK (lead_time_days >= 0)
);

CREATE INDEX IF NOT EXISTS product_supplier_terms_product_idx ON product_supplier_terms(product_id, preferred DESC, active DESC);
CREATE INDEX IF NOT EXISTS product_supplier_terms_supplier_idx ON product_supplier_terms(supplier_id, active DESC);

ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS supplier_id bigint REFERENCES suppliers(id);

CREATE INDEX IF NOT EXISTS purchase_orders_supplier_id_idx ON purchase_orders(supplier_id, created_at DESC);

DO $$
BEGIN
  IF to_regprocedure('kleo_audit_row_change()') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS kleo_audit_suppliers ON suppliers;
    CREATE TRIGGER kleo_audit_suppliers AFTER INSERT OR UPDATE OR DELETE ON suppliers
      FOR EACH ROW EXECUTE FUNCTION kleo_audit_row_change();

    DROP TRIGGER IF EXISTS kleo_audit_product_supplier_terms ON product_supplier_terms;
    CREATE TRIGGER kleo_audit_product_supplier_terms AFTER INSERT OR UPDATE OR DELETE ON product_supplier_terms
      FOR EACH ROW EXECUTE FUNCTION kleo_audit_row_change();
  END IF;
END $$;

COMMIT;
