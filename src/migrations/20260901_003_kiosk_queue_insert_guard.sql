-- Production guard for KIOSK work-order creation.
--
-- The signage runtime bootstrap can recreate the legacy sequence allocator at
-- runtime. Keep kiosk creation independent of that allocator by installing an
-- earlier BEFORE INSERT trigger. PostgreSQL fires triggers of the same kind in
-- name order, so this trigger fills kiosk_queue_no before trg_assign_kiosk_daily_queue.
-- The legacy trigger then sees a non-null kiosk_queue_no and becomes a no-op.

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

CREATE OR REPLACE FUNCTION assign_kiosk_daily_queue_safe()
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

    -- Serialize allocation only for this salon/business day. This makes
    -- MAX()+1 safe even if several kiosk requests arrive at the same instant.
    PERFORM pg_advisory_xact_lock(
      hashtext(NEW.location_id::text),
      (d - DATE '2000-01-01')::integer
    );

    SELECT COALESCE(MAX(w.kiosk_queue_no), 0) + 1
      INTO n
      FROM work_orders w
     WHERE w.location_id = NEW.location_id
       AND w.kiosk_queue_date = d
       AND w.kiosk_queue_no IS NOT NULL;

    NEW.kiosk_queue_date := d;
    NEW.kiosk_queue_no := n;
    NEW.kiosk_queue_code := 'KIOSK' || CASE
      WHEN n < 1000 THEN lpad(n::text, 3, '0')
      ELSE n::text
    END;

    -- Keep the legacy sequence table synchronized for compatibility and
    -- observability, but never use it as the source of truth for allocation.
    INSERT INTO kiosk_daily_queue_sequences(location_id, queue_date, last_value, updated_at)
    VALUES(NEW.location_id, d, n, now())
    ON CONFLICT(location_id, queue_date) DO UPDATE
       SET last_value = GREATEST(kiosk_daily_queue_sequences.last_value, EXCLUDED.last_value),
           updated_at = now();
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_00_kiosk_daily_queue_safe ON work_orders;
CREATE TRIGGER trg_00_kiosk_daily_queue_safe
BEFORE INSERT ON work_orders
FOR EACH ROW
EXECUTE FUNCTION assign_kiosk_daily_queue_safe();
