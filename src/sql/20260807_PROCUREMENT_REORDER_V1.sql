BEGIN;

CREATE TABLE IF NOT EXISTS purchase_orders (
  id bigserial PRIMARY KEY,
  location_id text,
  supplier_name text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  expected_at date,
  note text,
  created_by text,
  updated_by text,
  ordered_at timestamptz,
  received_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT purchase_orders_status_check CHECK (status IN ('draft','ordered','partially_received','received','cancelled'))
);

CREATE INDEX IF NOT EXISTS purchase_orders_location_status_idx ON purchase_orders(location_id,status,created_at DESC);
CREATE INDEX IF NOT EXISTS purchase_orders_supplier_idx ON purchase_orders(lower(supplier_name),created_at DESC);

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id bigserial PRIMARY KEY,
  purchase_order_id bigint NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id),
  ordered_quantity numeric(14,3) NOT NULL,
  received_quantity numeric(14,3) NOT NULL DEFAULT 0,
  unit_cost numeric(14,2) NOT NULL DEFAULT 0,
  actual_unit_cost numeric(14,2),
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT purchase_order_items_qty_check CHECK (ordered_quantity > 0 AND received_quantity >= 0),
  CONSTRAINT purchase_order_items_received_check CHECK (received_quantity <= ordered_quantity)
);

CREATE INDEX IF NOT EXISTS purchase_order_items_order_idx ON purchase_order_items(purchase_order_id,id);
CREATE INDEX IF NOT EXISTS purchase_order_items_product_idx ON purchase_order_items(product_id,created_at DESC);

DO $$
BEGIN
  IF to_regprocedure('kleo_audit_row_change()') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS kleo_audit_purchase_orders ON purchase_orders;
    CREATE TRIGGER kleo_audit_purchase_orders AFTER INSERT OR UPDATE OR DELETE ON purchase_orders FOR EACH ROW EXECUTE FUNCTION kleo_audit_row_change();
    DROP TRIGGER IF EXISTS kleo_audit_purchase_order_items ON purchase_order_items;
    CREATE TRIGGER kleo_audit_purchase_order_items AFTER INSERT OR UPDATE OR DELETE ON purchase_order_items FOR EACH ROW EXECUTE FUNCTION kleo_audit_row_change();
  END IF;
END $$;

COMMIT;
