BEGIN;

CREATE TABLE IF NOT EXISTS product_stock_balances (
  product_id bigint NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  location_id bigint,
  quantity numeric(14,3) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, location_id)
);

CREATE TABLE IF NOT EXISTS inventory_movements (
  id bigserial PRIMARY KEY,
  product_id bigint NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  location_id bigint,
  work_order_id bigint REFERENCES work_orders(id) ON DELETE SET NULL,
  movement_type varchar(32) NOT NULL,
  quantity numeric(14,3) NOT NULL,
  balance_after numeric(14,3),
  note text,
  created_by bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inventory_movements_quantity_nonzero CHECK (quantity <> 0),
  CONSTRAINT inventory_movements_type_check CHECK (movement_type IN ('opening','receipt','adjustment','work_order_consumption','work_order_reversal'))
);

CREATE UNIQUE INDEX IF NOT EXISTS inventory_movements_workorder_product_consumption_uq
  ON inventory_movements(work_order_id, product_id, COALESCE(location_id, 0))
  WHERE movement_type = 'work_order_consumption';

CREATE INDEX IF NOT EXISTS inventory_movements_product_created_idx
  ON inventory_movements(product_id, created_at DESC);

ALTER TABLE work_orders
  ADD COLUMN IF NOT EXISTS stock_consumed_at timestamptz;

COMMIT;
