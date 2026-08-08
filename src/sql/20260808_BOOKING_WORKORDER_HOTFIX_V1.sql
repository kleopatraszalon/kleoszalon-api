-- Booking / munkalap hotfix
-- Javítja az időpontból automatikusan létrejövő munkalap hiányzó mezőit
-- és biztosítja a munkalap lista menüpontját.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS client_id uuid;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS client_name text;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS client_phone text;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS client_email text;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS location_id uuid;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS appointment_id uuid;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS created_by text;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS status_updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS fully_paid boolean NOT NULL DEFAULT false;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS note_for_another_visitor boolean NOT NULL DEFAULT false;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS work_order_number text;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS source_created_at timestamptz;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS source_snapshot jsonb;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS locked_at timestamptz;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS locked_reason text;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS archive_hash text;

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS work_order_id uuid;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS work_order_number text;

CREATE UNIQUE INDEX IF NOT EXISTS work_orders_appointment_uq
  ON work_orders(appointment_id) WHERE appointment_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS work_orders_official_number_uq
  ON work_orders(work_order_number) WHERE work_order_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS work_orders_location_status_idx ON work_orders(location_id,status,created_at DESC);
CREATE INDEX IF NOT EXISTS appointments_work_order_idx ON appointments(work_order_id);

-- A hivatalos számozó függvény akkor is legyen meg, ha a korábbi migráció kimaradt.
CREATE TABLE IF NOT EXISTS work_order_number_sequences (
  year integer PRIMARY KEY,
  last_value bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION next_official_work_order_number(p_at timestamptz DEFAULT now())
RETURNS text LANGUAGE plpgsql AS $$
DECLARE y integer:=EXTRACT(YEAR FROM p_at)::integer; n bigint;
BEGIN
  INSERT INTO work_order_number_sequences(year,last_value) VALUES(y,1)
  ON CONFLICT(year) DO UPDATE SET last_value=work_order_number_sequences.last_value+1,updated_at=now()
  RETURNING last_value INTO n;
  RETURN 'KLEO-ML-'||y::text||'-'||LPAD(n::text,6,'0');
END $$;

-- Menü: Időpontok és jelenlét alatt legyen külön Munkalapok.
DO $$
DECLARE parent_id bigint;
BEGIN
  IF to_regclass('public.menus') IS NULL THEN RETURN; END IF;
  SELECT id INTO parent_id FROM menus
   WHERE parent_id IS NULL AND (lower(name) LIKE 'időpont%' OR route IN ('/appointments/calendar','/modules/appointments'))
   ORDER BY id LIMIT 1;
  IF parent_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM menus WHERE route IN ('/workorders','/workorders/list')) THEN
      INSERT INTO menus(name,route,icon,parent_id,order_index,required_role)
      VALUES('Munkalapok','/workorders','ClipboardCheck',parent_id,25,'all');
    ELSE
      UPDATE menus SET name='Munkalapok',route='/workorders',parent_id=parent_id,order_index=25
       WHERE route IN ('/workorders','/workorders/list');
    END IF;
  END IF;
END $$;
