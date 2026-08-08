-- Hivatalos munkalapszám + időpontból automatikusan létrejövő munkalap + lezárt archiválás
-- Formátum: KLEO-ML-YYYY-000001

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS work_order_number_sequences (
  year integer PRIMARY KEY,
  last_value bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION next_official_work_order_number(p_at timestamptz DEFAULT now())
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  y integer := EXTRACT(YEAR FROM p_at)::integer;
  n bigint;
BEGIN
  INSERT INTO work_order_number_sequences(year,last_value)
  VALUES(y,1)
  ON CONFLICT(year) DO UPDATE
    SET last_value=work_order_number_sequences.last_value+1,
        updated_at=now()
  RETURNING last_value INTO n;

  RETURN 'KLEO-ML-' || y::text || '-' || LPAD(n::text,6,'0');
END $$;

ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS work_order_number text;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS source_created_at timestamptz;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS source_snapshot jsonb;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS locked_at timestamptz;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS locked_reason text;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS archive_hash text;

CREATE UNIQUE INDEX IF NOT EXISTS work_orders_official_number_uq
  ON work_orders(work_order_number)
  WHERE work_order_number IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS work_orders_appointment_uq
  ON work_orders(appointment_id)
  WHERE appointment_id IS NOT NULL;

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS work_order_id uuid;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS work_order_number text;

CREATE INDEX IF NOT EXISTS appointments_work_order_idx ON appointments(work_order_id);
CREATE INDEX IF NOT EXISTS appointments_work_order_number_idx ON appointments(work_order_number);

-- Régi munkalapok hivatalos számmal történő egyszeri ellátása.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id, COALESCE(created_at,now()) AS created_at FROM work_orders WHERE work_order_number IS NULL ORDER BY COALESCE(created_at,now()),id
  LOOP
    UPDATE work_orders SET work_order_number=next_official_work_order_number(r.created_at) WHERE id=r.id;
  END LOOP;
END $$;

CREATE TABLE IF NOT EXISTS work_order_archive (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id uuid NOT NULL,
  work_order_number text NOT NULL,
  archived_at timestamptz NOT NULL DEFAULT now(),
  terminal_status text NOT NULL,
  snapshot jsonb NOT NULL,
  snapshot_hash text NOT NULL,
  UNIQUE(work_order_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS work_order_archive_number_uq ON work_order_archive(work_order_number);

CREATE OR REPLACE FUNCTION build_work_order_snapshot(p_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
    'header', to_jsonb(w),
    'items', COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.created_at,i.id) FROM work_order_items i WHERE i.work_order_id=w.id),'[]'::jsonb),
    'payments', COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.paid_at,p.id) FROM work_order_payments p WHERE p.work_order_id=w.id),'[]'::jsonb)
  )
  FROM work_orders w WHERE w.id=p_id
$$;

CREATE OR REPLACE FUNCTION archive_and_lock_work_order()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  snap jsonb;
  h text;
BEGIN
  IF OLD.locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'A(z) % munkalap lezárt és archivált; nem módosítható.', OLD.work_order_number USING ERRCODE='55000';
  END IF;

  IF NEW.status IN ('completed','cancelled','no_show') AND OLD.status IS DISTINCT FROM NEW.status THEN
    NEW.locked_at := COALESCE(NEW.locked_at,now());
    NEW.locked_reason := COALESCE(NEW.locked_reason,'TERMINAL_STATUS:'||upper(NEW.status));
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_work_orders_lock_before_update ON work_orders;
CREATE TRIGGER trg_work_orders_lock_before_update
BEFORE UPDATE ON work_orders
FOR EACH ROW EXECUTE FUNCTION archive_and_lock_work_order();

CREATE OR REPLACE FUNCTION archive_work_order_after_lock()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE snap jsonb; h text;
BEGIN
  IF NEW.locked_at IS NOT NULL AND OLD.locked_at IS NULL THEN
    snap := build_work_order_snapshot(NEW.id);
    h := encode(digest(convert_to(snap::text,'UTF8'),'sha256'),'hex');
    INSERT INTO work_order_archive(work_order_id,work_order_number,terminal_status,snapshot,snapshot_hash)
    VALUES(NEW.id,NEW.work_order_number,NEW.status,snap,h)
    ON CONFLICT(work_order_id) DO NOTHING;

    -- technikai mezők beállítása trigger-rekurzió nélkül
    ALTER TABLE work_orders DISABLE TRIGGER trg_work_orders_lock_before_update;
    UPDATE work_orders SET archived_at=now(),archive_hash=h WHERE id=NEW.id;
    ALTER TABLE work_orders ENABLE TRIGGER trg_work_orders_lock_before_update;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_work_orders_archive_after_update ON work_orders;
CREATE TRIGGER trg_work_orders_archive_after_update
AFTER UPDATE ON work_orders
FOR EACH ROW EXECUTE FUNCTION archive_work_order_after_lock();

CREATE OR REPLACE FUNCTION prevent_locked_work_order_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.locked_at IS NOT NULL OR OLD.status IN ('completed','cancelled','no_show') THEN
    RAISE EXCEPTION 'A(z) % munkalap lezárt/archivált; nem törölhető.', OLD.work_order_number USING ERRCODE='55000';
  END IF;
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS trg_work_orders_no_delete_locked ON work_orders;
CREATE TRIGGER trg_work_orders_no_delete_locked BEFORE DELETE ON work_orders
FOR EACH ROW EXECUTE FUNCTION prevent_locked_work_order_delete();

CREATE OR REPLACE FUNCTION prevent_locked_appointment_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE l timestamptz; n text;
BEGIN
  IF OLD.work_order_id IS NOT NULL THEN
    SELECT locked_at,work_order_number INTO l,n FROM work_orders WHERE id=OLD.work_order_id;
    IF l IS NOT NULL THEN
      RAISE EXCEPTION 'Az időponthoz tartozó % munkalap lezárt/archivált; az időpont sem módosítható vagy törölhető.',n USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
DROP TRIGGER IF EXISTS trg_appointments_no_change_after_workorder_lock ON appointments;
CREATE TRIGGER trg_appointments_no_change_after_workorder_lock
BEFORE UPDATE OR DELETE ON appointments
FOR EACH ROW EXECUTE FUNCTION prevent_locked_appointment_change();

-- A lezárás előtt a fizetések/tételek se módosíthassák a már archivált munkalapot.
CREATE OR REPLACE FUNCTION prevent_child_change_of_locked_work_order()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE wid uuid; l timestamptz; n text;
BEGIN
  wid := COALESCE(NEW.work_order_id,OLD.work_order_id);
  SELECT locked_at,work_order_number INTO l,n FROM work_orders WHERE id=wid;
  IF l IS NOT NULL THEN
    RAISE EXCEPTION 'A(z) % munkalap lezárt/archivált; kapcsolódó tételei sem módosíthatók.',n USING ERRCODE='55000';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
DROP TRIGGER IF EXISTS trg_work_order_items_immutable ON work_order_items;
CREATE TRIGGER trg_work_order_items_immutable BEFORE INSERT OR UPDATE OR DELETE ON work_order_items FOR EACH ROW EXECUTE FUNCTION prevent_child_change_of_locked_work_order();
DROP TRIGGER IF EXISTS trg_work_order_payments_immutable ON work_order_payments;
CREATE TRIGGER trg_work_order_payments_immutable BEFORE INSERT OR UPDATE OR DELETE ON work_order_payments FOR EACH ROW EXECUTE FUNCTION prevent_child_change_of_locked_work_order();

-- Már terminális státuszú korábbi munkalapok archiválása és zárolása.
UPDATE work_orders
SET locked_at=COALESCE(locked_at,COALESCE(completed_at,cancelled_at,updated_at,now())),
    locked_reason=COALESCE(locked_reason,'MIGRATION_TERMINAL_STATUS')
WHERE status IN ('completed','cancelled','no_show') AND locked_at IS NULL;
