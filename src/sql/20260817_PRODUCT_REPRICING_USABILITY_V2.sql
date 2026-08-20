BEGIN;

-- A generikus VIR átárazási képernyő kezelőbarát normalizálása.
-- Csoport/kategória névvel vagy kóddal, termék pedig ID/belső kód/vonalkód
-- alapján is kiválasztható. A felületen magyar megnevezések jelennek meg,
-- az üzleti trigger egységes belső kulcsokat kap.

CREATE OR REPLACE FUNCTION normalize_product_repricing_vir_record()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_scope text;
  v_scope_value text;
  v_mode text;
  v_resolved text;
  v_token text;
  v_product_id text;
BEGIN
  IF NEW.module_key<>'product-repricing' THEN RETURN NEW; END IF;

  v_scope:=lower(trim(COALESCE(NEW.payload->>'scope_type','')));
  v_scope:=CASE v_scope
    WHEN 'minden termék' THEN 'all'
    WHEN 'értékesített termékek' THEN 'merchandise'
    WHEN 'szolgáltatási anyagok' THEN 'service_material'
    WHEN 'termékcsoport' THEN 'group'
    WHEN 'termékkategória' THEN 'category'
    WHEN 'kiválasztott termékek' THEN 'products'
    ELSE v_scope
  END;

  v_mode:=lower(trim(COALESCE(NEW.payload->>'adjustment_type','')));
  v_mode:=CASE v_mode
    WHEN 'százalékos változás' THEN 'percent'
    WHEN 'fix ft eltérés' THEN 'fixed'
    WHEN 'konkrét új ár' THEN 'set'
    ELSE v_mode
  END;

  v_scope_value:=trim(COALESCE(NEW.payload->>'scope_value',''));

  IF v_scope='group' AND v_scope_value<>'' THEN
    SELECT g.id::text INTO v_resolved
    FROM product_groups g
    WHERE g.id::text=v_scope_value
       OR lower(COALESCE(g.name,''))=lower(v_scope_value)
       OR lower(COALESCE(g.code,''))=lower(v_scope_value)
    ORDER BY CASE WHEN g.id::text=v_scope_value THEN 0 WHEN lower(COALESCE(g.code,''))=lower(v_scope_value) THEN 1 ELSE 2 END
    LIMIT 1;
    IF v_resolved IS NULL THEN RAISE EXCEPTION 'A termékcsoport nem található: %',v_scope_value; END IF;
    v_scope_value:=v_resolved;
  ELSIF v_scope='category' AND v_scope_value<>'' THEN
    SELECT c.id::text INTO v_resolved
    FROM product_categories c
    WHERE c.id::text=v_scope_value
       OR lower(COALESCE(c.name,''))=lower(v_scope_value)
       OR lower(COALESCE(c.code,''))=lower(v_scope_value)
    ORDER BY CASE WHEN c.id::text=v_scope_value THEN 0 WHEN lower(COALESCE(c.code,''))=lower(v_scope_value) THEN 1 ELSE 2 END
    LIMIT 1;
    IF v_resolved IS NULL THEN RAISE EXCEPTION 'A termékkategória nem található: %',v_scope_value; END IF;
    v_scope_value:=v_resolved;
  ELSIF v_scope='products' AND v_scope_value<>'' THEN
    v_resolved:='';
    FOR v_token IN SELECT trim(x) FROM regexp_split_to_table(v_scope_value,'[,;\n]+') x WHERE trim(x)<>'' LOOP
      v_product_id:=NULL;
      SELECT p.id::text INTO v_product_id
      FROM products p
      WHERE p.id::text=v_token
         OR lower(COALESCE(p.internal_code,''))=lower(v_token)
         OR lower(COALESCE(p.barcode,''))=lower(v_token)
      ORDER BY CASE WHEN p.id::text=v_token THEN 0 WHEN lower(COALESCE(p.internal_code,''))=lower(v_token) THEN 1 ELSE 2 END
      LIMIT 1;
      IF v_product_id IS NULL THEN RAISE EXCEPTION 'A termék nem található (ID/belső kód/vonalkód): %',v_token; END IF;
      IF position(v_product_id IN v_resolved)=0 THEN
        v_resolved:=v_resolved||CASE WHEN v_resolved='' THEN '' ELSE ',' END||v_product_id;
      END IF;
    END LOOP;
    v_scope_value:=v_resolved;
  END IF;

  NEW.payload:=COALESCE(NEW.payload,'{}'::jsonb)
    ||jsonb_build_object('scope_type',v_scope,'adjustment_type',v_mode)
    ||CASE WHEN v_scope_value='' THEN '{}'::jsonb ELSE jsonb_build_object('scope_value',v_scope_value) END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_00_normalize_product_repricing_vir_record ON vir_module_records;
CREATE TRIGGER trg_00_normalize_product_repricing_vir_record
BEFORE INSERT OR UPDATE OF payload,status ON vir_module_records
FOR EACH ROW EXECUTE FUNCTION normalize_product_repricing_vir_record();

UPDATE vir_module_definitions
SET fields='[
  {"key":"scope_type","label":"Termékkör","type":"select","required":true,"options":["Minden termék","Értékesített termékek","Szolgáltatási anyagok","Termékcsoport","Termékkategória","Kiválasztott termékek"]},
  {"key":"scope_value","label":"Csoport/kategória neve vagy kódja; termékeknél ID / belső kód / vonalkód (több érték vesszővel)","type":"textarea"},
  {"key":"adjustment_type","label":"Átárazás módja","type":"select","required":true,"options":["Százalékos változás","Fix Ft eltérés","Konkrét új ár"]},
  {"key":"adjustment_value","label":"Változás értéke (% / Ft / új ár)","type":"number","required":true},
  {"key":"rounding_increment","label":"Kerekítési lépcső (Ft)","type":"number","required":true},
  {"key":"valid_from","label":"Érvényes ettől","type":"date","required":true},
  {"key":"valid_to","label":"Érvényes eddig (üres = visszavonásig)","type":"date"},
  {"key":"reason","label":"Átárazás oka / megjegyzés","type":"textarea"}
]'::jsonb,
    description='Csoportos eladási ár módosítás dátumtól dátumig. A korábbi és későbbi árszakasz megmarad; a készlet beszerzési/átlagára és a lezárt bizonylatok nem változnak. Csoport/kategória névvel vagy kóddal, termék ID/belső kód/vonalkód alapján is megadható.',
    updated_at=now()
WHERE module_key='product-repricing';

INSERT INTO schema_migrations(version,description)
VALUES('20260817_PRODUCT_REPRICING_USABILITY_V2','Csoportos átárazás kezelőbarát magyar opciók és név/kód alapú termékkör-feloldás')
ON CONFLICT(version) DO NOTHING;

COMMIT;
