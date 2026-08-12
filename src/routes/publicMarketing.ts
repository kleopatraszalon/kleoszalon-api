// src/routes/publicMarketing.ts
import { Router, Request, Response } from "express";
import pool from "../db";
import onlineBookingRouter from "./onlineBooking";
import bookingVoiceRouter from "./bookingVoice";
import bookingScheduleRouter from "./bookingSchedule";
import bookingManageRouter from "./bookingManage";
import bookingVoiceRateLimit from "../booking/voiceRateLimit";
import { publicDailyActionsRouter } from "./dailyActions";

const router = Router();
router.use("/daily-actions", publicDailyActionsRouter);
// Speciális booking rétegek az általános router előtt futnak.
// A Voice Booking POST /interpret hívásai először a PostgreSQL-backed limiteren mennek át,
// így több Render instance esetén is közös limit érvényesül. A bookingVoice belső limiter
// további defense-in-depth marad.
router.use("/booking/voice", bookingVoiceRateLimit, bookingVoiceRouter);
router.use("/booking/manage", bookingManageRouter);
router.use("/booking", bookingScheduleRouter);
router.use("/booking", onlineBookingRouter);

const PUBLIC_SALONS = [
  { id: "budapest-ix", slug: "budapest-ix", city_label: "Budapest IX.", address: "1095 Budapest, Mester u. 1.", latitude: 47.4829, longitude: 19.0691, phone: "+36 30 905 7765", hours: "H-P 07:00-21:00, Szo 07:00-16:00" },
  { id: "budapest-viii", slug: "budapest-viii", city_label: "Budapest VIII.", address: "1081 Budapest, Rákóczi út 63.", latitude: 47.4982, longitude: 19.077, phone: "+36 30 905 7765", hours: "H-P 07:00-21:00, Szo 07:00-16:00" },
  { id: "budapest-xii", slug: "budapest-xii", city_label: "Budapest XII.", address: "1122 Budapest, Krisztina krt. 23.", latitude: 47.5005, longitude: 19.0301, phone: "+36 30 905 7765", hours: "H-P 07:00-21:00, Szo 07:00-16:00" },
  { id: "budapest-xiii", slug: "budapest-xiii", city_label: "Budapest XIII.", address: "1132 Budapest, Visegrádi u. 3.", latitude: 47.512, longitude: 19.0522, phone: "+36 30 905 7765", hours: "H-P 07:00-21:00, Szo 07:00-16:00" },
  { id: "eger", slug: "eger", city_label: "Eger", address: "3300 Eger, Dr. Nagy János u. 8.", latitude: 47.9022, longitude: 20.3745, phone: "+36 30 905 7765", hours: "H-P 08:00-20:00, Szo 08:00-14:00" },
  { id: "gyongyos", slug: "gyongyos", city_label: "Gyöngyös", address: "3200 Gyöngyös, Koháry u. 29.", latitude: 47.7834, longitude: 19.9297, phone: "+36 30 905 7765", hours: "H-P 08:00-20:00, Szo 08:00-14:00" },
  { id: "salgotarjan", slug: "salgotarjan", city_label: "Salgótarján", address: "3100 Salgótarján, Füleki u. 44.", latitude: 48.1034, longitude: 19.8061, phone: "+36 30 905 7765", hours: "H-P 08:00-20:00, Szo 08:00-14:00" },
];

async function ensureAppReviews() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_salon_reviews (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      salon_id text NOT NULL,
      guest_name text NOT NULL,
      rating smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
      comment text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS app_salon_reviews_public_idx
      ON app_salon_reviews(salon_id,status,created_at DESC);
  `);
}

router.get("/salons", async (_req: Request, res: Response, next) => {
  try {
    await ensureAppReviews();
    const aggregate = await pool.query(`SELECT salon_id,COUNT(*)::int review_count,ROUND(AVG(rating)::numeric,1) rating FROM app_salon_reviews WHERE status='approved' GROUP BY salon_id`);
    const bySalon = new Map(aggregate.rows.map((row: any) => [row.salon_id, row]));
    res.json(PUBLIC_SALONS.map(salon => ({ ...salon, review_count: bySalon.get(salon.id)?.review_count || 0, rating: Number(bySalon.get(salon.id)?.rating || 0) })));
  } catch (error) { next(error); }
});

router.get("/salons/:salonId/reviews", async (req: Request, res: Response, next) => {
  try {
    await ensureAppReviews();
    const rows = await pool.query(`SELECT id,guest_name,rating,comment,created_at FROM app_salon_reviews WHERE salon_id=$1 AND status='approved' ORDER BY created_at DESC LIMIT 50`, [req.params.salonId]);
    res.json(rows.rows);
  } catch (error) { next(error); }
});

router.post("/salons/:salonId/reviews", async (req: Request, res: Response, next) => {
  try {
    await ensureAppReviews();
    if (!PUBLIC_SALONS.some(salon => salon.id === req.params.salonId)) return res.status(404).json({ message: "A szalon nem található." });
    const guestName = String(req.body?.guest_name || "").trim().slice(0, 80);
    const comment = String(req.body?.comment || "").trim().slice(0, 1500);
    const rating = Number(req.body?.rating);
    if (guestName.length < 2 || comment.length < 10 || !Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ message: "Adjon meg nevet, 1-5 csillagot és legalább 10 karakteres véleményt." });
    await pool.query(`INSERT INTO app_salon_reviews(salon_id,guest_name,rating,comment) VALUES($1,$2,$3,$4)`, [req.params.salonId, guestName, rating, comment]);
    res.status(201).json({ ok: true, message: "Köszönjük! A vélemény moderáció után jelenik meg." });
  } catch (error) { next(error); }
});

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
