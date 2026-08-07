BEGIN;

ALTER TABLE work_orders
  ADD COLUMN IF NOT EXISTS gross_total numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discount_amount numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tip_amount numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS amount_due numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS amount_paid numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payment_status varchar(20) NOT NULL DEFAULT 'unpaid',
  ADD COLUMN IF NOT EXISTS invoice_status varchar(20) NOT NULL DEFAULT 'not_requested',
  ADD COLUMN IF NOT EXISTS financial_closed_at timestamptz,
  ADD COLUMN IF NOT EXISTS financial_closed_by text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'work_orders_payment_status_check') THEN
    ALTER TABLE work_orders ADD CONSTRAINT work_orders_payment_status_check
      CHECK (payment_status IN ('unpaid','partial','paid','refunded'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'work_orders_invoice_status_check') THEN
    ALTER TABLE work_orders ADD CONSTRAINT work_orders_invoice_status_check
      CHECK (invoice_status IN ('not_requested','requested','issued','cancelled'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS cash_register_closings (
  id bigserial PRIMARY KEY,
  location_id text,
  business_date date NOT NULL,
  opening_cash numeric(14,2) NOT NULL DEFAULT 0,
  cash_sales numeric(14,2) NOT NULL DEFAULT 0,
  card_sales numeric(14,2) NOT NULL DEFAULT 0,
  transfer_sales numeric(14,2) NOT NULL DEFAULT 0,
  voucher_sales numeric(14,2) NOT NULL DEFAULT 0,
  other_sales numeric(14,2) NOT NULL DEFAULT 0,
  tips numeric(14,2) NOT NULL DEFAULT 0,
  discounts numeric(14,2) NOT NULL DEFAULT 0,
  expected_cash numeric(14,2) NOT NULL DEFAULT 0,
  counted_cash numeric(14,2),
  difference numeric(14,2),
  note text,
  closed_by text,
  closed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (location_id, business_date)
);

CREATE INDEX IF NOT EXISTS cash_register_closings_date_idx
  ON cash_register_closings (business_date DESC, location_id);

CREATE INDEX IF NOT EXISTS work_orders_payment_status_idx
  ON work_orders (payment_status, created_at DESC);

COMMIT;
