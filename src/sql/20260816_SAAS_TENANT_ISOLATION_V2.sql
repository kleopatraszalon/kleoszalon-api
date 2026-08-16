BEGIN;
SET LOCAL statement_timeout = 0;

-- ============================================================
-- VIR SaaS Core v2 – tenant isolation for critical business data
-- Idempotent migration; preserves all legacy Kleopátra rows.
-- This one-shot legacy backfill can touch large tables, therefore it must not
-- inherit a short request-oriented PostgreSQL statement_timeout.
-- ============================================================

DO $$
DECLARE
  t bigint;
  r record;
BEGIN
  SELECT id INTO t FROM tenants WHERE slug='kleopatra' LIMIT 1;
  IF t IS NULL THEN
    RAISE EXCEPTION 'Kleopatra tenant missing. Run SaaS Core v1 first.';
  END IF;

  FOR r IN
    SELECT unnest(ARRAY[
      'employees',
      'clients',
      'appointments',
      'work_orders',
      'product_stock_balances',
      'purchase_orders'
    ]) AS table_name
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema='public' AND table_name=r.table_name
    ) THEN
      EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS tenant_id bigint', r.table_name);

      IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema='public' AND table_name=r.table_name AND column_name='location_id'
      ) THEN
        EXECUTE format(
          'UPDATE %I e SET tenant_id=l.tenant_id FROM locations l '
          'WHERE e.tenant_id IS NULL AND e.location_id IS NOT NULL '
          'AND e.location_id::text=l.id::text AND l.tenant_id IS NOT NULL',
          r.table_name
        );
      END IF;

      EXECUTE format('UPDATE %I SET tenant_id=$1 WHERE tenant_id IS NULL', r.table_name) USING t;
      EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I(tenant_id)', r.table_name || '_tenant_idx', r.table_name);
    END IF;
  END LOOP;
END $$;

-- Integrity checks: any location-bound row must agree with its location tenant.
DO $$
DECLARE
  r record;
  mismatch_count bigint;
BEGIN
  FOR r IN
    SELECT unnest(ARRAY['employees','clients','appointments','work_orders','product_stock_balances','purchase_orders']) AS table_name
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name=r.table_name AND column_name='location_id'
    ) AND EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name=r.table_name AND column_name='tenant_id'
    ) THEN
      EXECUTE format(
        'SELECT count(*) FROM %I e JOIN locations l ON l.id::text=e.location_id::text '
        'WHERE e.tenant_id IS DISTINCT FROM l.tenant_id',
        r.table_name
      ) INTO mismatch_count;
      IF mismatch_count > 0 THEN
        RAISE EXCEPTION 'Tenant/location mismatch in %: % rows', r.table_name, mismatch_count;
      END IF;
    END IF;
  END LOOP;
END $$;

COMMIT;

-- Verification examples:
-- SELECT tenant_id,count(*) FROM appointments GROUP BY tenant_id ORDER BY tenant_id;
-- SELECT tenant_id,count(*) FROM clients GROUP BY tenant_id ORDER BY tenant_id;
-- SELECT tenant_id,count(*) FROM employees GROUP BY tenant_id ORDER BY tenant_id;
