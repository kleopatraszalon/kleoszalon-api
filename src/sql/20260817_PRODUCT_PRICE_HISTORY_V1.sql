BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================================
-- KLEOSZALON VIR – időbeli termékárak / csoportos átárazás
--
-- Alapelv:
--   * az eladási ár és a készlet beszerzési/átlagára külön adat;
--   * a régi árak nem íródnak felül, hanem érvényességi intervallumot kapnak;
--   * a lezárt munkalapok/számlák saját ár-snapshotot tartanak meg;
--   * a régi products.price / retail_price_gross mezők kompatibilitási cache-ként
--     tovább élnek, ezért a meglévő képernyők nem törnek el.
-- ============================================================================

CREATE TABLE IF NOT EXISTS product_repricing_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vir_record_id uuid UNIQUE,
  title text NOT NULL,
  scope_type text NOT NULL DEFAULT 'all',
  scope_value text,
  adjustment_type text NOT NULL,
  adjustment_value numeric(14,4) NOT NULL,
  rounding_increment numeric(14,2) NOT NULL DEFAULT 1,
  valid_from date NOT NULL,
  valid_to date,
  reason text,
  status text NOT NULL DEFAULT 'applied',
  product_count integer NOT NULL DEFAULT 0,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_repricing_batches_dates_ck CHECK(valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT product_repricing_batches_adjustment_ck CHECK(adjustment_type IN ('percent','fixed','set')),
  CONSTRAINT product_repricing_batches_scope_ck CHECK(scope_type IN ('all','merchandise','service_material','group','category','products')),
  CONSTRAINT product_repricing_batches_rounding_ck CHECK(rounding_increment > 0)
);

CREATE TABLE IF NOT EXISTS product_price_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  batch_id uuid REFERENCES product_repricing_batches(id) ON DELETE SET NULL,
  retail_price_gross numeric(14,2) NOT NULL,
  currency text NOT NULL DEFAULT 'HUF',
  valid_from date NOT NULL,
  valid_to date,
  source text NOT NULL DEFAULT 'manual',
  parent_version_id uuid REFERENCES product_price_versions(id) ON DELETE SET NULL,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz,
  cancelled_by text,
  cancellation_reason text,
  CONSTRAINT product_price_versions_price_ck CHECK(retail_price_gross >= 0),
  CONSTRAINT product_price_versions_dates_ck CHECK(valid_to IS NULL OR valid_to >= valid_from)
);

CREATE UNIQUE INDEX IF NOT EXISTS product_price_versions_active_start_uq
  ON product_price_versions(product_id,valid_from)
  WHERE cancelled_at IS NULL;
CREATE INDEX IF NOT EXISTS product_price_versions_lookup_idx
  ON product_price_versions(product_id,valid_from DESC,valid_to)
  WHERE cancelled_at IS NULL;
CREATE INDEX IF NOT EXISTS product_price_versions_batch_idx
  ON product_price_versions(batch_id,product_id);

CREATE TABLE IF NOT EXISTS product_repricing_batch_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES product_repricing_batches(id) ON DELETE RESTRICT,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  price_version_id uuid REFERENCES product_price_versions(id) ON DELETE SET NULL,
  old_price numeric(14,2) NOT NULL,
  new_price numeric(14,2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(batch_id,product_id)
);
CREATE INDEX IF NOT EXISTS product_repricing_batch_items_product_idx
  ON product_repricing_batch_items(product_id,created_at DESC);

-- A jelenlegi, régi rendszerből származó ár minden terméknél egy történeti
-- alapverzió. 1900-01-01 csak technikai kezdődátum: azt jelenti, hogy a
-- migráció előtti időszakban ez volt a rendelkezésre álló törzsár.
INSERT INTO product_price_versions(product_id,retail_price_gross,valid_from,source,created_by)
SELECT p.id,COALESCE(p.retail_price_gross,p.price,0),DATE '1900-01-01','legacy-baseline','migration'
FROM products p
WHERE NOT EXISTS(
  SELECT 1 FROM product_price_versions v
  WHERE v.product_id=p.id AND v.cancelled_at IS NULL
);

CREATE OR REPLACE FUNCTION effective_product_price_version_id(
  p_product_id uuid,
  p_on_date date DEFAULT CURRENT_DATE
) RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT v.id
  FROM product_price_versions v
  WHERE v.product_id=p_product_id
    AND v.cancelled_at IS NULL
    AND v.valid_from<=COALESCE(p_on_date,CURRENT_DATE)
    AND (v.valid_to IS NULL OR v.valid_to>=COALESCE(p_on_date,CURRENT_DATE))
  ORDER BY v.valid_from DESC,v.created_at DESC
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION effective_product_price(
  p_product_id uuid,
  p_on_date date DEFAULT CURRENT_DATE
) RETURNS numeric
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (
      SELECT v.retail_price_gross
      FROM product_price_versions v
      WHERE v.product_id=p_product_id
        AND v.cancelled_at IS NULL
        AND v.valid_from<=COALESCE(p_on_date,CURRENT_DATE)
        AND (v.valid_to IS NULL OR v.valid_to>=COALESCE(p_on_date,CURRENT_DATE))
      ORDER BY v.valid_from DESC,v.created_at DESC
      LIMIT 1
    ),
    (
      SELECT COALESCE(p.retail_price_gross,p.price,0)
      FROM products p WHERE p.id=p_product_id
    ),
    0
  )
$$;

-- Egy új intervallum nem írja felül a történetet. Az átfedő régi szakaszt
-- bal/jobb részre vágjuk, a középső részt pedig az új árverzió foglalja el.
CREATE OR REPLACE FUNCTION apply_product_price_interval(
  p_product_id uuid,
  p_new_price numeric,
  p_valid_from date,
  p_valid_to date,
  p_batch_id uuid,
  p_actor text,
  p_source text DEFAULT 'bulk-repricing'
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_row product_price_versions%ROWTYPE;
  v_old_to date;
  v_new_id uuid;
BEGIN
  IF p_valid_from IS NULL THEN
    RAISE EXCEPTION 'Az új ár kezdődátuma kötelező.';
  END IF;
  IF p_valid_to IS NOT NULL AND p_valid_to<p_valid_from THEN
    RAISE EXCEPTION 'Az ár záródátuma nem lehet korábbi a kezdődátumnál.';
  END IF;
  IF p_new_price IS NULL OR p_new_price<0 THEN
    RAISE EXCEPTION 'Az eladási ár nem lehet negatív.';
  END IF;

  PERFORM 1 FROM products WHERE id=p_product_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'A termék nem található: %',p_product_id; END IF;

  FOR v_row IN
    SELECT *
    FROM product_price_versions
    WHERE product_id=p_product_id
      AND cancelled_at IS NULL
      AND valid_from<=COALESCE(p_valid_to,DATE '9999-12-31')
      AND COALESCE(valid_to,DATE '9999-12-31')>=p_valid_from
    ORDER BY valid_from,created_at
    FOR UPDATE
  LOOP
    v_old_to:=v_row.valid_to;

    IF v_row.valid_from<p_valid_from THEN
      UPDATE product_price_versions
      SET valid_to=p_valid_from-1
      WHERE id=v_row.id;
    ELSE
      UPDATE product_price_versions
      SET cancelled_at=now(),cancelled_by=p_actor,
          cancellation_reason=COALESCE('Felülírta az új árintervallum: '||p_valid_from::text||
            CASE WHEN p_valid_to IS NULL THEN '–' ELSE '–'||p_valid_to::text END,'Átárazás')
      WHERE id=v_row.id;
    END IF;

    IF p_valid_to IS NOT NULL AND (v_old_to IS NULL OR v_old_to>p_valid_to) THEN
      INSERT INTO product_price_versions(
        product_id,batch_id,retail_price_gross,currency,valid_from,valid_to,
        source,parent_version_id,created_by
      ) VALUES(
        p_product_id,v_row.batch_id,v_row.retail_price_gross,v_row.currency,
        p_valid_to+1,v_old_to,'interval-continuation',v_row.id,p_actor
      );
    END IF;
  END LOOP;

  INSERT INTO product_price_versions(
    product_id,batch_id,retail_price_gross,currency,valid_from,valid_to,source,created_by
  ) VALUES(
    p_product_id,p_batch_id,round(p_new_price,2),'HUF',p_valid_from,p_valid_to,p_source,p_actor
  ) RETURNING id INTO v_new_id;

  RETURN v_new_id;
END;
$$;

-- A régi terméktörzs mezői csak a MA érvényes ár kompatibilitási cache-ei.
-- A készlet unit_cost / purchase_price_net / average_price mezőit ez a függvény
-- szándékosan nem érinti.
CREATE OR REPLACE FUNCTION sync_current_product_prices()
RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  v_count integer:=0;
BEGIN
  PERFORM set_config('kleo.pricing_sync','1',true);
  WITH effective AS (
    SELECT p.id,effective_product_price(p.id,CURRENT_DATE)::numeric(14,2) current_price
    FROM products p
  ), changed AS (
    UPDATE products p
    SET retail_price_gross=e.current_price,
        price=e.current_price,
        updated_at=now()
    FROM effective e
    WHERE p.id=e.id
      AND (
        p.retail_price_gross IS DISTINCT FROM e.current_price
        OR p.price IS DISTINCT FROM e.current_price
      )
    RETURNING p.id
  )
  SELECT count(*)::integer INTO v_count FROM changed;
  RETURN v_count;
END;
$$;

-- Ha valaki a régi/egyedi termék-adatlapon ír át árat, az se törölje a múltat.
-- A direkt módosítás a mai naptól a következő előre ütemezett árszakaszig él.
CREATE OR REPLACE FUNCTION capture_legacy_product_price_change()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_price numeric(14,2);
  v_next_start date;
  v_current numeric(14,2);
BEGIN
  IF current_setting('kleo.pricing_sync',true)='1' THEN RETURN NEW; END IF;

  IF NEW.retail_price_gross IS DISTINCT FROM OLD.retail_price_gross THEN
    v_price:=COALESCE(NEW.retail_price_gross,NEW.price,0);
  ELSIF NEW.price IS DISTINCT FROM OLD.price THEN
    v_price:=COALESCE(NEW.price,NEW.retail_price_gross,0);
  ELSE
    RETURN NEW;
  END IF;

  v_current:=effective_product_price(NEW.id,CURRENT_DATE)::numeric(14,2);
  IF v_price IS NOT DISTINCT FROM v_current THEN RETURN NEW; END IF;

  SELECT min(valid_from) INTO v_next_start
  FROM product_price_versions
  WHERE product_id=NEW.id AND cancelled_at IS NULL AND valid_from>CURRENT_DATE;

  PERFORM apply_product_price_interval(
    NEW.id,v_price,CURRENT_DATE,
    CASE WHEN v_next_start IS NULL THEN NULL ELSE v_next_start-1 END,
    NULL,COALESCE(current_setting('application_name',true),'legacy-product-edit'),
    'legacy-product-edit'
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_capture_legacy_product_price_change ON products;
CREATE TRIGGER trg_capture_legacy_product_price_change
AFTER UPDATE OF retail_price_gross,price ON products
FOR EACH ROW EXECUTE FUNCTION capture_legacy_product_price_change();

CREATE OR REPLACE FUNCTION seed_new_product_price_version()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM product_price_versions WHERE product_id=NEW.id AND cancelled_at IS NULL) THEN
    INSERT INTO product_price_versions(product_id,retail_price_gross,valid_from,source,created_by)
    VALUES(NEW.id,COALESCE(NEW.retail_price_gross,NEW.price,0),CURRENT_DATE,'product-create','product-create');
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_seed_new_product_price_version ON products;
CREATE TRIGGER trg_seed_new_product_price_version
AFTER INSERT ON products
FOR EACH ROW EXECUTE FUNCTION seed_new_product_price_version();

-- Munkalaptétel: a termékár a munkalap dátumán érvényes verzióból kerül a
-- tételbe. Ettől kezdve a unit_price/line_total snapshot; későbbi átárazás nem
-- módosítja visszamenőleg.
DO $$
BEGIN
  IF to_regclass('public.work_order_items') IS NOT NULL THEN
    ALTER TABLE work_order_items ADD COLUMN IF NOT EXISTS product_price_version_id uuid REFERENCES product_price_versions(id) ON DELETE SET NULL;
    ALTER TABLE work_order_items ADD COLUMN IF NOT EXISTS pricing_date date;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION snapshot_work_order_product_price()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_pricing_date date;
  v_version_id uuid;
  v_price numeric(14,2);
BEGIN
  IF NEW.product_id IS NULL OR lower(COALESCE(NEW.item_type,''))<>'product' THEN RETURN NEW; END IF;

  SELECT COALESCE(source_created_at,created_at)::date
  INTO v_pricing_date
  FROM work_orders WHERE id=NEW.work_order_id;
  v_pricing_date:=COALESCE(v_pricing_date,CURRENT_DATE);

  v_version_id:=effective_product_price_version_id(NEW.product_id,v_pricing_date);
  v_price:=effective_product_price(NEW.product_id,v_pricing_date)::numeric(14,2);

  NEW.product_price_version_id:=v_version_id;
  NEW.pricing_date:=v_pricing_date;
  NEW.unit_price:=v_price;
  NEW.line_total:=GREATEST(
    0,
    round((COALESCE(NEW.quantity,1)::numeric*v_price-COALESCE(NEW.discount_amount,0)::numeric),2)
  );
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF to_regclass('public.work_order_items') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_snapshot_work_order_product_price ON work_order_items;
    CREATE TRIGGER trg_snapshot_work_order_product_price
    BEFORE INSERT ON work_order_items
    FOR EACH ROW EXECUTE FUNCTION snapshot_work_order_product_price();
  END IF;
END $$;

-- ============================================================================
-- Csoportos átárazási motor – a meglévő generikus VIR modulon keresztül.
-- Egy létrehozott 'product-repricing' rekord alkalmazza a teljes batch-et.
-- ============================================================================
CREATE OR REPLACE FUNCTION apply_product_repricing_vir_record()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_batch_id uuid;
  v_scope_type text;
  v_scope_value text;
  v_adjustment_type text;
  v_adjustment_value numeric;
  v_rounding numeric;
  v_valid_from date;
  v_valid_to date;
  v_reason text;
  v_actor text;
  v_product record;
  v_old_price numeric(14,2);
  v_new_price numeric(14,2);
  v_version_id uuid;
  v_count integer:=0;
BEGIN
  IF NEW.module_key<>'product-repricing' THEN RETURN NEW; END IF;
  IF NEW.status NOT IN ('scheduled','active','approved') THEN RETURN NEW; END IF;

  SELECT id INTO v_batch_id FROM product_repricing_batches WHERE vir_record_id=NEW.id;
  IF v_batch_id IS NOT NULL THEN RETURN NEW; END IF;

  v_scope_type:=lower(COALESCE(NULLIF(NEW.payload->>'scope_type',''),'all'));
  v_scope_value:=NULLIF(trim(COALESCE(NEW.payload->>'scope_value','')),'');
  v_adjustment_type:=lower(COALESCE(NULLIF(NEW.payload->>'adjustment_type',''),'percent'));
  v_adjustment_value:=NULLIF(NEW.payload->>'adjustment_value','')::numeric;
  v_rounding:=COALESCE(NULLIF(NEW.payload->>'rounding_increment','')::numeric,1);
  v_valid_from:=NULLIF(NEW.payload->>'valid_from','')::date;
  v_valid_to:=NULLIF(NEW.payload->>'valid_to','')::date;
  v_reason:=NULLIF(trim(COALESCE(NEW.payload->>'reason','')),'');
  v_actor:=COALESCE(NEW.created_by,'vir-repricing');

  IF v_valid_from IS NULL THEN RAISE EXCEPTION 'Az átárazás kezdődátuma kötelező.'; END IF;
  IF v_valid_to IS NOT NULL AND v_valid_to<v_valid_from THEN RAISE EXCEPTION 'A záródátum nem lehet korábbi a kezdődátumnál.'; END IF;
  IF v_adjustment_value IS NULL THEN RAISE EXCEPTION 'Az árváltozás értéke kötelező.'; END IF;
  IF v_adjustment_type NOT IN ('percent','fixed','set') THEN RAISE EXCEPTION 'Ismeretlen átárazási mód: %',v_adjustment_type; END IF;
  IF v_scope_type NOT IN ('all','merchandise','service_material','group','category','products') THEN RAISE EXCEPTION 'Ismeretlen termékkör: %',v_scope_type; END IF;
  IF v_scope_type IN ('group','category','products') AND v_scope_value IS NULL THEN RAISE EXCEPTION 'A kiválasztott termékkörhöz azonosító(k) megadása szükséges.'; END IF;
  IF v_rounding<=0 THEN RAISE EXCEPTION 'A kerekítési lépcső csak pozitív lehet.'; END IF;

  INSERT INTO product_repricing_batches(
    vir_record_id,title,scope_type,scope_value,adjustment_type,adjustment_value,
    rounding_increment,valid_from,valid_to,reason,created_by
  ) VALUES(
    NEW.id,NEW.title,v_scope_type,v_scope_value,v_adjustment_type,v_adjustment_value,
    v_rounding,v_valid_from,v_valid_to,v_reason,v_actor
  ) RETURNING id INTO v_batch_id;

  FOR v_product IN
    SELECT p.id,p.name,p.internal_code
    FROM products p
    WHERE COALESCE(p.is_active,true)=true
      AND (
        v_scope_type='all'
        OR (v_scope_type='merchandise' AND COALESCE(p.is_merchandise,false))
        OR (v_scope_type='service_material' AND COALESCE(p.is_service_material,false))
        OR (v_scope_type='group' AND p.product_group_id::text=v_scope_value)
        OR (v_scope_type='category' AND p.product_category_id::text=v_scope_value)
        OR (v_scope_type='products' AND p.id::text=ANY(string_to_array(replace(v_scope_value,' ',''),',')))
      )
    ORDER BY p.name
    FOR UPDATE
  LOOP
    v_old_price:=effective_product_price(v_product.id,v_valid_from)::numeric(14,2);
    v_new_price:=CASE v_adjustment_type
      WHEN 'percent' THEN v_old_price*(1+v_adjustment_value/100)
      WHEN 'fixed' THEN v_old_price+v_adjustment_value
      WHEN 'set' THEN v_adjustment_value
    END;
    v_new_price:=GREATEST(0,round((v_new_price/v_rounding))*v_rounding)::numeric(14,2);

    v_version_id:=apply_product_price_interval(
      v_product.id,v_new_price,v_valid_from,v_valid_to,v_batch_id,v_actor,'bulk-repricing'
    );

    INSERT INTO product_repricing_batch_items(batch_id,product_id,price_version_id,old_price,new_price)
    VALUES(v_batch_id,v_product.id,v_version_id,v_old_price,v_new_price);
    v_count:=v_count+1;
  END LOOP;

  IF v_count=0 THEN
    RAISE EXCEPTION 'A megadott feltételekkel egyetlen aktív termék sem található.';
  END IF;

  UPDATE product_repricing_batches SET product_count=v_count WHERE id=v_batch_id;
  PERFORM sync_current_product_prices();

  -- Visszaírjuk a batch azonosítót és az érintett termékszámot a VIR rekordba.
  -- A rekurzív triggerhívás a már létező batch miatt azonnal kilép.
  UPDATE vir_module_records
  SET payload=COALESCE(payload,'{}'::jsonb)||jsonb_build_object(
        'applied_batch_id',v_batch_id,
        'product_count',v_count,
        'applied_at',now()
      ),
      updated_at=now()
  WHERE id=NEW.id;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_apply_product_repricing_vir_record ON vir_module_records;
CREATE TRIGGER trg_apply_product_repricing_vir_record
AFTER INSERT OR UPDATE OF status,payload ON vir_module_records
FOR EACH ROW EXECUTE FUNCTION apply_product_repricing_vir_record();

-- Generikus VIR kezelőfelülethez moduldefiníció + menü.
INSERT INTO vir_module_definitions(
  module_key,title,category,route,description,entity_label,icon,fields,statuses,
  spec_reference,order_index,is_active
) VALUES(
  'product-repricing','Csoportos termék átárazás','Törzsadatok','/pricing/products',
  'Dátumtól dátumig érvényes csoportos eladási árak. A régi árak, lezárt munkalapok és készlet-beszerzési értékek változatlanul megmaradnak.',
  'átárazási csomag','BadgePercent',
  '[
    {"key":"scope_type","label":"Termékkör","type":"select","required":true,"options":["all","merchandise","service_material","group","category","products"]},
    {"key":"scope_value","label":"Csoport/kategória azonosító vagy termék ID-k vesszővel","type":"textarea"},
    {"key":"adjustment_type","label":"Átárazás módja","type":"select","required":true,"options":["percent","fixed","set"]},
    {"key":"adjustment_value","label":"Változás értéke (% / Ft / új ár)","type":"number","required":true},
    {"key":"rounding_increment","label":"Kerekítési lépcső (Ft)","type":"number","required":true},
    {"key":"valid_from","label":"Érvényes ettől","type":"date","required":true},
    {"key":"valid_to","label":"Érvényes eddig (üres = visszavonásig)","type":"date"},
    {"key":"reason","label":"Átárazás oka / megjegyzés","type":"textarea"}
  ]'::jsonb,
  '["scheduled","active","cancelled","archived"]'::jsonb,
  'VIR kiegészítés – történeti, időszakos termékár-kezelés',62,true
)
ON CONFLICT(module_key) DO UPDATE SET
  title=EXCLUDED.title,category=EXCLUDED.category,route=EXCLUDED.route,
  description=EXCLUDED.description,entity_label=EXCLUDED.entity_label,icon=EXCLUDED.icon,
  fields=EXCLUDED.fields,statuses=EXCLUDED.statuses,spec_reference=EXCLUDED.spec_reference,
  order_index=EXCLUDED.order_index,is_active=true,updated_at=now();

WITH parent AS (SELECT id FROM menus WHERE code='masterdata' LIMIT 1)
INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
SELECT 'masterdata.product-repricing','Csoportos termék átárazás','BadgePercent','/pricing/products',62,p.id,'products',true
FROM parent p
ON CONFLICT(code) DO UPDATE SET
  name=EXCLUDED.name,icon=EXCLUDED.icon,route=EXCLUDED.route,order_index=EXCLUDED.order_index,
  parent_id=EXCLUDED.parent_id,feature_key=EXCLUDED.feature_key,is_active=true;

INSERT INTO role_menu_permissions
  (role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,can_manage_permissions,scope_type)
SELECT 'admin',m.id,true,true,true,false,true,true,true,true,'all_locations'
FROM menus m WHERE m.code='masterdata.product-repricing'
ON CONFLICT(role_key,menu_id) DO NOTHING;

INSERT INTO role_menu_permissions
  (role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,can_manage_permissions,scope_type)
SELECT 'manager',m.id,true,true,false,false,true,true,true,false,'all_locations'
FROM menus m WHERE m.code='masterdata.product-repricing'
ON CONFLICT(role_key,menu_id) DO NOTHING;

SELECT sync_current_product_prices();

INSERT INTO schema_migrations(version,description)
VALUES('20260817_PRODUCT_PRICE_HISTORY_V1','Időbeli termékárak, történeti ármegőrzés, munkalap ár-snapshot és csoportos átárazás')
ON CONFLICT(version) DO NOTHING;

COMMIT;
