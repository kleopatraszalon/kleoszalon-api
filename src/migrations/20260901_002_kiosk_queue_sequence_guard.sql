-- Production hotfix for the daily KIOSK queue.
--
-- The sequence table can exist before the versioned migration/runtime bootstrap
-- has backfilled all active kiosk work orders. In that state last_value may lag
-- behind an already persisted kiosk_queue_no. The next kiosk insert would then
-- receive a duplicate queue number and fail the whole work-order transaction.
--
-- Keep the existing atomic per-location/per-day upsert allocator, but guard any
-- sequence INSERT/UPDATE so the value returned by next_kiosk_daily_queue() can
-- never be lower than the next number already implied by work_orders.

ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS kiosk_queue_no integer;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS kiosk_queue_date date;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS kiosk_queue_code text;

CREATE TABLE IF NOT EXISTS kiosk_daily_queue_sequences (
  location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  queue_date date NOT NULL,
  last_value integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (location_id, queue_date)
);

CREATE OR REPLACE FUNCTION guard_kiosk_daily_queue_sequence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  next_from_work_orders integer;
BEGIN
  SELECT COALESCE(MAX(w.kiosk_queue_no), 0) + 1
    INTO next_from_work_orders
    FROM work_orders w
   WHERE w.location_id = NEW.location_id
     AND w.kiosk_queue_date = NEW.queue_date
     AND w.kiosk_queue_no IS NOT NULL;

  NEW.last_value := GREATEST(COALESCE(NEW.last_value, 0), next_from_work_orders);
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_guard_kiosk_daily_queue_sequence ON kiosk_daily_queue_sequences;
CREATE TRIGGER trg_guard_kiosk_daily_queue_sequence
BEFORE INSERT OR UPDATE OF last_value ON kiosk_daily_queue_sequences
FOR EACH ROW
EXECUTE FUNCTION guard_kiosk_daily_queue_sequence();

-- Recreate the allocator explicitly so this migration is self-contained even
-- on databases where an earlier runtime bootstrap created the table first.
CREATE OR REPLACE FUNCTION next_kiosk_daily_queue(p_location uuid, p_day date)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  n integer;
BEGIN
  INSERT INTO kiosk_daily_queue_sequences(location_id, queue_date, last_value, updated_at)
  VALUES(p_location, p_day, 1, now())
  ON CONFLICT(location_id, queue_date) DO UPDATE
     SET last_value = kiosk_daily_queue_sequences.last_value + 1,
         updated_at = now()
  RETURNING last_value INTO n;
  RETURN n;
END $$;

-- Preserve/repair active kiosk guests that were created without a queue number.
DO $$
DECLARE
  r record;
  n integer;
  d date := timezone('Europe/Budapest', now())::date;
BEGIN
  FOR r IN
    SELECT id, location_id
      FROM work_orders
     WHERE kiosk_queue_no IS NULL
       AND location_id IS NOT NULL
       AND COALESCE(source_snapshot->>'source', '') = 'kiosk'
       AND timezone('Europe/Budapest', COALESCE(source_created_at, created_at, now()))::date = d
       AND status IN ('waiting', 'arrived', 'in_progress')
     ORDER BY COALESCE(source_created_at, created_at), id
  LOOP
    n := next_kiosk_daily_queue(r.location_id, d);
    UPDATE work_orders
       SET kiosk_queue_date = d,
           kiosk_queue_no = n,
           kiosk_queue_code = 'KIOSK' || CASE
             WHEN n < 1000 THEN lpad(n::text, 3, '0')
             ELSE n::text
           END
     WHERE id = r.id;
  END LOOP;
END $$;
