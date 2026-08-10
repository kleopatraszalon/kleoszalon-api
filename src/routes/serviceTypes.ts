// src/routes/serviceTypes.ts
import { Router, Request, Response } from "express";
import pool from "../db";
import { requireAuth } from "../middleware/auth";

const router = Router();
router.use(requireAuth);

/**
 * GET /api/service-types
 * ServiceNewModal + ServicesList szűrő
 */
router.get("/", async (_req: Request, res: Response) => {
  try {
    await pool.query(`
      ALTER TABLE public.service_types
        ADD COLUMN IF NOT EXISTS display_order integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS altegio_category_key text;
    `);

    const result = await pool.query(
      `SELECT id, name, display_order
       FROM public.service_types
       ORDER BY display_order ASC, name ASC;`
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /service-types hiba:", err);
    res.status(500).json({ error: "Nem sikerült betölteni a szolgáltatás típusokat." });
  }
});

export default router;
