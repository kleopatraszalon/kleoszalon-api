BEGIN;
SET LOCAL statement_timeout = 0;

-- VIR SaaS Core v2 – tenant isolation for critical business data.
-- Legacy rows may predate current CHECK constraints. Tenant-only UPDATEs must
-- not rewrite business data or fail because PostgreSQL rechecks those old rows.
-- Exact CHECK definitions are preserved and restored as NOT VALID, which keeps
-- them enforced for every new/updated row while tolerating historical violations.

DO $$
DECLARE
  t bigint;
  r record;
  appointment_time_order_def text;
  work_order_operational_status_def text;
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
   WHERE n.nspname='public' AND rel.relname='appointments'
     AND c.conname='chk_appointments_time_order_phase3' AND c.contype='c'
   LIMIT 1;

  SELECT regexp_replace(pg_get_constraintdef(c.oid, true), '\s+NOT VALID$', '', 'i')
    INTO work_order_operational_status_def
    FROM pg_constraint c
    JOIN pg_class rel ON rel.oid=c.conrelid
    JOIN pg_namespace n ON n.oid=rel.relnamespace
   WHERE n.nspname='public' AND rel.relname='work_orders'
     AND c.conname='chk_work_orders_operational_status' AND c.contype='c'
   LIMIT 1;

  IF appointment_time_order_def IS NOT NULL THEN
    ALTER TABLE appointments DISABLE TRIGGER USER;
    ALTER TABLE appointments DROP CONSTRAINT chk_appointments_time_order_phase3;
  END IF;

  IF work_order_operational_status_def IS NOT NULL THEN
    ALTER TABLE work_orders DISABLE TRIGGER USER;
    ALTER TABLE work_orders DROP CONSTRAINT chk_work_orders_operational_status;
  END IF;

  FOR r IN
    SELECT unnest(ARRAY[
      'employees','clients','appointments','work_orders',
      'product_stock_balances','purchase_orders'
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

  IF appointment_time_order_def IS NOT NULL OR work_order_operational_status_def IS NOT NULL THEN
    SET CONSTRAINTS ALL IMMEDIATE;
  END IF;

  IF appointment_time_order_def IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint c JOIN pg_class rel ON rel.oid=c.conrelid
       WHERE rel.relname='appointments' AND c.conname='chk_appointments_time_order_phase3'
    ) THEN
      EXECUTE format(
        'ALTER TABLE appointments ADD CONSTRAINT %I %s NOT VALID',
        'chk_appointments_time_order_phase3', appointment_time_order_def
      );
    END IF;
    ALTER TABLE appointments ENABLE TRIGGER USER;
  END IF;

  IF work_order_operational_status_def IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint c JOIN pg_class rel ON rel.oid=c.conrelid
       WHERE rel.relname='work_orders' AND c.conname='chk_work_orders_operational_status'
    ) THEN
      EXECUTE format(
        'ALTER TABLE work_orders ADD CONSTRAINT %I %s NOT VALID',
        'chk_work_orders_operational_status', work_order_operational_status_def
      );
    END IF;
    ALTER TABLE work_orders ENABLE TRIGGER USER;
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
        'WHERE e.tenant_id IS DISTINCT FROM l.tenant_id', r.table_name
      ) INTO mismatch_count;
      IF mismatch_count > 0 THEN
        RAISE EXCEPTION 'Tenant/location mismatch in %: % rows', r.table_name, mismatch_count;
      END IF;
    END IF;
  END LOOP;
END $$;

COMMIT;
