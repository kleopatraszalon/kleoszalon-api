import express from "express";
import pool from "../db";

/**
 * Robust appointment detail endpoint.
 * Fixes schema differences (e.g. duration_min missing) and TS strict rowCount nullability.
 *
 * Mount:
 *   import appointmentDetail from "./routes/appointments_detail";
 *   app.use("/api", appointmentDetail);
 */
const router = express.Router();

async function tableHasColumn(table: string, column: string): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1 AND column_name=$2
     LIMIT 1`,
    [table, column]
  );
  return (r.rowCount ?? 0) > 0; // TS18047 fix: rowCount can be null in typings
}

router.get("/appointments/:id/detail", async (req, res) => {
  const id = req.params.id;
  try {
    const ap = await pool.query(
      `SELECT
         a.id::text, a.employee_id::text, a.client_id::text AS client_id, a.location_id::text,
         a.start_time, a.end_time, a.status, a.payment_status, a.notes, a.source_channel,
         a.created_at
       FROM appointments a
       WHERE a.id = $1::uuid`,
      [id]
    );
    if ((ap.rowCount ?? 0) === 0) return res.status(404).json({ error: "not found" });
    const appointment = ap.rows[0];

        // employees table schema can differ (short_name may be missing)
    const empHasShort = await tableHasColumn("employees", "short_name");
    const empHasFull = await tableHasColumn("employees", "full_name");
    const empHasName = await tableHasColumn("employees", "name");
    const empHasRole = await tableHasColumn("employees", "role");
    const empHasPhoto = await tableHasColumn("employees", "photo_url");

    const empSelect = [
      "id::text",
      empHasFull ? "full_name" : "NULL AS full_name",
      empHasShort ? "short_name" : (empHasName ? "name AS short_name" : "NULL AS short_name"),
      empHasRole ? "role" : "NULL AS role",
      empHasPhoto ? "photo_url" : "NULL AS photo_url",
    ].join(", ");

    const emp = await pool.query(
      `SELECT ${empSelect}
       FROM employees
       WHERE id = $1::uuid
       LIMIT 1`,
      [appointment.employee_id]
    );

const client = appointment.client_id
      ? await pool.query(
          `SELECT id::text, full_name, name, phone, email
           FROM clients
           WHERE id = $1::uuid
           LIMIT 1`,
          [appointment.client_id]
        )
      : { rows: [] as any[] };

    // appointment_services (handle different schemas safely)
    const hasAps = await pool.query(`SELECT to_regclass('public.appointment_services') IS NOT NULL AS ok`);
    let servicesRows: any[] = [];
    if (hasAps.rows[0]?.ok) {
      const hasDurationMinutes = await tableHasColumn("appointment_services", "duration_minutes");
      const hasDuration = await tableHasColumn("appointment_services", "duration");
      const hasPrice = await tableHasColumn("appointment_services", "price");
      const hasDiscount = await tableHasColumn("appointment_services", "discount_percent");
      const hasSort = await tableHasColumn("appointment_services", "sort_order");

      const durationExpr = hasDurationMinutes
        ? "aps.duration_minutes"
        : hasDuration
          ? "aps.duration"
          : "NULL";

      const priceExpr = hasPrice ? "aps.price" : "NULL";
      const discExpr = hasDiscount ? "aps.discount_percent" : "NULL";
      const sortExpr = hasSort ? "aps.sort_order" : "0";

      const s = await pool.query(
        `SELECT
           aps.id::text,
           aps.service_id::text,
           COALESCE(sv.name,'') AS name,
           ${durationExpr} AS duration_minutes,
           ${priceExpr} AS price,
           ${discExpr} AS discount_percent
         FROM appointment_services aps
         LEFT JOIN services sv ON sv.id = aps.service_id
         WHERE aps.appointment_id = $1::uuid
         ORDER BY ${sortExpr} ASC, aps.created_at ASC`,
        [id]
      );
      servicesRows = s.rows || [];
    }

    // appointment_products (optional)
    const hasApProd = await pool.query(`SELECT to_regclass('public.appointment_products') IS NOT NULL AS ok`);
    let productsRows: any[] = [];
    if (hasApProd.rows[0]?.ok) {
      const hasProducts = await pool.query(`SELECT to_regclass('public.products') IS NOT NULL AS ok`);
      if (hasProducts.rows[0]?.ok) {
        const p = await pool.query(
          `SELECT
             ap.id::text,
             ap.product_id::text,
             COALESCE(pr.name,'') AS name,
             COALESCE(ap.qty, 1)::numeric AS qty,
             ap.price
           FROM appointment_products ap
           LEFT JOIN products pr ON pr.id = ap.product_id
           WHERE ap.appointment_id = $1::uuid
           ORDER BY ap.created_at ASC`,
          [id]
        );
        productsRows = p.rows || [];
      }
    }

    // notes (optional)
    const hasNotes = await pool.query(`SELECT to_regclass('public.appointment_notes') IS NOT NULL AS ok`);
    let notesRows: any[] = [];
    if (hasNotes.rows[0]?.ok) {
      const n = await pool.query(
        `SELECT id, note_type, note_text, created_at
         FROM appointment_notes
         WHERE appointment_id = $1::uuid
         ORDER BY created_at DESC
         LIMIT 50`,
        [id]
      );
      notesRows = n.rows || [];
    }

    // client summary (best-effort)
    let client_summary = null;
    if (appointment.client_id) {
      const cs = await pool.query(
        `SELECT
           MAX(a.start_time) FILTER (WHERE a.status IN ('completed','paid','confirmed')) AS last_visit,
           COUNT(*) FILTER (WHERE a.status IN ('completed','paid','confirmed'))::int AS visits_total,
           COUNT(*) FILTER (WHERE a.status IN ('no_show'))::int AS no_show_count
         FROM appointments a
         WHERE a.client_id = $1::uuid`,
        [appointment.client_id]
      );
      client_summary = { ...cs.rows[0], balance: 0 };
    }

    res.json({
      appointment,
      employee: emp.rows[0] || null,
      client: client.rows[0] || null,
      services: servicesRows,
      products: productsRows,
      client_summary,
      notes: notesRows,
    });
  } catch (e: any) {
    res.status(500).json({
      error: "Nem sikerült betölteni",
      detail: e.message,
      code: e.code,
    });
  }
});

export default router;
