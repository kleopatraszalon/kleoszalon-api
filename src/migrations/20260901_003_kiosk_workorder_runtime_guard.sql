-- Production guard for public KIOSK work-order creation.
--
-- The kiosk endpoint is public and must not depend on an authenticated VIR page
-- having already bootstrapped compatibility columns/tables. Keep every change
-- idempotent so older production schemas can accept a kiosk work order directly.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE IF EXISTS clients ADD COLUMN IF NOT EXISTS full_name text;
ALTER TABLE IF EXISTS clients ADD COLUMN IF NOT EXISTS name text;
ALTER TABLE IF EXISTS clients ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE IF EXISTS clients ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE IF EXISTS clients ADD COLUMN IF NOT EXISTS location_id uuid;
ALTER TABLE IF EXISTS clients ADD COLUMN IF NOT EXISTS marketing_consent boolean NOT NULL DEFAULT false;
ALTER TABLE IF EXISTS clients ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
ALTER TABLE IF EXISTS clients ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';
ALTER TABLE IF EXISTS clients ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE IF EXISTS clients ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS title text;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'waiting';
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS employee_id uuid;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS client_id uuid;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS client_name text;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS client_phone text;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS client_email text;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS location_id uuid;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS fully_paid boolean NOT NULL DEFAULT false;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS note_for_another_visitor boolean NOT NULL DEFAULT false;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS created_by text;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS status_updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS work_order_number text;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS source_created_at timestamptz;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS source_snapshot jsonb;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS kiosk_queue_no integer;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS kiosk_queue_date date;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS kiosk_queue_code text;

ALTER TABLE work_orders ALTER COLUMN status SET DEFAULT 'waiting';
ALTER TABLE work_orders ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE work_orders ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE work_orders ALTER COLUMN status_updated_at SET DEFAULT now();
ALTER TABLE work_orders ALTER COLUMN fully_paid SET DEFAULT false;
ALTER TABLE work_orders ALTER COLUMN note_for_another_visitor SET DEFAULT false;

CREATE TABLE IF NOT EXISTS work_order_items(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id uuid NOT NULL,
  item_type text,
  item_name text,
  service_id uuid,
  product_id uuid,
  quantity numeric(12,3) NOT NULL DEFAULT 1,
  unit_price numeric(14,2) NOT NULL DEFAULT 0,
  discount_amount numeric(14,2) NOT NULL DEFAULT 0,
  line_total numeric(14,2) NOT NULL DEFAULT 0,
  duration_minutes integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE work_order_items ADD COLUMN IF NOT EXISTS item_type text;
ALTER TABLE work_order_items ADD COLUMN IF NOT EXISTS item_name text;
ALTER TABLE work_order_items ADD COLUMN IF NOT EXISTS service_id uuid;
ALTER TABLE work_order_items ADD COLUMN IF NOT EXISTS product_id uuid;
ALTER TABLE work_order_items ADD COLUMN IF NOT EXISTS quantity numeric(12,3) NOT NULL DEFAULT 1;
ALTER TABLE work_order_items ADD COLUMN IF NOT EXISTS unit_price numeric(14,2) NOT NULL DEFAULT 0;
ALTER TABLE work_order_items ADD COLUMN IF NOT EXISTS discount_amount numeric(14,2) NOT NULL DEFAULT 0;
ALTER TABLE work_order_items ADD COLUMN IF NOT EXISTS line_total numeric(14,2) NOT NULL DEFAULT 0;
ALTER TABLE work_order_items ADD COLUMN IF NOT EXISTS duration_minutes integer;

CREATE TABLE IF NOT EXISTS work_order_number_sequences(
  year integer PRIMARY KEY,
  last_value bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The official sequence may be behind imported/persisted work-order numbers.
-- Allocate at least MAX(persisted suffix)+1 while retaining row-level UPSERT
-- serialization for concurrent requests.
CREATE OR REPLACE FUNCTION next_official_work_order_number(p_at timestamptz DEFAULT now())
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  y integer := EXTRACT(YEAR FROM p_at)::integer;
  n bigint;
  floor_n bigint;
BEGIN
  SELECT COALESCE(MAX(NULLIF(substring(work_order_number from ('^KLEO-ML-' || y::text || '-([0-9]+)$')), '')::bigint), 0) + 1
    INTO floor_n
    FROM work_orders
   WHERE work_order_number LIKE ('KLEO-ML-' || y::text || '-%');

  INSERT INTO work_order_number_sequences(year, last_value, updated_at)
  VALUES(y, floor_n, now())
  ON CONFLICT(year) DO UPDATE
     SET last_value = GREATEST(work_order_number_sequences.last_value + 1, EXCLUDED.last_value),
         updated_at = now()
  RETURNING last_value INTO n;

  RETURN 'KLEO-ML-' || y::text || '-' || LPAD(n::text, 6, '0');
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS work_orders_official_number_uq
  ON work_orders(work_order_number)
  WHERE work_order_number IS NOT NULL;

CREATE TABLE IF NOT EXISTS kiosk_daily_queue_sequences(
  location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  queue_date date NOT NULL,
  last_value integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(location_id, queue_date)
);

-- Self-healing daily queue allocator. EXCLUDED.last_value is derived from
-- persisted work orders, so a stale sequence row cannot allocate a duplicate.
CREATE OR REPLACE FUNCTION next_kiosk_daily_queue(p_location uuid, p_day date)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  n integer;
  floor_n integer;
BEGIN
  SELECT COALESCE(MAX(kiosk_queue_no), 0) + 1
    INTO floor_n
    FROM work_orders
   WHERE location_id = p_location
     AND kiosk_queue_date = p_day
     AND kiosk_queue_no IS NOT NULL;

  INSERT INTO kiosk_daily_queue_sequences(location_id, queue_date, last_value, updated_at)
  VALUES(p_location, p_day, floor_n, now())
  ON CONFLICT(location_id, queue_date) DO UPDATE
     SET last_value = GREATEST(kiosk_daily_queue_sequences.last_value + 1, EXCLUDED.last_value),
         updated_at = now()
  RETURNING last_value INTO n;

  RETURN n;
END $$;

CREATE OR REPLACE FUNCTION assign_kiosk_daily_queue()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  d date;
  n integer;
BEGIN
  IF NEW.kiosk_queue_no IS NULL
     AND NEW.location_id IS NOT NULL
     AND COALESCE(NEW.source_snapshot->>'source', '') = 'kiosk' THEN
    d := timezone('Europe/Budapest', COALESCE(NEW.source_created_at, NEW.created_at, now()))::date;
    n := next_kiosk_daily_queue(NEW.location_id, d);
    NEW.kiosk_queue_date := d;
    NEW.kiosk_queue_no := n;
    NEW.kiosk_queue_code := 'KIOSK' || CASE WHEN n < 1000 THEN lpad(n::text, 3, '0') ELSE n::text END;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_assign_kiosk_daily_queue ON work_orders;
CREATE TRIGGER trg_assign_kiosk_daily_queue
BEFORE INSERT ON work_orders
FOR EACH ROW
EXECUTE FUNCTION assign_kiosk_daily_queue();

CREATE UNIQUE INDEX IF NOT EXISTS work_orders_kiosk_queue_uq
  ON work_orders(location_id, kiosk_queue_date, kiosk_queue_no)
  WHERE kiosk_queue_no IS NOT NULL;
CREATE INDEX IF NOT EXISTS work_orders_kiosk_queue_active_idx
  ON work_orders(location_id, kiosk_queue_date, status, kiosk_queue_no)
  WHERE kiosk_queue_no IS NOT NULL;
