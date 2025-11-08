import express from "express";
import pool from "../db";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { Router } from "express";

const router = express.Router();

/**
 * GET /api/me
 * Visszaadja a bejelentkezett felhasználó adatait.
 */

router.get("/", requireAuth, async (req: AuthRequest, res) => {
  try {
    // req.user a tokenből jön
    const userId = req.user!.id;

    // Feltételezzük, hogy a dolgozók/users táblában vannak a személyes adatok.
    // Itt te döntöd el: "users" vagy "employees".
    // Most employees alapján mutatom, mert ott van full_name, location_id stb.
    // Ha nálad a bejelentkezők a users táblából jönnek, akkor azt JOIN-olhatod át employees-re.
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
    

export default router;
