// src/routes/bookings.ts
import express, { Request, Response } from "express";
import pool from "../db";

const router = express.Router();

router.get("/", async (_req: Request, res: Response) => {
  try {
    const r = await pool.query(
      `SELECT id, customer_name, service_id, employee_id, starts_at, ends_at, status
       FROM bookings
       ORDER BY starts_at DESC
       LIMIT 200;`
    );
    res.json(r.rows);
  } catch (e) {
    console.error("❌ Bookings lekérési hiba:", e);
    res.status(500).json({ error: "Nem sikerült lekérni a foglalásokat" });
  }
});

export default router;
