// src/routes/publicMarketing.ts
import { Router, Request, Response, NextFunction } from "express";
import pool from "../db"; // ha máshogy exportálod a pool-t, ezt igazítsd hozzá

const router = Router();

/**
 * Public szalon lista – a marketing oldalnak
 * GET /api/public/salons
 */
router.get(
  "/salons",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Itt azt a táblát használd, ami nálad valóban létezik!
      // Példa: locations vagy salons tábla – igazítsd a saját oszlopneveidhez.
      const sql = `
        SELECT
          id,
          name,
          -- AZ ALÁBBI OSZLOPOKAT IGAZÍTSD A SAJÁT ADATBÁZISODHOZ!
          COALESCE(city, '')         AS city,
          COALESCE(address, '')      AS address,
          COALESCE(phone, '')        AS phone,
          COALESCE(email, '')        AS email,
          COALESCE(website, '')      AS website,
          COALESCE(description, '')  AS description,
          COALESCE(image_url, '')    AS image_url
        FROM public.salons
        WHERE is_active = TRUE
        ORDER BY name ASC;
      `;

      const result = await pool.query(sql);

      // Mindig küldünk értelmes JSON-t
      res.json(result.rows ?? []);
    } catch (err) {
      console.error("GET /api/public/salons ERROR:", err);
      next(err); // a globális error handlered intézi a választ
    }
  }
);

export default router;
