-- Munkalap pénztári lezárás V2
-- Fizetés -> pénzügy -> készlet -> jutalék -> végleges lezárás/archiválás

ALTER TABLE work_order_payments ADD COLUMN IF NOT EXISTS financial_account_id uuid;
ALTER TABLE work_order_payments ADD COLUMN IF NOT EXISTS financial_movement_id uuid;

DO $$ BEGIN
  IF to_regclass('public.financial_accounts') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='work_order_payments_financial_account_id_fkey'
  ) THEN
    ALTER TABLE work_order_payments ADD CONSTRAINT work_order_payments_financial_account_id_fkey
      FOREIGN KEY(financial_account_id) REFERENCES financial_accounts(id);
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('public.financial_movements') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='work_order_payments_financial_movement_id_fkey'
  ) THEN
    ALTER TABLE work_order_payments ADD CONSTRAINT work_order_payments_financial_movement_id_fkey
      FOREIGN KEY(financial_movement_id) REFERENCES financial_movements(id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS work_order_commission_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id uuid NOT NULL REFERENCES work_orders(id),
  employee_id uuid NOT NULL REFERENCES employees(id),
  base_amount numeric(14,2) NOT NULL DEFAULT 0,
  tip_amount numeric(14,2) NOT NULL DEFAULT 0,
  source_type text NOT NULL DEFAULT 'work_order_finalization',
  status text NOT NULL DEFAULT 'open',
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text,
  UNIQUE(work_order_id,employee_id,source_type)
);
CREATE INDEX IF NOT EXISTS work_order_commission_events_employee_idx ON work_order_commission_events(employee_id,created_at DESC);
CREATE INDEX IF NOT EXISTS work_order_commission_events_work_order_idx ON work_order_commission_events(work_order_id);

ALTER TABLE loyalty_checkout_settlements ADD COLUMN IF NOT EXISTS finalized_at timestamptz;
ALTER TABLE loyalty_checkout_settlements ADD COLUMN IF NOT EXISTS finalization_payload jsonb;

CREATE INDEX IF NOT EXISTS work_order_payments_financial_account_idx ON work_order_payments(financial_account_id);
CREATE INDEX IF NOT EXISTS work_order_payments_financial_movement_idx ON work_order_payments(financial_movement_id);
