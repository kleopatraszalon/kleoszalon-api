-- Hűség 4.0: pénzügyi könyvelési kapcsolat + ügyféladatlap támogatás
ALTER TABLE loyalty_sales ADD COLUMN IF NOT EXISTS finance_movement_id uuid;
ALTER TABLE loyalty_sales ADD COLUMN IF NOT EXISTS finance_account_id uuid;

CREATE INDEX IF NOT EXISTS loyalty_sales_customer_idx ON loyalty_sales(customer_id,created_at DESC);
CREATE INDEX IF NOT EXISTS loyalty_vouchers_owner_idx ON loyalty_vouchers(owner_customer_id,created_at DESC);
CREATE INDEX IF NOT EXISTS loyalty_coupons_customer_idx ON loyalty_coupons(customer_id,created_at DESC);
CREATE INDEX IF NOT EXISTS loyalty_accounts_customer_idx ON loyalty_accounts(customer_id);

-- Egy hűségértékesítés csak egyszer kerülhet pénzügyi mozgásba.
CREATE UNIQUE INDEX IF NOT EXISTS loyalty_sales_finance_movement_uq
  ON loyalty_sales(finance_movement_id)
  WHERE finance_movement_id IS NOT NULL;
