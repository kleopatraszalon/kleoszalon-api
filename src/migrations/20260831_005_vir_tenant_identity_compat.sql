-- VIR tenant identity compatibility migration
--
-- The canonical SaaS tenant key is BIGINT. Some older VIR support tables were
-- created with tenant_id UUID, which makes the same authenticated tenant
-- impossible to use consistently across canonical business tables and legacy
-- intelligence tables. Preserve any historical UUID values losslessly by
-- converging only legacy UUID VIR columns to TEXT. New numeric tenant ids can
-- then be stored as text while existing UUID audit/history rows remain intact.

DO $$
DECLARE
  rec record;
BEGIN
  FOR rec IN
    SELECT table_schema, table_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND column_name = 'tenant_id'
       AND udt_name = 'uuid'
       AND table_name LIKE 'vir\_%' ESCAPE '\'
     ORDER BY table_name
  LOOP
    RAISE NOTICE 'Converting %.%.tenant_id UUID -> TEXT', rec.table_schema, rec.table_name;
    EXECUTE format(
      'ALTER TABLE %I.%I ALTER COLUMN tenant_id TYPE text USING tenant_id::text',
      rec.table_schema,
      rec.table_name
    );
  END LOOP;
END
$$;

-- Defensive verification: after this migration no VIR-owned tenant column may
-- remain UUID. Canonical BIGINT columns are intentionally left unchanged.
DO $$
DECLARE
  remaining integer;
BEGIN
  SELECT COUNT(*)::int
    INTO remaining
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND column_name = 'tenant_id'
     AND udt_name = 'uuid'
     AND table_name LIKE 'vir\_%' ESCAPE '\';

  IF remaining <> 0 THEN
    RAISE EXCEPTION 'VIR tenant compatibility migration incomplete: % UUID tenant columns remain', remaining;
  END IF;
END
$$;
