import { pool } from "../db";

let schemaPromise: Promise<void> | null = null;

export function kioskQueueCode(value: number) {
  const n = Math.max(1, Math.trunc(Number(value) || 1));
  return `KIOSK${n < 1000 ? String(n).padStart(3, "0") : String(n)}`;
}

export async function ensureKioskQueueSchema() {
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS kiosk_daily_queue_sequences(
        location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        queue_date date NOT NULL,
        last_value integer NOT NULL DEFAULT 0,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(location_id, queue_date)
      );

      ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS kiosk_queue_no integer;
      ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS kiosk_queue_date date;
      ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS kiosk_queue_code text;

      CREATE UNIQUE INDEX IF NOT EXISTS work_orders_kiosk_queue_uq
        ON work_orders(location_id, kiosk_queue_date, kiosk_queue_no)
        WHERE kiosk_queue_no IS NOT NULL;
      CREATE INDEX IF NOT EXISTS work_orders_kiosk_queue_active_idx
        ON work_orders(location_id, kiosk_queue_date, status, kiosk_queue_no)
        WHERE kiosk_queue_no IS NOT NULL;

      CREATE OR REPLACE FUNCTION next_kiosk_daily_queue(p_location uuid, p_day date)
      RETURNS integer LANGUAGE plpgsql AS $$
      DECLARE n integer;
      BEGIN
        INSERT INTO kiosk_daily_queue_sequences(location_id, queue_date, last_value, updated_at)
        VALUES(p_location, p_day, 1, now())
        ON CONFLICT(location_id, queue_date) DO UPDATE
          SET last_value = kiosk_daily_queue_sequences.last_value + 1,
              updated_at = now()
        RETURNING last_value INTO n;
        RETURN n;
      END $$;

      CREATE OR REPLACE FUNCTION assign_kiosk_daily_queue()
      RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE d date; n integer;
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
        FOR EACH ROW EXECUTE FUNCTION assign_kiosk_daily_queue();
    `);

    await pool.query(`
      DO $$
      DECLARE r record; n integer; d date := timezone('Europe/Budapest', now())::date;
      BEGIN
        FOR r IN
          SELECT id, location_id
          FROM work_orders
          WHERE kiosk_queue_no IS NULL
            AND location_id IS NOT NULL
            AND COALESCE(source_snapshot->>'source', '') = 'kiosk'
            AND timezone('Europe/Budapest', COALESCE(source_created_at, created_at, now()))::date = d
            AND status IN ('waiting','arrived','in_progress')
          ORDER BY COALESCE(source_created_at, created_at), id
        LOOP
          n := next_kiosk_daily_queue(r.location_id, d);
          UPDATE work_orders
             SET kiosk_queue_date = d,
                 kiosk_queue_no = n,
                 kiosk_queue_code = 'KIOSK' || CASE WHEN n < 1000 THEN lpad(n::text, 3, '0') ELSE n::text END
           WHERE id = r.id;
        END LOOP;
      END $$;
    `);
  })().catch((error) => {
    schemaPromise = null;
    throw error;
  });
  return schemaPromise;
}

export async function getKioskQueueWorkOrder(workOrderId: string) {
  await ensureKioskQueueSchema();
  const { rows } = await pool.query(`
    SELECT id::text work_order_id, work_order_number, kiosk_queue_no, kiosk_queue_code,
           kiosk_queue_date, status, employee_id::text employee_id
    FROM work_orders
    WHERE id=$1::uuid AND COALESCE(source_snapshot->>'source','')='kiosk'
    LIMIT 1
  `, [workOrderId]);
  return rows[0] || null;
}
