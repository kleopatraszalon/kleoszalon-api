CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS loyalty_coupon_usages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coupon_id uuid NOT NULL REFERENCES loyalty_coupons(id) ON DELETE CASCADE,
  customer_id text,
  work_order_id text,
  discount_amount numeric(14,2) NOT NULL DEFAULT 0,
  used_at timestamptz NOT NULL DEFAULT now(),
  created_by text
);
CREATE INDEX IF NOT EXISTS loyalty_coupon_usages_coupon_idx ON loyalty_coupon_usages(coupon_id,used_at DESC);

CREATE TABLE IF NOT EXISTS loyalty_voucher_usages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  voucher_id uuid NOT NULL REFERENCES loyalty_vouchers(id) ON DELETE CASCADE,
  customer_id text,
  work_order_id text,
  amount numeric(14,2) NOT NULL,
  used_at timestamptz NOT NULL DEFAULT now(),
  created_by text
);
CREATE INDEX IF NOT EXISTS loyalty_voucher_usages_voucher_idx ON loyalty_voucher_usages(voucher_id,used_at DESC);

CREATE TABLE IF NOT EXISTS loyalty_pass_usages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pass_id uuid NOT NULL REFERENCES loyalty_passes(id) ON DELETE CASCADE,
  service_id text NOT NULL,
  quantity numeric(12,2) NOT NULL DEFAULT 1,
  work_order_id text,
  used_at timestamptz NOT NULL DEFAULT now(),
  created_by text
);

CREATE TABLE IF NOT EXISTS loyalty_points_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  spend_amount numeric(14,2) NOT NULL DEFAULT 100,
  points_earned numeric(14,2) NOT NULL DEFAULT 1,
  point_value numeric(14,4) NOT NULL DEFAULT 1,
  active boolean NOT NULL DEFAULT true,
  valid_from date,
  valid_until date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO loyalty_points_rules(name,spend_amount,points_earned,point_value)
SELECT 'Alapértelmezett hűségpont szabály',100,1,1
WHERE NOT EXISTS(SELECT 1 FROM loyalty_points_rules);

DO $$
DECLARE p bigint;
BEGIN
  IF to_regclass('public.menus') IS NULL THEN RETURN; END IF;
  SELECT id INTO p FROM menus WHERE route='/loyalty' OR lower(name) LIKE 'hűség%' ORDER BY id LIMIT 1;
  IF p IS NULL THEN
    INSERT INTO menus(name,route,icon,parent_id,order_index,required_role) VALUES('Hűség, bérletek és ajándékkártyák','/loyalty','Gift',NULL,40,'all') RETURNING id INTO p;
  END IF;
  UPDATE menus SET name='Hűség, bérletek és ajándékkártyák',route='/loyalty',icon=COALESCE(icon,'Gift') WHERE id=p;
  IF NOT EXISTS(SELECT 1 FROM menus WHERE parent_id=p AND route='/loyalty') THEN INSERT INTO menus(name,route,parent_id,order_index,required_role) VALUES('Áttekintés','/loyalty',p,5,'all'); END IF;
  IF NOT EXISTS(SELECT 1 FROM menus WHERE parent_id=p AND route='/loyalty/accounts') THEN INSERT INTO menus(name,route,parent_id,order_index,required_role) VALUES('Vendég egyenlegek','/loyalty/accounts',p,10,'all'); END IF;
  IF NOT EXISTS(SELECT 1 FROM menus WHERE parent_id=p AND route='/loyalty/points') THEN INSERT INTO menus(name,route,parent_id,order_index,required_role) VALUES('Hűségpontok','/loyalty/points',p,15,'all'); END IF;
  IF NOT EXISTS(SELECT 1 FROM menus WHERE parent_id=p AND route='/loyalty/passes') THEN INSERT INTO menus(name,route,parent_id,order_index,required_role) VALUES('Bérletek','/loyalty/passes',p,20,'all'); END IF;
  IF NOT EXISTS(SELECT 1 FROM menus WHERE parent_id=p AND route='/loyalty/coupons') THEN INSERT INTO menus(name,route,parent_id,order_index,required_role) VALUES('Kuponok','/loyalty/coupons',p,30,'all'); END IF;
  IF NOT EXISTS(SELECT 1 FROM menus WHERE parent_id=p AND route='/loyalty/vouchers') THEN INSERT INTO menus(name,route,parent_id,order_index,required_role) VALUES('Ajándékutalványok','/loyalty/vouchers',p,40,'all'); END IF;
  IF NOT EXISTS(SELECT 1 FROM menus WHERE parent_id=p AND route='/loyalty/transactions') THEN INSERT INTO menus(name,route,parent_id,order_index,required_role) VALUES('Tranzakciók','/loyalty/transactions',p,50,'all'); END IF;
END $$;
