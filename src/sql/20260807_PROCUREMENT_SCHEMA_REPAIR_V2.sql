BEGIN;

-- Beszerzés / raktár séma javítás pgAdminhoz.
-- A meglévő products/work_orders azonosítótípusokból dolgozik, ezért nem feltételez bigint/uuid típust.
DO $$
DECLARE
  v_product_type text;
  v_location_type text;
  v_work_order_type text;
BEGIN
  SELECT format_type(a.atttypid,a.atttypmod)
    INTO v_product_type
  FROM pg_attribute a
  JOIN pg_class c ON c.oid=a.attrelid
  JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname='products' AND a.attname='id'
    AND a.attnum>0 AND NOT a.attisdropped;

  SELECT format_type(a.atttypid,a.atttypmod)
    INTO v_location_type
  FROM pg_attribute a
  JOIN pg_class c ON c.oid=a.attrelid
  JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname='work_orders' AND a.attname='location_id'
    AND a.attnum>0 AND NOT a.attisdropped;

  SELECT format_type(a.atttypid,a.atttypmod)
    INTO v_work_order_type
  FROM pg_attribute a
  JOIN pg_class c ON c.oid=a.attrelid
  JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname='work_orders' AND a.attname='id'
    AND a.attnum>0 AND NOT a.attisdropped;

  IF v_product_type IS NULL THEN RAISE EXCEPTION 'products.id nem található'; END IF;
  IF v_location_type IS NULL THEN v_location_type := 'text'; END IF;
  IF v_work_order_type IS NULL THEN v_work_order_type := 'text'; END IF;

  IF to_regclass('public.product_stock_balances') IS NULL THEN
    EXECUTE format($sql$
      CREATE TABLE product_stock_balances (
        id bigserial PRIMARY KEY,
        product_id %s NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        location_id %s,
        quantity numeric(14,3) NOT NULL DEFAULT 0,
        min_quantity numeric(14,3) NOT NULL DEFAULT 0,
        unit_cost numeric(14,2) NOT NULL DEFAULT 0,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    $sql$,v_product_type,v_location_type);
  END IF;

  IF to_regclass('public.inventory_movements') IS NULL THEN
    EXECUTE format($sql$
      CREATE TABLE inventory_movements (
        id bigserial PRIMARY KEY,
        product_id %s NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
        location_id %s,
        work_order_id %s,
        movement_type varchar(32) NOT NULL,
        quantity numeric(14,3) NOT NULL,
        balance_after numeric(14,3),
        unit_cost numeric(14,2) NOT NULL DEFAULT 0,
        stock_value_after numeric(14,2) NOT NULL DEFAULT 0,
        note text,
        created_by text,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    $sql$,v_product_type,v_location_type,v_work_order_type);
  END IF;

  IF to_regclass('public.product_supplier_terms') IS NULL THEN
    -- suppliers lentebb már létrejön; ezt a táblát a második DO blokk készíti el.
    NULL;
  END IF;
END $$;

ALTER TABLE product_stock_balances
  ADD COLUMN IF NOT EXISTS min_quantity numeric(14,3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS unit_cost numeric(14,2) NOT NULL DEFAULT 0;

ALTER TABLE inventory_movements
  ADD COLUMN IF NOT EXISTS unit_cost numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS stock_value_after numeric(14,2) NOT NULL DEFAULT 0;

-- Az alkalmazás e-mailt/felhasználói kulcsot is naplóz created_by mezőbe.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='inventory_movements'
      AND column_name='created_by' AND data_type <> 'text'
  ) THEN
    ALTER TABLE inventory_movements
      ALTER COLUMN created_by TYPE text USING created_by::text;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS product_stock_balances_product_location_uq
  ON product_stock_balances(product_id,location_id) WHERE location_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS product_stock_balances_product_global_uq
  ON product_stock_balances(product_id) WHERE location_id IS NULL;
CREATE INDEX IF NOT EXISTS inventory_movements_created_idx
  ON inventory_movements(created_at DESC);

CREATE TABLE IF NOT EXISTS suppliers (
  id bigserial PRIMARY KEY,
  name text NOT NULL UNIQUE,
  tax_number text,
  email text,
  phone text,
  contact_name text,
  address text,
  website text,
  payment_terms_days integer NOT NULL DEFAULT 0,
  default_lead_time_days integer NOT NULL DEFAULT 3,
  active boolean NOT NULL DEFAULT true,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE v_product_type text;
BEGIN
  SELECT format_type(a.atttypid,a.atttypmod) INTO v_product_type
  FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname='products' AND a.attname='id' AND a.attnum>0 AND NOT a.attisdropped;

  IF to_regclass('public.product_supplier_terms') IS NULL THEN
    EXECUTE format($sql$
      CREATE TABLE product_supplier_terms (
        id bigserial PRIMARY KEY,
        product_id %s NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        supplier_id bigint NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
        supplier_product_code text,
        unit_price numeric(14,2) NOT NULL DEFAULT 0,
        minimum_order_quantity numeric(14,3) NOT NULL DEFAULT 1,
        lead_time_days integer NOT NULL DEFAULT 3,
        preferred boolean NOT NULL DEFAULT false,
        active boolean NOT NULL DEFAULT true,
        note text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(product_id,supplier_id)
      )
    $sql$,v_product_type);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS purchase_orders (
  id bigserial PRIMARY KEY,
  location_id text,
  supplier_name text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  expected_at date,
  note text,
  created_by text,
  updated_by text,
  ordered_at timestamptz,
  received_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS supplier_id bigint,
  ADD COLUMN IF NOT EXISTS approval_status text NOT NULL DEFAULT 'not_requested',
  ADD COLUMN IF NOT EXISTS approval_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS approval_requested_by text,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS approved_by text,
  ADD COLUMN IF NOT EXISTS rejected_at timestamptz,
  ADD COLUMN IF NOT EXISTS rejected_by text,
  ADD COLUMN IF NOT EXISTS rejection_reason text,
  ADD COLUMN IF NOT EXISTS approved_total numeric(14,2),
  ADD COLUMN IF NOT EXISTS document_number text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='purchase_orders_supplier_id_fkey') THEN
    ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_supplier_id_fkey
      FOREIGN KEY(supplier_id) REFERENCES suppliers(id);
  END IF;
END $$;

DO $$
DECLARE v_product_type text;
BEGIN
  SELECT format_type(a.atttypid,a.atttypmod) INTO v_product_type
  FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname='products' AND a.attname='id' AND a.attnum>0 AND NOT a.attisdropped;

  IF to_regclass('public.purchase_order_items') IS NULL THEN
    EXECUTE format($sql$
      CREATE TABLE purchase_order_items (
        id bigserial PRIMARY KEY,
        purchase_order_id bigint NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
        product_id %s NOT NULL REFERENCES products(id),
        ordered_quantity numeric(14,3) NOT NULL,
        received_quantity numeric(14,3) NOT NULL DEFAULT 0,
        unit_cost numeric(14,2) NOT NULL DEFAULT 0,
        actual_unit_cost numeric(14,2),
        note text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    $sql$,v_product_type);
  END IF;
END $$;

ALTER TABLE purchase_order_items
  ADD COLUMN IF NOT EXISTS received_quantity numeric(14,3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS unit_cost numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS actual_unit_cost numeric(14,2),
  ADD COLUMN IF NOT EXISTS note text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS procurement_approval_settings (
  id integer PRIMARY KEY,
  approval_threshold numeric(14,2) NOT NULL DEFAULT 50000,
  price_variance_warning_pct numeric(8,2) NOT NULL DEFAULT 10,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO procurement_approval_settings(id,approval_threshold,price_variance_warning_pct)
VALUES(1,50000,10) ON CONFLICT(id) DO NOTHING;

CREATE TABLE IF NOT EXISTS procurement_approval_events (
  id bigserial PRIMARY KEY,
  purchase_order_id bigint NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  actor_key text,
  note text,
  order_total numeric(14,2),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS product_supplier_terms_product_idx ON product_supplier_terms(product_id,preferred DESC,active DESC);
CREATE INDEX IF NOT EXISTS product_supplier_terms_supplier_idx ON product_supplier_terms(supplier_id,active DESC);
CREATE INDEX IF NOT EXISTS purchase_orders_supplier_id_idx ON purchase_orders(supplier_id,created_at DESC);
CREATE INDEX IF NOT EXISTS purchase_orders_approval_idx ON purchase_orders(approval_status,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS purchase_orders_document_number_uq ON purchase_orders(document_number) WHERE document_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS procurement_approval_events_order_idx ON procurement_approval_events(purchase_order_id,created_at DESC);

COMMIT;
