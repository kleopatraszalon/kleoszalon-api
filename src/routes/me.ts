// src/routes/me.ts
import express, { Response } from "express";
import pool from "../db";
import { requireAuth, AuthRequest } from "../middleware/auth";

const router = express.Router();

/**
 * GET /api/me
 * Visszaadja a bejelentkezett felhasználó adatait.
 */
router.get("/", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    // req.user a tokenből jön
    const userId = req.user!.id;

    // Itt most az employees táblából kérdezzük le az adatokat,
    // JOIN-olva a locations táblával.
    const result = await pool.query(
      `
      SELECT 
        e.id,
        e.full_name,
        e.role,
        e.location_id,
        e.active,
        l.name AS location_name
      FROM employees e
      LEFT JOIN locations l ON l.id = e.location_id
      WHERE e.id = $1
      LIMIT 1
      `,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Felhasználó nem található" });
    }

    const row = result.rows[0];

    // Itt ténylegesen vissza is adjuk a user adatokat
    return res.json({
      id: row.id,
      full_name: row.full_name,
      role: row.role,
      location_id: row.location_id,
      active: row.active,
      location_name: row.location_name,
    });
  } catch (err) {
    console.error("❌ /api/me hiba:", err);
    return res
      .status(500)
      .json({ error: "Szerverhiba történt a /api/me végponton" });
  }
});

export default router;
