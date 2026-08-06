BEGIN;

ALTER TABLE work_orders
  ADD COLUMN IF NOT EXISTS started_at timestamptz,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS status_updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS work_orders_status_idx ON work_orders(status);
CREATE INDEX IF NOT EXISTS work_orders_started_at_idx ON work_orders(started_at);
CREATE INDEX IF NOT EXISTS work_orders_completed_at_idx ON work_orders(completed_at);

COMMENT ON COLUMN work_orders.started_at IS 'A szolgáltatás tényleges megkezdésének időpontja.';
COMMENT ON COLUMN work_orders.completed_at IS 'A munkalap tényleges befejezésének időpontja.';
COMMENT ON COLUMN work_orders.cancelled_at IS 'A munkalap visszavonásának időpontja.';
COMMENT ON COLUMN work_orders.status_updated_at IS 'A státusz utolsó módosításának időpontja.';

COMMIT;
