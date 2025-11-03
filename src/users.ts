// 🔹 Összes felhasználó listázása (admin funkció)

import express, { Request, Response } from "express";
import pool from "./db"; // vagy "../db", ha a routes mappában van

const router = express.Router();

// 🔹 Összes felhasználó lekérdezése
router.get("/", async (req: Request, res: Response) => {
  try {
    const result = await pool.query(
      "SELECT id, name, email, role, is_active, created_at FROM users ORDER BY created_at DESC"
    );
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Hiba a felhasználók lekérdezésénél:", err);
    res.status(500).json({ error: "Adatbázis hiba" });
  }
});

// 🔹 Felhasználó aktiválása admin által
router.put("/activate/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      "UPDATE users SET is_active = true WHERE id = $1 RETURNING id, name, email, role, is_active",
      [id]
    );

    if (result.rowCount === 0)
      return res.status(404).json({ error: "Felhasználó nem található" });

    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error("❌ Hiba az aktiválás során:", err);
    res.status(500).json({ error: "Adatbázis hiba" });
  }
});

export default router;
