import { Router, Response } from "express";
import pool from "../db";
import { requireAuth, AuthRequest } from "../middleware/requireAuth";

const router = Router();

function isAdmin(req: AuthRequest) {
  const role = String(req.user?.role || "").toLowerCase();
  return ["admin", "superadmin", "global_admin", "owner", "manager", "tulajdonos"].includes(role);
}

async function ensureReportTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vir_report_subscriptions (
      id bigserial PRIMARY KEY,
      email text NOT NULL,
      recipient_name text,
      frequency text NOT NULL DEFAULT 'daily',
      location_id text,
      enabled boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

router.get("/subscriptions", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ ok: false, error: "forbidden" });
    await ensureReportTables();
    const { rows } = await pool.query(`
      SELECT id, email, recipient_name, frequency, location_id, enabled, created_at, updated_at
      FROM vir_report_subscriptions
      ORDER BY created_at DESC
    `);
    return res.json({ ok: true, subscriptions: rows });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error?.message || "subscription_list_failed" });
  }
});

router.post("/subscriptions", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ ok: false, error: "forbidden" });
    await ensureReportTables();
    const { email, recipient_name = null, frequency = "daily", location_id = null, enabled = true } = req.body || {};
    if (!email) return res.status(400).json({ ok: false, error: "email_required" });
    const { rows } = await pool.query(
      `INSERT INTO vir_report_subscriptions(email, recipient_name, frequency, location_id, enabled)
       VALUES($1,$2,$3,$4,$5)
       RETURNING *`,
      [email, recipient_name, frequency, location_id, Boolean(enabled)]
    );
    return res.status(201).json({ ok: true, subscription: rows[0] });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error?.message || "subscription_create_failed" });
  }
});

router.patch("/subscriptions/:id", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ ok: false, error: "forbidden" });
    await ensureReportTables();
    const { id } = req.params;
    const { email, recipient_name, frequency, location_id, enabled } = req.body || {};
    const { rows } = await pool.query(
      `UPDATE vir_report_subscriptions
       SET email=COALESCE($2,email), recipient_name=$3, frequency=COALESCE($4,frequency),
           location_id=$5, enabled=COALESCE($6,enabled), updated_at=now()
       WHERE id=$1
       RETURNING *`,
      [id, email ?? null, recipient_name ?? null, frequency ?? null, location_id ?? null, enabled]
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: "not_found" });
    return res.json({ ok: true, subscription: rows[0] });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error?.message || "subscription_update_failed" });
  }
});

router.delete("/subscriptions/:id", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ ok: false, error: "forbidden" });
    await ensureReportTables();
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
    return res.status(500).json({ ok: false, error: error?.message || "send_failed" });
  }
});

export default router;
