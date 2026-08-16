BEGIN;
SET LOCAL statement_timeout = 0;

-- ============================================================
-- VIR SaaS Core v2 – tenant isolation for critical business data
-- Idempotent migration; preserves all legacy Kleopátra rows.
-- This one-shot legacy backfill can touch large tables, therefore it must not
-- inherit a short request-oriented PostgreSQL statement_timeout.
--
-- Legacy appointments may contain rows that predate the current time-order
-- CHECK constraint. Updating only tenant_id would make PostgreSQL re-check the
-- entire row and reject the backfill. Preserve the exact constraint definition,
-- temporarily remove it inside this transaction, then restore it as NOT VALID:
-- existing legacy violations remain untouched, while every new/updated row is
-- still protected by the CHECK condition.
-- ============================================================

DO $$
DECLARE
  t bigint;
  r record;
  appointment_time_order_def text;
BEGIN
  SELECT id INTO t FROM tenants WHERE slug='kleopatra' LIMIT 1;
  IF t IS NULL THEN
    RAISE EXCEPTION 'Kleopatra tenant missing. Run SaaS Core v1 first.';
  END IF;

  SELECT regexp_replace(pg_get_constraintdef(c.oid, true), '\s+NOT VALID$', '', 'i')
    INTO appointment_time_order_def
    FROM pg_constraint c
    JOIN pg_class rel ON rel.oid=c.conrelid
    JOIN pg_namespace n ON n.oid=rel.relnamespace
   WHERE n.nspname='public'
     AND rel.relname='appointments'
     AND c.conname='chk_appointments_time_order_phase3'
     AND c.contype='c'
   LIMIT 1;

  IF appointment_time_order_def IS NOT NULL THEN
    ALTER TABLE appointments DROP CONSTRAINT chk_appointments_time_order_phase3;
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

  IF appointment_time_order_def IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM pg_constraint c
      JOIN pg_class rel ON rel.oid=c.conrelid
      JOIN pg_namespace n ON n.oid=rel.relnamespace
     WHERE n.nspname='public'
       AND rel.relname='appointments'
       AND c.conname='chk_appointments_time_order_phase3'
  ) THEN
    EXECUTE format(
      'ALTER TABLE appointments ADD CONSTRAINT %I %s NOT VALID',
      'chk_appointments_time_order_phase3',
      appointment_time_order_def
    );
  END IF;
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
