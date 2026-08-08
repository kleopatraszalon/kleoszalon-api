BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS login_name text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text;

-- DEMO ügyfél: ugyfel1 / Teszt1234!
DO $$
DECLARE
  role_udt text;
  role_value text;
  affected bigint;
BEGIN
  SELECT udt_name INTO role_udt
  FROM information_schema.columns
  WHERE table_schema=current_schema() AND table_name='users' AND column_name='role'
  LIMIT 1;

  IF role_udt='jsonb' THEN
    role_value := to_json('customer'::text)::text;
    EXECUTE 'UPDATE users SET full_name=$1,login_name=$2,password_hash=$3,role=$4::jsonb WHERE lower(email)=lower($5)'
      USING 'DEMO Kiss Anna','ugyfel1','$2b$12$Zea7mWMY.2wv.oUi.WwFJOfrsbBbxdOEHv8r5dbyq7W76NFUJIsQ.',role_value,'demo.ugyfel@kleoszalon.hu';
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected=0 THEN
      EXECUTE 'INSERT INTO users(full_name,login_name,email,password_hash,role) VALUES($1,$2,$3,$4,$5::jsonb)'
        USING 'DEMO Kiss Anna','ugyfel1','demo.ugyfel@kleoszalon.hu','$2b$12$Zea7mWMY.2wv.oUi.WwFJOfrsbBbxdOEHv8r5dbyq7W76NFUJIsQ.',role_value;
    END IF;
  ELSIF role_udt='json' THEN
    role_value := to_json('customer'::text)::text;
    EXECUTE 'UPDATE users SET full_name=$1,login_name=$2,password_hash=$3,role=$4::json WHERE lower(email)=lower($5)'
      USING 'DEMO Kiss Anna','ugyfel1','$2b$12$Zea7mWMY.2wv.oUi.WwFJOfrsbBbxdOEHv8r5dbyq7W76NFUJIsQ.',role_value,'demo.ugyfel@kleoszalon.hu';
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected=0 THEN
      EXECUTE 'INSERT INTO users(full_name,login_name,email,password_hash,role) VALUES($1,$2,$3,$4,$5::json)'
        USING 'DEMO Kiss Anna','ugyfel1','demo.ugyfel@kleoszalon.hu','$2b$12$Zea7mWMY.2wv.oUi.WwFJOfrsbBbxdOEHv8r5dbyq7W76NFUJIsQ.',role_value;
    END IF;
  ELSE
    UPDATE users SET full_name='DEMO Kiss Anna',login_name='ugyfel1',password_hash='$2b$12$Zea7mWMY.2wv.oUi.WwFJOfrsbBbxdOEHv8r5dbyq7W76NFUJIsQ.',role='customer'
    WHERE lower(email)=lower('demo.ugyfel@kleoszalon.hu');
    IF NOT FOUND THEN
      INSERT INTO users(full_name,login_name,email,password_hash,role)
      VALUES('DEMO Kiss Anna','ugyfel1','demo.ugyfel@kleoszalon.hu','$2b$12$Zea7mWMY.2wv.oUi.WwFJOfrsbBbxdOEHv8r5dbyq7W76NFUJIsQ.','customer');
    END IF;
  END IF;
END $$;

DO $$
DECLARE
  v_client uuid;
  v_location uuid;
  v_account uuid;
  v_pass_type uuid;
  v_pass uuid;
  v_service text;
  v_campaign uuid;
BEGIN
  SELECT id INTO v_location FROM locations ORDER BY name LIMIT 1;

  SELECT id INTO v_client FROM clients WHERE lower(COALESCE(email,''))=lower('demo.ugyfel@kleoszalon.hu') ORDER BY updated_at DESC NULLS LAST LIMIT 1;
  IF v_client IS NULL THEN
    INSERT INTO clients(full_name,name,phone,email,location_id,marketing_consent,is_active,source,created_at,updated_at)
    VALUES('DEMO Kiss Anna','DEMO Kiss Anna','+36 30 555 0101','demo.ugyfel@kleoszalon.hu',v_location,true,true,'demo_customer_portal',now(),now())
    RETURNING id INTO v_client;
  ELSE
    UPDATE clients SET full_name='DEMO Kiss Anna',name=COALESCE(NULLIF(name,''),'DEMO Kiss Anna'),phone=COALESCE(NULLIF(phone,''),'+36 30 555 0101'),marketing_consent=true,is_active=true,updated_at=now()
    WHERE id=v_client;
  END IF;

  INSERT INTO loyalty_accounts(customer_id,balance,points,card_identifier,status)
  VALUES(v_client::text,18500,1240,'DEMO-CUSTOMER-1','active')
  ON CONFLICT(customer_id) DO UPDATE SET
    card_identifier=COALESCE(loyalty_accounts.card_identifier,EXCLUDED.card_identifier),
    status='active',updated_at=now()
  RETURNING id INTO v_account;

  IF NOT EXISTS(SELECT 1 FROM loyalty_transactions WHERE account_id=v_account AND reference_type='demo_seed') THEN
    INSERT INTO loyalty_transactions(account_id,transaction_type,amount,points,reference_type,reference_id,note,created_by)
    VALUES(v_account,'balance_topup',18500,1240,'demo_seed','customer_portal_v1','Nyitó demó egyenleg és pontok','system');
    UPDATE loyalty_accounts SET balance=GREATEST(balance,18500),points=GREATEST(points,1240),updated_at=now() WHERE id=v_account;
  END IF;

  SELECT id::text INTO v_service FROM services WHERE COALESCE(is_active,true)=true AND COALESCE(online_bookable,true)=true ORDER BY name LIMIT 1;

  SELECT id INTO v_pass_type FROM loyalty_pass_types WHERE name='DEMO Prémium 5 alkalmas bérlet' ORDER BY created_at LIMIT 1;
  IF v_pass_type IS NULL THEN
    INSERT INTO loyalty_pass_types(name,valid_days,validity_start_mode,active,sale_price,renewal_mode,renewal_days)
    VALUES('DEMO Prémium 5 alkalmas bérlet',180,'sale',true,34900,'extend',180)
    RETURNING id INTO v_pass_type;
  END IF;

  IF v_service IS NOT NULL THEN
    INSERT INTO loyalty_pass_type_services(pass_type_id,service_id,quantity)
    VALUES(v_pass_type,v_service,5)
    ON CONFLICT(pass_type_id,service_id) DO UPDATE SET quantity=GREATEST(loyalty_pass_type_services.quantity,5);
  END IF;

  SELECT id INTO v_pass FROM loyalty_passes WHERE account_id=v_account AND pass_type_id=v_pass_type AND status='active' ORDER BY created_at DESC LIMIT 1;
  IF v_pass IS NULL THEN
    INSERT INTO loyalty_passes(account_id,pass_type_id,valid_from,valid_until,status)
    VALUES(v_account,v_pass_type,CURRENT_DATE,CURRENT_DATE+180,'active')
    RETURNING id INTO v_pass;
  END IF;

  IF v_service IS NOT NULL THEN
    INSERT INTO loyalty_pass_balances(pass_id,service_id,original_quantity,remaining_quantity)
    VALUES(v_pass,v_service,5,4)
    ON CONFLICT(pass_id,service_id) DO NOTHING;
  END IF;

  SELECT id INTO v_campaign FROM loyalty_coupon_campaigns WHERE name='DEMO Ügyfél 15% kedvezmény' ORDER BY created_at DESC LIMIT 1;
  IF v_campaign IS NULL THEN
    INSERT INTO loyalty_coupon_campaigns(name,discount_type,discount_value,valid_from,valid_until,usage_mode,applies_to_all,active,min_order_value,max_discount_value)
    VALUES('DEMO Ügyfél 15% kedvezmény','percent',15,now()-interval '1 day',now()+interval '90 days','once_per_customer',true,true,0,10000)
    RETURNING id INTO v_campaign;
  ELSE
    UPDATE loyalty_coupon_campaigns SET active=true,valid_from=COALESCE(valid_from,now()-interval '1 day'),valid_until=GREATEST(COALESCE(valid_until,now()+interval '90 days'),now()+interval '30 days') WHERE id=v_campaign;
  END IF;

  INSERT INTO loyalty_coupons(campaign_id,code,customer_id,usage_count,active)
  VALUES(v_campaign,'DEMO15',v_client::text,0,true)
  ON CONFLICT(code) DO UPDATE SET campaign_id=EXCLUDED.campaign_id,customer_id=EXCLUDED.customer_id,active=true;

  IF NOT EXISTS(SELECT 1 FROM loyalty_coupon_campaigns WHERE name='Augusztusi szépségnapok') THEN
    INSERT INTO loyalty_coupon_campaigns(name,discount_type,discount_value,valid_from,valid_until,usage_mode,applies_to_all,active,min_order_value,max_discount_value)
    VALUES('Augusztusi szépségnapok','percent',10,now()-interval '2 days',now()+interval '21 days','multiple',true,true,0,8000);
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    INSERT INTO schema_migrations(version,description)
    VALUES('20260808_CUSTOMER_PORTAL_DEMO_V1','DEMO ügyfél belépés, hűségegyenleg, bérlet és kedvezmények')
    ON CONFLICT(version) DO NOTHING;
  END IF;
END $$;

COMMIT;
