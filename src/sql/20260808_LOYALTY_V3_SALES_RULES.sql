CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE loyalty_pass_types ADD COLUMN IF NOT EXISTS sale_price numeric(14,2) NOT NULL DEFAULT 0;
ALTER TABLE loyalty_pass_types ADD COLUMN IF NOT EXISTS renewal_mode text NOT NULL DEFAULT 'extend' CHECK (renewal_mode IN ('extend','new'));
ALTER TABLE loyalty_pass_types ADD COLUMN IF NOT EXISTS renewal_days integer;

ALTER TABLE loyalty_coupon_campaigns ADD COLUMN IF NOT EXISTS min_order_value numeric(14,2) NOT NULL DEFAULT 0;
ALTER TABLE loyalty_coupon_campaigns ADD COLUMN IF NOT EXISTS max_discount_value numeric(14,2);

CREATE TABLE IF NOT EXISTS loyalty_coupon_restrictions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES loyalty_coupon_campaigns(id) ON DELETE CASCADE,
  target_type text NOT NULL CHECK(target_type IN ('service','product','service_category','product_category')),
  target_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(campaign_id,target_type,target_id)
);

CREATE TABLE IF NOT EXISTS loyalty_voucher_type_restrictions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  voucher_type_id uuid NOT NULL REFERENCES loyalty_voucher_types(id) ON DELETE CASCADE,
  target_type text NOT NULL CHECK(target_type IN ('service','product','service_category','product_category')),
  target_id text NOT NULL,
  quantity numeric(12,2),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(voucher_type_id,target_type,target_id)
);

CREATE TABLE IF NOT EXISTS loyalty_sales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_type text NOT NULL CHECK(sale_type IN ('voucher','pass','wallet_topup')),
  reference_id text NOT NULL,
  account_id uuid REFERENCES loyalty_accounts(id) ON DELETE SET NULL,
  customer_id text,
  employee_id text,
  work_order_id text,
  gross_amount numeric(14,2) NOT NULL DEFAULT 0,
  commission_base numeric(14,2) NOT NULL DEFAULT 0,
  revenue_recognized boolean NOT NULL DEFAULT true,
  payment_status text NOT NULL DEFAULT 'paid' CHECK(payment_status IN ('pending','paid','cancelled','refunded')),
  finance_reference text,
  note text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS loyalty_sales_created_idx ON loyalty_sales(created_at DESC);
CREATE INDEX IF NOT EXISTS loyalty_sales_employee_idx ON loyalty_sales(employee_id,created_at DESC);

CREATE TABLE IF NOT EXISTS loyalty_commission_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id text NOT NULL,
  work_order_id text,
  source_type text NOT NULL,
  source_id text,
  base_amount numeric(14,2) NOT NULL DEFAULT 0,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(employee_id,source_type,source_id,work_order_id)
);

-- Az ajándékutalvány eladása bevétel, de nem dolgozói szolgáltatási jutalékalap.
-- A dolgozói jutalékalap az utalvány későbbi beváltásakor kerül a loyalty_commission_events táblába.
CREATE OR REPLACE FUNCTION loyalty_normalize_sale_commission() RETURNS trigger AS $$
BEGIN
  IF NEW.sale_type='voucher' THEN NEW.commission_base:=0; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_loyalty_normalize_sale_commission ON loyalty_sales;
CREATE TRIGGER trg_loyalty_normalize_sale_commission BEFORE INSERT OR UPDATE ON loyalty_sales FOR EACH ROW EXECUTE FUNCTION loyalty_normalize_sale_commission();

DO $$
DECLARE p bigint;
BEGIN
  IF to_regclass('public.menus') IS NULL THEN RETURN; END IF;
  SELECT id INTO p FROM menus WHERE parent_id IS NULL AND route='/loyalty' ORDER BY id LIMIT 1;
  IF p IS NULL THEN RETURN; END IF;
  IF NOT EXISTS(SELECT 1 FROM menus WHERE parent_id=p AND route='/loyalty/settings') THEN
    INSERT INTO menus(name,route,parent_id,order_index,required_role) VALUES('Hűség beállítások','/loyalty/settings',p,60,'admin');
  END IF;
END $$;
