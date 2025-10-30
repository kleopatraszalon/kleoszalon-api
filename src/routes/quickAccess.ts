import express from "express";
import pool from "./db";

const router = express.Router();

/**
 * 🔹 Gyors hozzáférések lekérdezése (linkek + név)
 */
router.get("/", async (req, res) => {
  try {
    res.header("Access-Control-Allow-Origin", "*");

    const result = await pool.query(
      `SELECT id, name, link
       FROM quick_access
       ORDER BY id ASC`
    );

    res.json(result.rows);
  } catch (err) {
    console.error("❌ Gyors hozzáférés lekérési hiba:", err);
    res.status(500).json({ error: "Adatbázis hiba" });
  }
});

export default router;
