// src/routes/serviceTypes.ts
import { Router, Request, Response } from "express";
import pool from "../db";

const router = Router();

/**
 * GET /api/service-types
 * ServiceNewModal + ServicesList szűrő
 */
router.get("/", async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT id, name FROM public.service_types ORDER BY name;`
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /service-types hiba:", err);
    res.status(500).json({ error: "Nem sikerült betölteni a szolgáltatás típusokat." });
  }
});

export default router;
