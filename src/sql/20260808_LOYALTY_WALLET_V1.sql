CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS loyalty_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id text NOT NULL UNIQUE,
  balance numeric(14,2) NOT NULL DEFAULT 0,
  points numeric(14,2) NOT NULL DEFAULT 0,
  card_identifier text UNIQUE,
  external_identifier text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked','closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS loyalty_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES loyalty_accounts(id) ON DELETE CASCADE,
  transaction_type text NOT NULL,
  amount numeric(14,2) NOT NULL DEFAULT 0,
  points numeric(14,2) NOT NULL DEFAULT 0,
  work_order_id text,
  reference_type text,
  reference_id text,
  note text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS loyalty_transactions_account_idx ON loyalty_transactions(account_id,created_at DESC);

CREATE TABLE IF NOT EXISTS loyalty_pass_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  product_id text,
  valid_days integer,
  validity_start_mode text NOT NULL DEFAULT 'sale' CHECK(validity_start_mode IN ('sale','first_use','manual')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS loyalty_pass_type_services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pass_type_id uuid NOT NULL REFERENCES loyalty_pass_types(id) ON DELETE CASCADE,
  service_id text NOT NULL,
  quantity numeric(12,2) NOT NULL DEFAULT 1,
  UNIQUE(pass_type_id,service_id)
);

CREATE TABLE IF NOT EXISTS loyalty_passes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES loyalty_accounts(id) ON DELETE CASCADE,
  pass_type_id uuid NOT NULL REFERENCES loyalty_pass_types(id),
  valid_from date,
  valid_until date,
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','expired','used','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS loyalty_pass_balances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pass_id uuid NOT NULL REFERENCES loyalty_passes(id) ON DELETE CASCADE,
  service_id text NOT NULL,
  original_quantity numeric(12,2) NOT NULL DEFAULT 0,
  remaining_quantity numeric(12,2) NOT NULL DEFAULT 0,
  UNIQUE(pass_id,service_id)
);

CREATE TABLE IF NOT EXISTS loyalty_coupon_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  discount_type text NOT NULL CHECK(discount_type IN ('percent','amount')),
  discount_value numeric(14,2) NOT NULL,
  valid_from timestamptz,
  valid_until timestamptz,
  usage_mode text NOT NULL DEFAULT 'single' CHECK(usage_mode IN ('single','once_per_customer','multiple')),
  applies_to_all boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS loyalty_coupons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES loyalty_coupon_campaigns(id) ON DELETE CASCADE,
  code text NOT NULL UNIQUE,
  customer_id text,
  usage_count integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS loyalty_voucher_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  face_value numeric(14,2) NOT NULL,
  valid_days integer,
  applies_to_all boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS loyalty_vouchers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  voucher_type_id uuid REFERENCES loyalty_voucher_types(id),
  code text NOT NULL UNIQUE,
  purchaser_customer_id text,
  owner_customer_id text,
  original_value numeric(14,2) NOT NULL,
  remaining_value numeric(14,2) NOT NULL,
  valid_from date,
  valid_until date,
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','used','expired','cancelled')),
  sold_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Menü: a konkrét oszlopkészlet telepítésenként eltérhet, ezért csak akkor szúrunk be, ha a standard menus tábla rendelkezésre áll.
DO $$
DECLARE parent_id_val bigint;
BEGIN
  IF to_regclass('public.menus') IS NOT NULL THEN
    SELECT id INTO parent_id_val FROM menus WHERE lower(name) LIKE 'hűség%' OR route='/loyalty' ORDER BY id LIMIT 1;
    IF parent_id_val IS NULL THEN
      INSERT INTO menus(name,route,icon,parent_id,order_index,required_role)
      VALUES('Hűség, bérletek és ajándékkártyák','/loyalty','Gift',NULL,40,'all') RETURNING id INTO parent_id_val;
    ELSE
      UPDATE menus SET route='/loyalty' WHERE id=parent_id_val;
    END IF;
    IF NOT EXISTS(SELECT 1 FROM menus WHERE parent_id=parent_id_val AND route='/loyalty/accounts') THEN INSERT INTO menus(name,route,parent_id,order_index,required_role) VALUES('Vendég egyenlegek','/loyalty/accounts',parent_id_val,10,'all'); END IF;
    IF NOT EXISTS(SELECT 1 FROM menus WHERE parent_id=parent_id_val AND route='/loyalty/passes') THEN INSERT INTO menus(name,route,parent_id,order_index,required_role) VALUES('Bérletek','/loyalty/passes',parent_id_val,20,'all'); END IF;
    IF NOT EXISTS(SELECT 1 FROM menus WHERE parent_id=parent_id_val AND route='/loyalty/coupons') THEN INSERT INTO menus(name,route,parent_id,order_index,required_role) VALUES('Kuponok','/loyalty/coupons',parent_id_val,30,'all'); END IF;
    IF NOT EXISTS(SELECT 1 FROM menus WHERE parent_id=parent_id_val AND route='/loyalty/vouchers') THEN INSERT INTO menus(name,route,parent_id,order_index,required_role) VALUES('Ajándékutalványok','/loyalty/vouchers',parent_id_val,40,'all'); END IF;
    IF NOT EXISTS(SELECT 1 FROM menus WHERE parent_id=parent_id_val AND route='/loyalty/transactions') THEN INSERT INTO menus(name,route,parent_id,order_index,required_role) VALUES('Hűség tranzakciók','/loyalty/transactions',parent_id_val,50,'all'); END IF;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Loyalty menu seed skipped: %', SQLERRM;
END $$;
