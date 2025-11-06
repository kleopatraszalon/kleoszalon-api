import express from "express";
import pool from "../db.js";

const router = express.Router();

// Minden ügyfél lekérése
router.get("/", async (req, res) => {
  try {
    const result = await pool.query("SELECT id, name FROM clients ORDER BY name ASC");
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error fetching clients:", err);
    res.status(500).json({ error: "Error fetching clients" });
  }
});

export default router;
