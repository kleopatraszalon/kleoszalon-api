// src/routes/me.ts
import express from "express";
import pool from "../db";
import { requireAuth, AuthRequest } from "../middleware/auth";

const router = express.Router();

/**
 * GET /api/me
 * Visszaadja a bejelentkezett felhasználó adatait a JWT-ben lévő user id alapján.
 */
router.get("/", requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id; // JWT payloadból jön (id: users.id)

    const result = await pool.query(
      `
      SELECT
        u.id,
        u.email,
        u.role,
        u.location_id,
        u.full_name
      FROM users u
      WHERE u.id = $1
      LIMIT 1
      `,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Felhasználó nem található" });
    }

    const row = result.rows[0];

    // Opcionálisan lekérjük a telephely nevét is
    let locationName: string | null = null;
    if (row.location_id) {
      const locRes = await pool.query(
        "SELECT name FROM locations WHERE id = $1 LIMIT 1",
        [row.location_id]
      );
      if (locRes.rows.length > 0) {
        locationName = locRes.rows[0].name;
      }
    }

    // A frontend (Home.tsx) ilyen mezőket vár: id, email, role, location_id,
    // full_name, location_name
    return res.json({
      id: row.id,
      email: row.email,
      role: row.role,
      location_id: row.location_id,
      full_name: row.full_name ?? null,
      location_name: locationName,
    });
  } catch (err) {
    console.error("❌ GET /api/me hiba:", err);
    return res.status(500).json({ error: "Szerver hiba" });
  }
});

export default router;
