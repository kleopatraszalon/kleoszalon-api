BEGIN;

ALTER TABLE product_stock_balances
  ADD COLUMN IF NOT EXISTS min_quantity numeric(14,3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS unit_cost numeric(14,2) NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS product_stock_balances_low_stock_idx
  ON product_stock_balances (location_id, quantity, min_quantity);

COMMIT;
