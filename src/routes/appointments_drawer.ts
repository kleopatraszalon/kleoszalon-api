// backend/src/routes/appointments_drawer.ts
import express from "express";
import pool from "../db";

const router = express.Router();

// GET /api/services?query=
router.get("/services", async (req, res) => {
  const q = String(req.query.query || "").trim();
  if (!q) return res.json([]);
  const r = await pool.query(
    `SELECT id::text, name, duration_minutes, price
     FROM services
     WHERE lower(name) LIKE lower($1)
     ORDER BY name
     LIMIT 20`,
    [`%${q}%`]
  );
  res.json(r.rows);
});

// GET /api/products?query=
router.get("/products", async (req, res) => {
  const q = String(req.query.query || "").trim();
  if (!q) return res.json([]);
  // products table may be absent
  const exists = await pool.query(`SELECT to_regclass('public.products') IS NOT NULL AS ok`);
  if (!exists.rows[0]?.ok) return res.json([]);
  const r = await pool.query(
    `SELECT id::text, name, price
     FROM products
     WHERE lower(name) LIKE lower($1)
     ORDER BY name
     LIMIT 20`,
    [`%${q}%`]
  );
  res.json(r.rows);
});

// GET /api/appointments/:id/detail
router.get("/appointments/:id/detail", async (req, res) => {
  const id = req.params.id;
  try {
    const ap = await pool.query(
      `SELECT id::text, employee_id::text, client_id::text AS client_id, location_id::text,
              start_time, end_time, status, payment_status, notes, source_channel, created_at
       FROM appointments
       WHERE id = $1::uuid`,
      [id]
    );
    if (ap.rowCount === 0) return res.status(404).json({ error: "not found" });

    const appointment = ap.rows[0];

    const emp = await pool.query(
      `SELECT id::text, full_name, short_name, role, photo_url
       FROM employees WHERE id = $1::uuid`,
      [appointment.employee_id]
    );

    const client = appointment.client_id
      ? await pool.query(`SELECT id::text, full_name, name, phone, email FROM clients WHERE id = $1::uuid`, [appointment.client_id])
      : { rows: [] as any[] };

    const hasServices = await pool.query(`SELECT to_regclass('public.appointment_services') IS NOT NULL AS ok`);
    const services = hasServices.rows[0]?.ok
      ? await pool.query(
          `SELECT aps.id::text, aps.service_id::text, COALESCE(s.name,'') AS name,
                  aps.duration_minutes, aps.price, aps.discount_percent
           FROM appointment_services aps
           LEFT JOIN services s ON s.id = aps.service_id
           WHERE aps.appointment_id = $1::uuid
           ORDER BY aps.sort_order ASC, aps.created_at ASC`,
          [id]
        )
      : { rows: [] as any[] };

    const hasProducts = await pool.query(`SELECT to_regclass('public.appointment_products') IS NOT NULL AS ok`);
    const products = hasProducts.rows[0]?.ok
      ? await pool.query(
          `SELECT ap.id::text, ap.product_id::text, COALESCE(p.name,'') AS name, ap.qty::numeric AS qty, ap.price
           FROM appointment_products ap
           LEFT JOIN products p ON p.id = ap.product_id
           WHERE ap.appointment_id = $1::uuid
           ORDER BY ap.created_at ASC`,
          [id]
        )
      : { rows: [] as any[] };

    // client summary
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

    const hasNotes = await pool.query(`SELECT to_regclass('public.appointment_notes') IS NOT NULL AS ok`);
    const notes = hasNotes.rows[0]?.ok
      ? await pool.query(
          `SELECT id, note_type, note_text, created_at
           FROM appointment_notes
           WHERE appointment_id = $1::uuid
           ORDER BY created_at DESC
           LIMIT 20`,
          [id]
        )
      : { rows: [] as any[] };

    res.json({
      appointment,
      employee: emp.rows[0] || null,
      client: client.rows[0] || null,
      services: services.rows || [],
      products: products.rows || [],
      client_summary,
      notes: notes.rows || [],
    });
  } catch (e: any) {
    res.status(500).json({ error: "server", detail: e.message, code: e.code });
  }
});

// PATCH /api/appointments/:id (base)
router.patch("/appointments/:id", async (req, res) => {
  const id = req.params.id;
  const { status, payment_status, notes, start_time, end_time } = req.body || {};
  try {
    const r = await pool.query(
      `UPDATE appointments
       SET status = COALESCE($2, status),
           payment_status = COALESCE($3, payment_status),
           notes = COALESCE($4, notes),
           start_time = COALESCE($5, start_time),
           end_time = COALESCE($6, end_time),
           updated_at = now()
       WHERE id = $1::uuid
       RETURNING id::text`,
      [id, status ?? null, payment_status ?? null, notes ?? null, start_time ?? null, end_time ?? null]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: "not found" });
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: "server", detail: e.message, code: e.code });
  }
});

// POST /api/appointments/:id/services
router.post("/appointments/:id/services", async (req, res) => {
  const id = req.params.id;
  const { service_id } = req.body || {};
  if (!service_id) return res.status(400).json({ error: "service_id required" });
  try {
    await pool.query(
      `INSERT INTO appointment_services (appointment_id, service_id, sort_order)
       VALUES ($1::uuid, $2::uuid, 0)`,
      [id, service_id]
    );
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: "server", detail: e.message, code: e.code });
  }
});

// DELETE /api/appointments/:id/services/:rowId
router.delete("/appointments/:id/services/:rowId", async (req, res) => {
  const rowId = req.params.rowId;
  try {
    await pool.query(`DELETE FROM appointment_services WHERE id = $1::uuid`, [rowId]);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: "server", detail: e.message, code: e.code });
  }
});

// POST /api/appointments/:id/products
router.post("/appointments/:id/products", async (req, res) => {
  const id = req.params.id;
  const { product_id, qty } = req.body || {};
  if (!product_id) return res.status(400).json({ error: "product_id required" });
  try {
    await pool.query(
      `INSERT INTO appointment_products (appointment_id, product_id, qty)
       VALUES ($1::uuid, $2::uuid, $3::numeric)`,
      [id, product_id, qty ?? 1]
    );
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: "server", detail: e.message, code: e.code });
  }
});

// DELETE /api/appointments/:id/products/:rowId
router.delete("/appointments/:id/products/:rowId", async (req, res) => {
  const rowId = req.params.rowId;
  try {
    await pool.query(`DELETE FROM appointment_products WHERE id = $1::uuid`, [rowId]);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: "server", detail: e.message, code: e.code });
  }
});

// POST /api/appointments/:id/notes
router.post("/appointments/:id/notes", async (req, res) => {
  const id = req.params.id;
  const { note_type, note_text } = req.body || {};
  if (!note_text) return res.status(400).json({ error: "note_text required" });
  try {
    await pool.query(
      `INSERT INTO appointment_notes (appointment_id, note_type, note_text)
       VALUES ($1::uuid, COALESCE($2,'internal'), $3)`,
      [id, note_type ?? "internal", note_text]
    );
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: "server", detail: e.message, code: e.code });
  }
});

export default router;
