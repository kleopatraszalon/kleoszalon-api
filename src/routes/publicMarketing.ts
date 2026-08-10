// src/routes/publicMarketing.ts
import { Router, Request, Response } from "express";
import pool from "../db";
import onlineBookingRouter from "./onlineBooking";
import bookingVoiceRouter from "./bookingVoice";

const router = Router();
// A speciális voice route az általános booking router előtt fut.
router.use("/booking/voice", bookingVoiceRouter);
router.use("/booking", onlineBookingRouter);

const PUBLIC_SALONS = [
  { id: "budapest-ix", slug: "budapest-ix", city_label: "Kleopátra Szépségszalon – Budapest IX.", address: "Mester u. 1." },
  { id: "budapest-viii", slug: "budapest-viii", city_label: "Kleopátra Szépségszalon – Budapest VIII.", address: "Rákóczi u. 63." },
  { id: "budapest-xii", slug: "budapest-xii", city_label: "Kleopátra Szépségszalon – Budapest XII.", address: "Krisztina krt. 23." },
  { id: "budapest-xiii", slug: "budapest-xiii", city_label: "Kleopátra Szépségszalon – Budapest XIII.", address: "Visegrádi u. 3." },
  { id: "eger", slug: "eger", city_label: "Kleopátra Szépségszalon – Eger", address: "Dr. Nagy János u. 8." },
  { id: "gyongyos", slug: "gyongyos", city_label: "Kleopátra Szépségszalon – Gyöngyös", address: "Koháry u. 29." },
  { id: "salgotarjan", slug: "salgotarjan", city_label: "Kleopátra Szépségszalon – Salgótarján", address: "Füleki u. 44." },
];

router.get("/salons", (_req: Request, res: Response) => res.json(PUBLIC_SALONS));

router.get("/services", async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(`
      SELECT s.id::text id,s.name,
        COALESCE(s.duration_minutes,30) duration_min,
        COALESCE(s.promo_price,s.list_price,s.base_price,0) price,
        COALESCE(st.name,'Egyéb szolgáltatások') category_name
      FROM public.services s
      LEFT JOIN public.service_types st ON st.id=s.service_type_id
      WHERE s.is_active=true AND COALESCE(s.online_bookable,true)=true
      ORDER BY COALESCE(st.display_order,999999),st.name,s.name
    `);
    return res.json(result.rows);
  } catch (err) {
    console.error("GET /api/public/services hiba:", err);
    return res.status(500).json({ error: "Nem sikerült betölteni a szolgáltatásokat." });
  }
});

export default router;
