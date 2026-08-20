BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE products ADD COLUMN IF NOT EXISTS negative_stock_policy text;
UPDATE products SET negative_stock_policy='inherit' WHERE negative_stock_policy IS NULL OR trim(negative_stock_policy)='';
ALTER TABLE products ALTER COLUMN negative_stock_policy SET DEFAULT 'inherit';
ALTER TABLE products ALTER COLUMN negative_stock_policy SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='products_negative_stock_policy_ck') THEN
    ALTER TABLE products ADD CONSTRAINT products_negative_stock_policy_ck
      CHECK(negative_stock_policy IN ('inherit','deny','allow'));
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('public.product_stock_balances') IS NOT NULL THEN
    ALTER TABLE product_stock_balances ADD COLUMN IF NOT EXISTS optimal_quantity numeric(14,3) NOT NULL DEFAULT 0;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION kleo_product_negative_stock_allowed(
  p_product_id uuid,
  p_location_id text DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_policy text:='inherit';
  v_lot_tracking boolean:=false;
  v_prevent boolean:=true;
  v_key text:=COALESCE(NULLIF(p_location_id,''),'__central__');
BEGIN
  SELECT COALESCE(NULLIF(to_jsonb(p)->>'negative_stock_policy',''),'inherit'),
         COALESCE(NULLIF(to_jsonb(p)->>'lot_tracking_enabled','')::boolean,false)
    INTO v_policy,v_lot_tracking
  FROM products p WHERE p.id=p_product_id;

  IF NOT FOUND THEN RETURN false; END IF;
  -- Sarzs/FEFO nyomonkövetésnél nem hozunk létre nem létező negatív sarzsot.
  IF v_lot_tracking THEN RETURN false; END IF;
  IF v_policy='allow' THEN RETURN true; END IF;
  IF v_policy='deny' THEN RETURN false; END IF;

  IF to_regclass('public.inventory_settings') IS NULL THEN RETURN false; END IF;
  SELECT COALESCE(local.prevent_negative_stock,global.prevent_negative_stock,true)
    INTO v_prevent
  FROM (SELECT * FROM inventory_settings WHERE location_key='__global__' LIMIT 1) global
  LEFT JOIN inventory_settings local ON local.location_key=v_key;
  RETURN NOT COALESCE(v_prevent,true);
END;
$$;

CREATE OR REPLACE FUNCTION kleo_guard_negative_warehouse_balance()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_location text;
BEGIN
  IF NEW.quantity>=0 THEN RETURN NEW; END IF;
  -- Régi negatív készlet javítása felfelé engedett, további rontása nem.
  IF TG_OP='UPDATE' AND COALESCE(OLD.quantity,0)<0 AND NEW.quantity>=OLD.quantity THEN RETURN NEW; END IF;
  SELECT location_id INTO v_location FROM inventory_warehouses WHERE id=NEW.warehouse_id;
  IF NOT kleo_product_negative_stock_allowed(NEW.product_id,v_location) THEN
    RAISE EXCEPTION USING ERRCODE='23514',
      MESSAGE='A termék készlete nem mehet negatívba.',
      CONSTRAINT='product_negative_stock_policy';
  END IF;
  RETURN NEW;
END;
$$;

DO $$ BEGIN
  IF to_regclass('public.inventory_warehouse_balances') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_kleo_guard_negative_warehouse_balance ON inventory_warehouse_balances;
    CREATE TRIGGER trg_kleo_guard_negative_warehouse_balance
      BEFORE INSERT OR UPDATE OF quantity ON inventory_warehouse_balances
      FOR EACH ROW EXECUTE FUNCTION kleo_guard_negative_warehouse_balance();
  END IF;
END $$;

CREATE OR REPLACE FUNCTION kleo_guard_negative_legacy_balance()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.quantity>=0 THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND COALESCE(OLD.quantity,0)<0 AND NEW.quantity>=OLD.quantity THEN RETURN NEW; END IF;
  IF NOT kleo_product_negative_stock_allowed(NEW.product_id,NEW.location_id::text) THEN
    RAISE EXCEPTION USING ERRCODE='23514',
      MESSAGE='A termék készlete nem mehet negatívba.',
      CONSTRAINT='product_negative_stock_policy';
  END IF;
  RETURN NEW;
END;
$$;

DO $$ BEGIN
  IF to_regclass('public.product_stock_balances') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_kleo_guard_negative_legacy_balance ON product_stock_balances;
    CREATE TRIGGER trg_kleo_guard_negative_legacy_balance
      BEFORE INSERT OR UPDATE OF quantity ON product_stock_balances
      FOR EACH ROW EXECUTE FUNCTION kleo_guard_negative_legacy_balance();
  END IF;
END $$;

-- Ez a trigger név szerint a régi minimum×2 trigger ELŐTT fut. Ha létrehozza
-- az optimális szintre feltöltő igényt, a legacy trigger a duplikációvédelem
-- miatt már nem hoz létre második igényt.
CREATE OR REPLACE FUNCTION kleo_auto_replenishment_optimal_v3()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_qty numeric(14,3);
  v_min numeric(14,3);
  v_opt numeric(14,3);
  v_target numeric(14,3);
  v_request numeric(14,3);
BEGIN
  IF NEW.movement_type<>'work_order_consumption' OR NEW.location_id IS NULL THEN RETURN NEW; END IF;
  SELECT COALESCE(quantity,0),COALESCE(min_quantity,0),COALESCE(optimal_quantity,0)
    INTO v_qty,v_min,v_opt
  FROM product_stock_balances
  WHERE product_id=NEW.product_id AND location_id=NEW.location_id
  LIMIT 1;
  IF v_min IS NULL OR v_min<=0 OR v_qty>v_min THEN RETURN NEW; END IF;
  IF EXISTS(SELECT 1 FROM salon_stock_requests
            WHERE location_id=NEW.location_id AND product_id=NEW.product_id
              AND status IN('requested','approved','partially_supplied')) THEN RETURN NEW; END IF;

  v_target:=CASE WHEN COALESCE(v_opt,0)>0
                 THEN GREATEST(v_opt,v_min)
                 ELSE GREATEST(v_min*2,v_min+ABS(COALESCE(NEW.quantity,0))) END;
  v_request:=GREATEST(0.01,v_target-v_qty);
  INSERT INTO salon_stock_requests(
    location_id,product_id,requested_quantity,status,source,source_work_order_id,note,created_by
  ) VALUES(
    NEW.location_id,NEW.product_id,v_request,'requested','workorder_auto_optimal',NEW.work_order_id,
    'Automatikus készletfeltöltés az optimális készletszintig munkalap-felhasználás után.',
    'system:optimal-replenishment'
  );
  RETURN NEW;
END;
$$;

DO $$ BEGIN
  IF to_regclass('public.inventory_movements') IS NOT NULL AND to_regclass('public.salon_stock_requests') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_00_kleo_auto_replenishment_optimal_v3 ON inventory_movements;
    CREATE TRIGGER trg_00_kleo_auto_replenishment_optimal_v3
      AFTER INSERT ON inventory_movements
      FOR EACH ROW WHEN (NEW.movement_type='work_order_consumption')
      EXECUTE FUNCTION kleo_auto_replenishment_optimal_v3();
  END IF;
END $$;

-- Kezelőfelület a generikus VIR motorban.
INSERT INTO vir_module_definitions(
  module_key,title,category,route,description,entity_label,icon,fields,statuses,spec_reference,order_index,is_active
) VALUES(
  'product-stock-policy','Termék készletkivételezési szabályok','Raktár','/inventory/product-policies',
  'Termékenként beállítható, hogy a telephelyi negatívkészlet-szabály öröklődjön, a negatív készlet mindig tiltott legyen, vagy nem sarzskövetett terméknél engedélyezett legyen.',
  'termékszabály','PackageCheck',
  '[
    {"key":"product_identifier","label":"Termék ID / belső kód / vonalkód","type":"text","required":true},
    {"key":"negative_stock_policy","label":"Negatív készlet szabály","type":"select","required":true,"options":["Örökölt telephelyi szabály","Negatív készlet tiltva","Negatív készlet engedélyezve"]},
    {"key":"note","label":"Megjegyzés / indok","type":"textarea"}
  ]'::jsonb,
  '["active","archived"]'::jsonb,
  'VIR specifikáció – termékenkénti készletkivételezés / negatív készlet',63,true
)
ON CONFLICT(module_key) DO UPDATE SET
  title=EXCLUDED.title,category=EXCLUDED.category,route=EXCLUDED.route,description=EXCLUDED.description,
  entity_label=EXCLUDED.entity_label,icon=EXCLUDED.icon,fields=EXCLUDED.fields,statuses=EXCLUDED.statuses,
  spec_reference=EXCLUDED.spec_reference,order_index=EXCLUDED.order_index,is_active=true,updated_at=now();

CREATE OR REPLACE FUNCTION normalize_product_stock_policy_record()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_identifier text; v_policy text; v_product record;
BEGIN
  IF NEW.module_key<>'product-stock-policy' THEN RETURN NEW; END IF;
  v_identifier:=trim(COALESCE(NEW.payload->>'product_identifier',''));
  IF v_identifier='' THEN RAISE EXCEPTION 'A termék azonosítója kötelező.'; END IF;
  SELECT p.id::text id,p.name,COALESCE(p.internal_code,'') internal_code,COALESCE(p.barcode,'') barcode,
         COALESCE(NULLIF(to_jsonb(p)->>'lot_tracking_enabled','')::boolean,false) lot_tracking_enabled
    INTO v_product
  FROM products p
  WHERE p.id::text=v_identifier OR lower(COALESCE(p.internal_code,''))=lower(v_identifier)
     OR lower(COALESCE(p.barcode,''))=lower(v_identifier)
  ORDER BY CASE WHEN p.id::text=v_identifier THEN 0 WHEN lower(COALESCE(p.internal_code,''))=lower(v_identifier) THEN 1 ELSE 2 END
  LIMIT 1;
  IF v_product.id IS NULL THEN RAISE EXCEPTION 'A termék nem található: %',v_identifier; END IF;

  v_policy:=lower(trim(COALESCE(NEW.payload->>'negative_stock_policy','')));
  v_policy:=CASE v_policy
    WHEN 'örökölt telephelyi szabály' THEN 'inherit'
    WHEN 'negatív készlet tiltva' THEN 'deny'
    WHEN 'negatív készlet engedélyezve' THEN 'allow'
    ELSE v_policy END;
  IF v_policy NOT IN('inherit','deny','allow') THEN RAISE EXCEPTION 'Érvénytelen negatívkészlet-szabály.'; END IF;
  IF v_policy='allow' AND v_product.lot_tracking_enabled THEN
    RAISE EXCEPTION 'Sarzskövetett/FEFO terméknél negatív készlet nem engedélyezhető.';
  END IF;

  NEW.payload:=COALESCE(NEW.payload,'{}'::jsonb)||jsonb_build_object(
    'product_identifier',v_product.id,'product_name',v_product.name,'internal_code',v_product.internal_code,
    'barcode',v_product.barcode,'negative_stock_policy',v_policy,'lot_tracking_enabled',v_product.lot_tracking_enabled
  );
  NEW.title:=COALESCE(NULLIF(trim(NEW.title),''),v_product.name||' – készletszabály');
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_00_normalize_product_stock_policy_record ON vir_module_records;
CREATE TRIGGER trg_00_normalize_product_stock_policy_record
  BEFORE INSERT OR UPDATE OF payload,status ON vir_module_records
  FOR EACH ROW EXECUTE FUNCTION normalize_product_stock_policy_record();

CREATE OR REPLACE FUNCTION apply_product_stock_policy_record()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.module_key<>'product-stock-policy' OR NEW.status<>'active' THEN RETURN NEW; END IF;
  UPDATE products SET negative_stock_policy=NEW.payload->>'negative_stock_policy'
  WHERE id=(NEW.payload->>'product_identifier')::uuid;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_apply_product_stock_policy_record ON vir_module_records;
CREATE TRIGGER trg_apply_product_stock_policy_record
  AFTER INSERT OR UPDATE OF payload,status ON vir_module_records
  FOR EACH ROW EXECUTE FUNCTION apply_product_stock_policy_record();

WITH parent AS (SELECT id FROM menus WHERE code IN('warehouse','inventory') ORDER BY CASE WHEN code='warehouse' THEN 0 ELSE 1 END LIMIT 1)
INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
SELECT 'inventory.product-stock-policy','Termék készletszabályok','PackageCheck','/inventory/product-policies',63,p.id,'inventory',true FROM parent p
ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,icon=EXCLUDED.icon,route=EXCLUDED.route,order_index=EXCLUDED.order_index,
 parent_id=EXCLUDED.parent_id,feature_key=EXCLUDED.feature_key,is_active=true;

INSERT INTO role_menu_permissions
 (role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,can_manage_permissions,scope_type)
SELECT 'admin',m.id,true,true,true,false,true,true,true,true,'all_locations'
FROM menus m WHERE m.code='inventory.product-stock-policy'
ON CONFLICT(role_key,menu_id) DO NOTHING;
INSERT INTO role_menu_permissions
 (role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,can_manage_permissions,scope_type)
SELECT 'manager',m.id,true,true,true,false,true,true,true,false,'all_locations'
FROM menus m WHERE m.code='inventory.product-stock-policy'
ON CONFLICT(role_key,menu_id) DO NOTHING;

INSERT INTO schema_migrations(version,description)
VALUES('20260817_PRODUCT_STOCK_POLICY_V3','Termékszintű negatívkészlet-szabály, DB guard és optimális készletre utánpótlás')
ON CONFLICT(version) DO NOTHING;

COMMIT;
