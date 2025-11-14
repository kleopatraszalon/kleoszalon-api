// src/routes/appointments.ts
import { Router, Request, Response } from "express";
import pool from "../db";

const router = Router();

/**
 * GET /api/appointments
 * Query paraméterek:
 *   from: "YYYY-MM-DD HH:MM" (opcionális)
 *   to:   "YYYY-MM-DD HH:MM" (opcionális)
 *
 * A frontend most így hívja:
 *   /api/appointments?from=2025-11-14 00:00&to=2025-11-14 23:59
 */
router.get("/", async (req: Request, res: Response) => {
  try {
    const { from, to } = req.query;

    const fromStr = typeof from === "string" ? from : undefined;
    const toStr = typeof to === "string" ? to : undefined;

    const params: any[] = [];
    let where = "WHERE 1=1";

    if (fromStr) {
      params.push(fromStr);
      where += ` AND a.start_time >= $${params.length}::timestamp`;
    }
    if (toStr) {
      params.push(toStr);
      where += ` AND a.start_time <= $${params.length}::timestamp`;
    }

    const sql = `
      SELECT
        a.id,
        a.start_time,
        a.end_time,
        a.status
      FROM public.appointments a
      ${where}
      ORDER BY a.start_time ASC
    `;

    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error("GET /api/appointments error:", err);
    res
      .status(500)
      .json({ error: "Hiba a bejelentkezések lekérdezésekor" });
  }
});

export default router;
