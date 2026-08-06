import { Router } from "express";
import db from "../db";

const router = Router();

const WORK_ORDER_STATUSES = new Set([
  "waiting",
  "arrived",
  "in_progress",
  "completed",
  "cancelled",
  "no_show",
]);

function normalizeStatus(value: unknown, fallback = "arrived") {
  const status = String(value ?? fallback).trim().toLowerCase();
  return WORK_ORDER_STATUSES.has(status) ? status : null;
}

router.get("/workorders", async (_req, res, next) => {
  try {
    const result = await db.query(
      `SELECT * FROM v_work_orders_list ORDER BY created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

router.get("/workorders/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    const header = await db.query(`SELECT * FROM v_work_order_details WHERE id = $1`, [id]);
    if (!header.rows[0]) return res.status(404).json({ message: "A munkalap nem található" });

    const items = await db.query(
      `SELECT id, item_type, service_id, product_id, item_name, quantity, unit_price, discount_amount, line_total, duration_minutes
       FROM work_order_items WHERE work_order_id = $1 ORDER BY created_at`,
      [id]
    );
    const payments = await db.query(
      `SELECT id, payment_method, amount, paid_at, note
       FROM work_order_payments WHERE work_order_id = $1 ORDER BY paid_at`,
      [id]
    );

    res.json({ ...header.rows[0], items: items.rows, payments: payments.rows });
  } catch (err) {
    next(err);
  }
});

router.patch("/workorders/:id/lifecycle", async (req, res, next) => {
  try {
    const status = normalizeStatus(req.body?.status, "");
    if (!status) return res.status(400).json({ message: "Érvénytelen munkalap státusz" });

    const now = new Date().toISOString();
    const startedAt = status === "in_progress" ? (req.body?.started_at ?? now) : req.body?.started_at;
    const completedAt = status === "completed" ? (req.body?.completed_at ?? now) : req.body?.completed_at;
    const cancelledAt = status === "cancelled" ? now : null;

    const result = await db.query(
      `UPDATE work_orders
       SET status = $2,
           started_at = COALESCE($3::timestamptz, started_at),
           completed_at = COALESCE($4::timestamptz, completed_at),
           cancelled_at = CASE WHEN $2 = 'cancelled' THEN $5::timestamptz ELSE cancelled_at END,
           status_updated_at = now(),
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [req.params.id, status, startedAt ?? null, completedAt ?? null, cancelledAt]
    );

    if (!result.rows[0]) return res.status(404).json({ message: "A munkalap nem található" });
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

router.post("/workorders", async (req, res, next) => {
  const client = await db.connect();
  try {
    const {
      title, notes, employee_id, client_name, client_phone, client_email,
      location_id, appointment_id, fully_paid, note_for_another_visitor,
      services, products, created_by, started_at, completed_at,
    } = req.body;

    const status = normalizeStatus(req.body?.status);
    if (!status) return res.status(400).json({ message: "Érvénytelen munkalap státusz" });

    await client.query("BEGIN");

    const header = await client.query(
      `INSERT INTO work_orders
        (title, notes, status, employee_id, client_name, client_phone, client_email,
         location_id, appointment_id, fully_paid, note_for_another_visitor, created_by,
         started_at, completed_at, cancelled_at, status_updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now())
       RETURNING id`,
      [
        title, notes ?? null, status, employee_id ?? null, client_name ?? null,
        client_phone ?? null, client_email ?? null, location_id ?? null,
        appointment_id ?? null, Boolean(fully_paid), Boolean(note_for_another_visitor),
        created_by ?? null,
        started_at ?? (status === "in_progress" ? new Date().toISOString() : null),
        completed_at ?? (status === "completed" ? new Date().toISOString() : null),
        status === "cancelled" ? new Date().toISOString() : null,
      ]
    );

    const workOrderId = header.rows[0].id;

    if (Array.isArray(services)) {
      for (const item of services) {
        const serviceInfo = await client.query(
          `SELECT s.id, s.name,
                  COALESCE(s.price_gross, s.price, 0) AS price_value,
                  COALESCE(s.duration_minutes, s.default_duration, 0) AS duration_value
           FROM services s WHERE s.id = $1`,
          [item.service_id]
        );
        const svc = serviceInfo.rows[0];
        if (!svc) continue;
        const quantity = Number(item.quantity ?? 1) || 1;
        const unitPrice = Number(svc.price_value ?? 0);
        const discountAmount = Number(item.discount_amount ?? 0) || 0;
        await client.query(
          `INSERT INTO work_order_items
            (work_order_id, item_type, service_id, item_name, quantity, unit_price, discount_amount, line_total, duration_minutes)
           VALUES ($1,'service',$2,$3,$4,$5,$6,$7,$8)`,
          [workOrderId, item.service_id, svc.name, quantity, unitPrice, discountAmount,
           quantity * unitPrice - discountAmount, svc.duration_value || null]
        );
      }
    }

    if (Array.isArray(products)) {
      for (const item of products) {
        const productInfo = await client.query(
          `SELECT p.id, p.name, COALESCE(p.price_gross, p.price, 0) AS price_value
           FROM products p WHERE p.id = $1`,
          [item.product_id]
        );
        const prd = productInfo.rows[0];
        if (!prd) continue;
        const quantity = Number(item.quantity ?? 1) || 1;
        const unitPrice = Number(prd.price_value ?? 0);
        const discountAmount = Number(item.discount_amount ?? 0) || 0;
        await client.query(
          `INSERT INTO work_order_items
            (work_order_id, item_type, product_id, item_name, quantity, unit_price, discount_amount, line_total)
           VALUES ($1,'product',$2,$3,$4,$5,$6,$7)`,
          [workOrderId, item.product_id, prd.name, quantity, unitPrice,
           discountAmount, quantity * unitPrice - discountAmount]
        );
      }
    }

    await client.query(`SELECT recalc_work_order_totals($1)`, [workOrderId]);
    await client.query("COMMIT");
    res.status(201).json({ id: workOrderId });
  } catch (err) {
    await client.query("ROLLBACK");
    next(err);
  } finally {
    client.release();
  }
});

export default router;
