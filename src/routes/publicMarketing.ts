// src/routes/publicMarketing.ts
import { Router, Request, Response } from "express";
import pool from "../db";

const router = Router();

/**
 * Statikus szalonlista – marketing oldalnak.
 */
const PUBLIC_SALONS = [
  {
    id: "budapest-ix",
    slug: "budapest-ix",
    city_label: "Kleopátra Szépségszalon – Budapest IX.",
    address: "Mester u. 1.",
  },
  {
    id: "budapest-viii",
    slug: "budapest-viii",
    city_label: "Kleopátra Szépségszalon – Budapest VIII.",
    address: "Rákóczi u. 63.",
  },
  {
    id: "budapest-xii",
    slug: "budapest-xii",
    city_label: "Kleopátra Szépségszalon – Budapest XII.",
    address: "Krisztina krt. 23.",
  },
  {
    id: "budapest-xiii",
    slug: "budapest-xiii",
    city_label: "Kleopátra Szépségszalon – Budapest XIII.",
    address: "Visegrádi u. 3.",
  },
  {
    id: "eger",
    slug: "eger",
    city_label: "Kleopátra Szépségszalon – Eger",
    address: "Dr. Nagy János u. 8.",
  },
  {
    id: "gyongyos",
    slug: "gyongyos",
    city_label: "Kleopátra Szépségszalon – Gyöngyös",
    address: "Koháry u. 29.",
  },
  {
    id: "salgotarjan",
    slug: "salgotarjan",
    city_label: "Kleopátra Szépségszalon – Salgótarján",
    address: "Füleki u. 44.",
  },
];

/**
 * GET /api/public/salons
 * Statikus lista, nem tud elhasalni.
 */
router.get("/salons", (req: Request, res: Response) => {
  res.json(PUBLIC_SALONS);
});

/**
 * GET /api/public/services
 * Összes aktív szolgáltatás a `services` táblából.
 * A frontend fog telephely szerint szűrni `location_id` alapján.
 */
router.get("/services", async (req: Request, res: Response) => {
  try {
    const sql = `
      SELECT
        s.id::text      AS id,
        s.name          AS name,
        s.duration_min  AS duration_min,
        s.price         AS price,
        s.category_id   AS category_id,
        s.location_id   AS location_id
      FROM public.services s
      WHERE s.is_active = TRUE
      ORDER BY
        s.category_id,
        s.name;
    `;

    const result = await pool.query(sql);
    return res.json(result.rows);
  } catch (err) {
    console.error("GET /api/public/services hiba:", err);
    return res
      .status(500)
      .json({ error: "Nem sikerült betölteni a szolgáltatásokat." });
  }
});

export default router;
