import { Router } from "express";
import pool from "../db";
import { requireAuth } from "../middleware/auth";

const router = Router();

router.get("/", requireAuth, async (req, res) => {
  try {
    const { locationId } = req.query;

    const { rows } = await pool.query(
      `SELECT kpi_key, target_value
       FROM vir_kpi_targets
       WHERE location_id IS NULL OR location_id = $1`,
      [locationId || null]
    );

    const targets: Record<string, number> = {};
    rows.forEach((r: any) => {
      targets[r.kpi_key] = Number(r.target_value);
    });

    res.json({ ok: true, targets });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message || "vir_targets_failed" });
  }
});

export default router;
