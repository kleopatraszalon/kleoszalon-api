import { Router, Response } from "express";
import pool from "../db";
import { AuthRequest, requireAuth } from "../middleware/auth";

const router = Router();

function isAdmin(req: AuthRequest) {
  const raw = req.user?.role;
  return (Array.isArray(raw) ? raw : [raw])
    .some((role) => String(role || "").trim().toLowerCase() === "admin");
}

router.get("/subscriptions", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    if (!isAdmin(req)) {
      return res.status(403).json({ ok: false, error: "forbidden" });
    }

    const { rows } = await pool.query(
      `SELECT id, email, frequency, is_enabled, location_id, weekday, send_hour, send_minute, timezone, recipient_name, created_at, updated_at
       FROM vir_report_subscriptions
       ORDER BY is_enabled DESC, frequency, email`
    );

    return res.json({ ok: true, rows });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error?.message || "subscriptions_list_failed" });
  }
});

router.post("/subscriptions", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    if (!isAdmin(req)) {
      return res.status(403).json({ ok: false, error: "forbidden" });
    }

    const {
      email,
      frequency,
      is_enabled = true,
      location_id = null,
      weekday = null,
      send_hour = 7,
      send_minute = 0,
      timezone = "Europe/Budapest",
      recipient_name = null,
    } = req.body || {};

    const { rows } = await pool.query(
      `INSERT INTO vir_report_subscriptions
       (email, frequency, is_enabled, location_id, weekday, send_hour, send_minute, timezone, recipient_name, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        email,
        frequency,
        is_enabled,
        location_id,
        weekday,
        send_hour,
        send_minute,
        timezone,
        recipient_name,
        req.user?.id || null,
      ]
    );

    return res.json({ ok: true, row: rows[0] });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error?.message || "subscription_create_failed" });
  }
});

router.put("/subscriptions/:id", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    if (!isAdmin(req)) {
      return res.status(403).json({ ok: false, error: "forbidden" });
    }

    const { id } = req.params;
    const {
      email,
      frequency,
      is_enabled,
      location_id,
      weekday,
      send_hour,
      send_minute,
      timezone,
      recipient_name,
    } = req.body || {};

    const { rows } = await pool.query(
      `UPDATE vir_report_subscriptions
       SET email = $2,
           frequency = $3,
           is_enabled = $4,
           location_id = $5,
           weekday = $6,
           send_hour = $7,
           send_minute = $8,
           timezone = $9,
           recipient_name = $10
       WHERE id = $1
       RETURNING *`,
      [id, email, frequency, is_enabled, location_id, weekday, send_hour, send_minute, timezone, recipient_name]
    );

    return res.json({ ok: true, row: rows[0] || null });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error?.message || "subscription_update_failed" });
  }
});

router.delete("/subscriptions/:id", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    if (!isAdmin(req)) {
      return res.status(403).json({ ok: false, error: "forbidden" });
    }

    const { id } = req.params;
    await pool.query(`DELETE FROM vir_report_subscriptions WHERE id = $1`, [id]);
    return res.json({ ok: true });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error?.message || "subscription_delete_failed" });
  }
});

router.post("/send-now", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    if (!isAdmin(req)) {
      return res.status(403).json({ ok: false, error: "forbidden" });
    }

    const { sendVirReportEmail } = await import("../services/virReportMailer.js");
    const {
      email,
      frequency = "daily",
      location_id = null,
      recipient_name = null,
    } = req.body || {};

    await sendVirReportEmail({
      email,
      frequency,
      locationId: location_id,
      recipientName: recipient_name,
    });

    return res.json({ ok: true });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error?.message || "send_now_failed" });
  }
});

export default router;
