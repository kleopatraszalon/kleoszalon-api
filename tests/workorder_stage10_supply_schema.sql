-- Stage 10 integration-only schema additions.
-- The common work-order test schema is loaded before this file.

ALTER TABLE product_stock_balances
  ADD COLUMN IF NOT EXISTS unit_cost numeric(14,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS min_quantity numeric(14,3) NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS product_stock_balances_product_global_uq
  ON product_stock_balances(product_id) WHERE location_id IS NULL;

-- Create this before workOrderFinalization.ensureRuntimeSchema so the Stage 10
-- fields and text actor identifier match the inventory/central-supply routes.
CREATE TABLE IF NOT EXISTS inventory_movements(
  id bigserial PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  location_id uuid,
  work_order_id uuid REFERENCES work_orders(id) ON DELETE SET NULL,
  movement_type varchar(32) NOT NULL,
  quantity numeric(14,3) NOT NULL,
  balance_after numeric(14,3),
  unit_cost numeric(14,4) NOT NULL DEFAULT 0,
  stock_value_after numeric(16,4),
  note text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS inventory_movements_workorder_product_location_consumption_uq
  ON inventory_movements(work_order_id,product_id,location_id)
  WHERE movement_type='work_order_consumption' AND location_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS inventory_movements_workorder_product_global_consumption_uq
  ON inventory_movements(work_order_id,product_id)
  WHERE movement_type='work_order_consumption' AND location_id IS NULL;

-- Minimal procurement master data needed to verify the central-shortage -> PO branch.
CREATE TABLE IF NOT EXISTS suppliers(
  id bigserial PRIMARY KEY,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS product_supplier_terms(
  id bigserial PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES products(id),
  supplier_id bigint NOT NULL REFERENCES suppliers(id),
  unit_price numeric(14,4) NOT NULL DEFAULT 0,
  minimum_order_quantity numeric(14,3) NOT NULL DEFAULT 1,
  lead_time_days int NOT NULL DEFAULT 7,
  preferred boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS purchase_orders(
  id bigserial PRIMARY KEY,
  location_id uuid,
  supplier_id bigint REFERENCES suppliers(id),
  supplier_name text,
  status text NOT NULL DEFAULT 'draft',
  expected_at date,
  note text,
  created_by text,
  approval_status text NOT NULL DEFAULT 'not_requested',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS purchase_order_items(
  id bigserial PRIMARY KEY,
  purchase_order_id bigint NOT NULL REFERENCES purchase_orders(id),
  product_id uuid NOT NULL REFERENCES products(id),
  ordered_quantity numeric(14,3) NOT NULL,
  unit_cost numeric(14,4) NOT NULL DEFAULT 0,
  note text
);
