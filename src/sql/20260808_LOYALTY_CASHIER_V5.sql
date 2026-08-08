CREATE TABLE IF NOT EXISTS loyalty_checkout_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id text NOT NULL UNIQUE,
  account_id uuid NULL REFERENCES loyalty_accounts(id) ON DELETE SET NULL,
  customer_id text NULL,
  coupon_code text NULL,
  coupon_discount numeric(14,2) NOT NULL DEFAULT 0,
  points_spent numeric(14,2) NOT NULL DEFAULT 0,
  points_discount numeric(14,2) NOT NULL DEFAULT 0,
  wallet_used numeric(14,2) NOT NULL DEFAULT 0,
  voucher_code text NULL,
  voucher_used numeric(14,2) NOT NULL DEFAULT 0,
  pass_value_used numeric(14,2) NOT NULL DEFAULT 0,
  cash_due numeric(14,2) NOT NULL DEFAULT 0,
  points_earned numeric(14,2) NOT NULL DEFAULT 0,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS loyalty_checkout_settlements_account_idx ON loyalty_checkout_settlements(account_id,created_at DESC);
