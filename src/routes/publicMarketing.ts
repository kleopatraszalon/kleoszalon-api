// src/routes/publicMarketing.ts
import { Router, Request, Response } from "express";
import pool from "../db";
import onlineBookingRouter from "./onlineBooking";

const router = Router();

/**
 * Online időpontfoglalás: katalógus, szabad időpontok, foglalás,
 * várólista és vendégoldali lemondás.
 */
router.use("/booking", onlineBookingRouter);

/**
 * Statikus szalonlista – marketing oldalnak.
 */
const PUBLIC_SALONS = [
  { id: "budapest-ix", slug: "budapest-ix", city_label: "Kleopátra Szépségszalon – Budapest IX.", address: "Mester u. 1." },
  { id: "budapest-viii", slug: "budapest-viii", city_label: "Kleopátra Szépségszalon – Budapest VIII.", address: "Rákóczi u. 63." },
  { id: "budapest-xii", slug: "budapest-xii", city_label: "Kleopátra Szépségszalon – Budapest XII.", address: "Krisztina krt. 23." },
  { id: "budapest-xiii", slug: "budapest-xiii", city_label: "Kleopátra Szépségszalon – Budapest XIII.", address: "Visegrádi u. 3." },
  { id: "eger", slug: "eger", city_label: "Kleopátra Szépségszalon – Eger", address: "Dr. Nagy János u. 8." },
  { id: "gyongyos", slug: "gyongyos", city_label: "Kleopátra Szépségszalon – Gyöngyös", address: "Koháry u. 29." },
  { id: "salgotarjan", slug: "salgotarjan", city_label: "Kleopátra Szépségszalon – Salgótarján", address: "Füleki u. 44." },
];

router.get("/salons", (_req: Request, res: Response) => {
  res.json(PUBLIC_SALONS);
});

router.get("/services", async (_req: Request, res: Response) => {
  try {
    const sql = `
      SELECT
        s.id::text AS id,
        s.name AS name,
        COALESCE(s.duration_minutes,30) AS duration_min,
        COALESCE(s.promo_price,s.list_price,s.base_price,0) AS price,
        COALESCE(s.service_type_name,s.category_name,'Egyéb szolgáltatások') AS category_name
      FROM public.services s
      WHERE s.is_active = TRUE
      ORDER BY COALESCE(s.service_type_name,s.category_name,''), s.name;
    `;
    const result = await pool.query(sql);
    return res.json(result.rows);
  } catch (err) {
    console.error("GET /api/public/services hiba:", err);
    return res.status(500).json({ error: "Nem sikerült betölteni a szolgáltatásokat." });
  }
});

export default router;
