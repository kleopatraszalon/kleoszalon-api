BEGIN;

-- The live database uses UUID identifiers for products. To avoid future bigint/uuid
-- mismatches, derive all referenced identifier types from the existing schema.
DO $$
DECLARE
  v_product_id_type text;
  v_work_order_id_type text;
  v_location_id_type text;
BEGIN
  SELECT format_type(a.atttypid, a.atttypmod)
    INTO v_product_id_type
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname = 'products'
    AND a.attname = 'id'
    AND a.attnum > 0
    AND NOT a.attisdropped;

  SELECT format_type(a.atttypid, a.atttypmod)
    INTO v_work_order_id_type
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname = 'work_orders'
    AND a.attname = 'id'
    AND a.attnum > 0
    AND NOT a.attisdropped;

  SELECT format_type(a.atttypid, a.atttypmod)
    INTO v_location_id_type
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname = 'work_orders'
    AND a.attname = 'location_id'
    AND a.attnum > 0
    AND NOT a.attisdropped;

  IF v_product_id_type IS NULL THEN
    RAISE EXCEPTION 'products.id column not found';
  END IF;
  IF v_work_order_id_type IS NULL THEN
    RAISE EXCEPTION 'work_orders.id column not found';
  END IF;
  IF v_location_id_type IS NULL THEN
    RAISE EXCEPTION 'work_orders.location_id column not found';
  END IF;

  EXECUTE format($sql$
    CREATE TABLE IF NOT EXISTS product_stock_balances (
      id bigserial PRIMARY KEY,
      product_id %s NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      location_id %s,
      quantity numeric(14,3) NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  $sql$, v_product_id_type, v_location_id_type);

  EXECUTE format($sql$
    CREATE TABLE IF NOT EXISTS inventory_movements (
      id bigserial PRIMARY KEY,
      product_id %s NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
      location_id %s,
      work_order_id %s REFERENCES work_orders(id) ON DELETE SET NULL,
      movement_type varchar(32) NOT NULL,
      quantity numeric(14,3) NOT NULL,
      balance_after numeric(14,3),
      note text,
      created_by bigint,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT inventory_movements_quantity_nonzero CHECK (quantity <> 0),
      CONSTRAINT inventory_movements_type_check CHECK (
        movement_type IN ('opening','receipt','adjustment','work_order_consumption','work_order_reversal')
      )
    )
  $sql$, v_product_id_type, v_location_id_type, v_work_order_id_type);
END $$;

-- One stock balance per product/location, while still allowing a global stock row.
CREATE UNIQUE INDEX IF NOT EXISTS product_stock_balances_product_location_uq
  ON product_stock_balances(product_id, location_id)
  WHERE location_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS product_stock_balances_product_global_uq
  ON product_stock_balances(product_id)
  WHERE location_id IS NULL;

-- Prevent duplicate stock consumption for the same work order/product/location.
CREATE UNIQUE INDEX IF NOT EXISTS inventory_movements_workorder_product_location_consumption_uq
  ON inventory_movements(work_order_id, product_id, location_id)
  WHERE movement_type = 'work_order_consumption' AND location_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS inventory_movements_workorder_product_global_consumption_uq
  ON inventory_movements(work_order_id, product_id)
  WHERE movement_type = 'work_order_consumption' AND location_id IS NULL;

CREATE INDEX IF NOT EXISTS inventory_movements_product_created_idx
  ON inventory_movements(product_id, created_at DESC);

ALTER TABLE work_orders
  ADD COLUMN IF NOT EXISTS stock_consumed_at timestamptz;

COMMIT;
