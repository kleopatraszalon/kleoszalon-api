// src/routes/employees.ts
import { Router, Request, Response, NextFunction } from "express";
import pool from "../db";

const router = Router();

/**
 * GET /api/employees
 * Minden dolgozó listája a naptárhoz.
 * Nem kérünk itt auth-ot, hogy biztosan visszaadja a listát.
 */
router.get(
  "/",
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const { rows } = await pool.query(
        `
        SELECT
          id,
          location_id,
          full_name,
          email,
          phone,
          position_id,
          photo_url
        FROM public.employees
        ORDER BY full_name NULLS LAST
        `
      );

      res.json(rows);
    } catch (err) {
      console.error("GET /api/employees hiba:", err);
      next(err);
    }
  }
);

export default router;
