-- Workorder list performance indexes
-- Supports the dominant list order and the optional location-filtered list.

CREATE INDEX IF NOT EXISTS idx_work_orders_created_at_desc
  ON work_orders (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_work_orders_location_created_at_desc
  ON work_orders (location_id, created_at DESC);
