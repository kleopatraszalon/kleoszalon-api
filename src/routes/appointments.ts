// backend/src/routes/appointments.ts
import express from "express";
import pool from "../db";
import { requireAuth, AuthRequest } from "../middleware/auth";

const router = express.Router();

async function tableHasColumn(table: string, column: string): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1 AND column_name=$2
     LIMIT 1`,
    [table, column]
  );
  return (r.rowCount ?? 0) > 0;
}


/**
 * POST /api/appointments
 * Minimál létrehozás üres rács kattintásból.
 * Elvárt mezők: employee_id, start_time, end_time
 * Opcionális: title, client_id, client_name, location_id
 */
router.post("/", requireAuth, async (req: AuthRequest, res) => {
  const { employee_id, start_time, end_time, title, client_id, client_name, location_id, notes, note, services = [] } = req.body || {};
  if (!employee_id || !start_time || !end_time) {
    return res.status(400).json({ error: "employee_id, start_time, end_time kötelező" });
  }

  const db = await pool.connect();
  try {
    await db.query("BEGIN");

    await db.query(`
      CREATE TABLE IF NOT EXISTS appointment_services (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        appointment_id uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
        service_id uuid NOT NULL REFERENCES services(id),
        duration_minutes integer NOT NULL DEFAULT 30,
        price numeric(12,2) NOT NULL DEFAULT 0,
        discount_percent numeric(5,2) NOT NULL DEFAULT 0,
        sort_order integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS appointment_services_appointment_idx ON appointment_services(appointment_id)`);

    const requestedIds = Array.isArray(services)
      ? services.map((item: any) => String(item?.service_id || item?.id || "")).filter(Boolean)
      : [];
    const serviceRows = requestedIds.length
      ? (await db.query(
          `SELECT id::text, name, COALESCE(duration_minutes, 30)::int AS duration_minutes,
                  COALESCE(promo_price, list_price, base_price, 0)::numeric AS price
           FROM services WHERE id = ANY($1::uuid[]) AND is_active = true`,
          [requestedIds]
        )).rows
      : [];
    if (requestedIds.length && serviceRows.length !== new Set(requestedIds).size) {
      await db.query("ROLLBACK");
      return res.status(400).json({ error: "Egy vagy több kiválasztott szolgáltatás nem található vagy inaktív." });
    }

    const generatedTitle = serviceRows.length
      ? serviceRows.map((service: any) => service.name).join(", ")
      : (client_name ? `Foglalás - ${client_name}` : "Foglalás");
    const r = await db.query(
      `INSERT INTO appointments (employee_id, client_id, location_id, title, start_time, end_time, status, notes)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text, $5::timestamptz, $6::timestamptz, 'confirmed', COALESCE($7::text,''))
       RETURNING id`,
      [employee_id, client_id || null, location_id || null, title || generatedTitle, start_time, end_time, notes ?? note ?? ""]
    );
    const appointmentId = r.rows[0].id;

    for (let index = 0; index < serviceRows.length; index += 1) {
      const service = serviceRows[index];
      await db.query(
        `INSERT INTO appointment_services
           (appointment_id, service_id, duration_minutes, price, discount_percent, sort_order)
         VALUES ($1::uuid, $2::uuid, $3::int, $4::numeric, 0, $5::int)`,
        [appointmentId, service.id, service.duration_minutes, service.price, index]
      );
    }

    await db.query("COMMIT");
    return res.status(201).json({ id: appointmentId, services_count: serviceRows.length });
  } catch (err: any) {
    await db.query("ROLLBACK").catch(() => undefined);
    console.error("[POST /api/appointments] error:", err);
    return res.status(500).json({ error: "Nem sikerült létrehozni", detail: err?.message || String(err), code: err?.code || null });
  } finally {
    db.release();
  }
});

/**
 * GET /api/appointments/:id/detail
 * Drawer adatok. (ha már nálatok létezik más endpoint, ezt a front felől át lehet állítani)
 */
router.get("/:id/detail", requireAuth, async (req: AuthRequest, res) => {
  const { id } = req.params;
  try {
    const ap = await pool.query(
      `SELECT a.*, 
              COALESCE(c.full_name, c.name, '') AS client_name
       FROM appointments a
       LEFT JOIN clients c ON c.id = a.client_id
       WHERE a.id = $1`,
      [id]
    );
    if (ap.rowCount === 0) return res.status(404).json({ error: "Nincs ilyen időpont" });

    // services/product list safe (ha nincs tábla, üres)
    const hasServices = (await pool.query(`SELECT to_regclass('public.appointment_services') IS NOT NULL AS ok`)).rows[0].ok;
    const services = hasServices
      ? (await pool.query(
          `SELECT aps.id, aps.service_id, COALESCE(s.name,'') AS name, COALESCE(aps.duration_minutes, aps.duration) AS duration_minutes, aps.price, aps.sort_order
           FROM appointment_services aps
           LEFT JOIN services s ON s.id = aps.service_id
           WHERE aps.appointment_id = $1
           ORDER BY aps.sort_order, aps.created_at`,
          [id]
        )).rows
      : [];

    // employee/client info (safe)
    const appointment = ap.rows[0];
    const employee = appointment.employee_id
      ? (async () => {
          const hasFull = await tableHasColumn("employees", "full_name");
          const hasName = await tableHasColumn("employees", "name");
          const hasRole = await tableHasColumn("employees", "role");
          const hasPhoto = await tableHasColumn("employees", "photo_url");

          const sel = [
            "id",
            hasFull ? "full_name" : (hasName ? "name AS full_name" : "NULL AS full_name"),
            hasRole ? "role" : "NULL AS role",
            hasPhoto ? "photo_url" : "NULL AS photo_url",
          ].join(", ");

          return (await pool.query(
            `SELECT ${sel} FROM employees WHERE id = $1 LIMIT 1`,
            [appointment.employee_id]
          )).rows[0] || null;
        })()
      : null;

    const client = appointment.client_id
      ? (await pool.query(
          `SELECT id, full_name, name, phone, email
           FROM clients
           WHERE id = $1`,
          [appointment.client_id]
        )).rows[0] || null
      : null;

    // notes (safe)
    const hasNotes = (await pool.query(`SELECT to_regclass('public.appointment_notes') IS NOT NULL AS ok`)).rows[0].ok;
    const notes = hasNotes
      ? (await pool.query(
          `SELECT id, note_type, note_text, created_at
           FROM appointment_notes
           WHERE appointment_id = $1
           ORDER BY created_at DESC
           LIMIT 20`,
          [id]
        )).rows
      : [];

    return res.json({ appointment, employee: await employee, client, services, products: [], client_summary: null, notes });
  } catch (err: any) {
    console.error("[GET /api/appointments/:id/detail] error:", err);
    return res.status(500).json({ error: "Nem sikerült betölteni", detail: err?.message || String(err), code: err?.code || null });
  }
});

/**
 * PATCH /api/appointments/:id
 * Move/resize + drawer mezők mentése (status/notes/payment + start/end).
 */
router.patch("/:id", requireAuth, async (req: AuthRequest, res) => {
  const { id } = req.params;
  const {
    start_time,
    end_time,
    employee_id,
    location_id,
    title,
    status,
    notes,
    payment_status,
    paid_total,
    discount_percent,
  } = req.body || {};

  try {
    const fields: string[] = [];
    const params: any[] = [];
    let i = 1;

    const add = (field: string, value: any, cast?: string) => {
      if (value === undefined) return;
      params.push(value);
      fields.push(`${field} = $${i}${cast ? `::${cast}` : ""}`);
      i += 1;
    };

    add("start_time", start_time, "timestamptz");
    add("end_time", end_time, "timestamptz");
    add("employee_id", employee_id, "uuid");
    add("location_id", location_id, "uuid");
    add("title", title, "text");
    add("status", status, "text");
    add("notes", notes, "text");

    // opcionális mezők (ha léteznek a táblában)
    const cols = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='appointments'`
    );
    const colset = new Set(cols.rows.map((x: any) => x.column_name));
    if (colset.has("payment_status")) add("payment_status", payment_status, "text");
    if (colset.has("paid_total")) add("paid_total", paid_total, "numeric");
    if (colset.has("discount_percent")) add("discount_percent", discount_percent, "numeric");
    if (colset.has("updated_at")) add("updated_at", new Date().toISOString(), "timestamptz");

    if (!fields.length) return res.json({ ok: true });

    params.push(id);
    const q = `UPDATE appointments SET ${fields.join(", ")} WHERE id = $${i}::uuid RETURNING id`;
    const r = await pool.query(q, params);
    return res.json({ ok: true, id: r.rows[0]?.id });
  } catch (err: any) {
    console.error("[PATCH /api/appointments/:id] error:", err);
    return res.status(500).json({ error: "Nem sikerült menteni", detail: err?.message || String(err), code: err?.code || null });
  }
});

export default router;
