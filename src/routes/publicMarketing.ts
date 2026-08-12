// src/routes/publicMarketing.ts
import { Router, Request, Response } from "express";
import pool from "../db";
import onlineBookingRouter from "./onlineBooking";
import bookingVoiceRouter from "./bookingVoice";
import bookingScheduleRouter from "./bookingSchedule";
import bookingManageRouter from "./bookingManage";
import bookingVoiceRateLimit from "../booking/voiceRateLimit";
import { publicDailyActionsRouter } from "./dailyActions";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import JWT_SECRET from "../security/jwtSecret";

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

let appCustomerSchemaPromise: Promise<void> | null = null;
function ensureAppCustomerSchema() {
  if (!appCustomerSchemaPromise) appCustomerSchemaPromise = pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name text;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS login_name text;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text;
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS full_name text;
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS name text;
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS phone text;
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS email text;
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS marketing_consent boolean NOT NULL DEFAULT false;
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
    CREATE TABLE IF NOT EXISTS crm_tags (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text NOT NULL,color text NOT NULL DEFAULT '#b69861',is_active boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL DEFAULT now());
    CREATE UNIQUE INDEX IF NOT EXISTS crm_tags_name_uq ON crm_tags ((lower(name)));
    CREATE TABLE IF NOT EXISTS crm_client_tags (client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,tag_id uuid NOT NULL REFERENCES crm_tags(id) ON DELETE CASCADE,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(client_id,tag_id));
  `).then(() => undefined).catch(error => { appCustomerSchemaPromise = null; throw error; });
  return appCustomerSchemaPromise;
}

const clean = (value: unknown, max = 240) => String(value ?? "").trim().slice(0, max);
const validEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

async function saveAppClient(dbClient: any, data: any, registered: boolean) {
  const fullName = clean(data.full_name, 160), email = clean(data.email, 200).toLowerCase(), phone = clean(data.phone, 60);
  const existing = await dbClient.query(`SELECT id::text FROM clients WHERE ($1<>'' AND lower(COALESCE(email,''))=$1) OR ($2<>'' AND regexp_replace(COALESCE(phone,''),'[^0-9]','','g')=regexp_replace($2,'[^0-9]','','g')) ORDER BY updated_at DESC NULLS LAST LIMIT 1`, [email, phone]);
  let clientId = existing.rows[0]?.id;
  if (clientId) {
    await dbClient.query(`UPDATE clients SET full_name=$2,name=$2,email=COALESCE(NULLIF($3,''),email),phone=COALESCE(NULLIF($4,''),phone),marketing_consent=marketing_consent OR $5,is_active=true,source=CASE WHEN $6 THEN 'kleopatra_app_registered' ELSE COALESCE(NULLIF(source,''),'kleopatra_app_guest') END,updated_at=now() WHERE id=$1::uuid`, [clientId, fullName, email, phone, Boolean(data.marketing_consent), registered]);
  } else {
    const inserted = await dbClient.query(`INSERT INTO clients(full_name,name,email,phone,marketing_consent,is_active,source,created_at,updated_at) VALUES($1,$1,NULLIF($2,''),NULLIF($3,''),$4,true,$5,now(),now()) RETURNING id::text`, [fullName, email, phone, Boolean(data.marketing_consent), registered ? "kleopatra_app_registered" : "kleopatra_app_guest"]);
    clientId = inserted.rows[0].id;
  }
  if (!registered) {
    const tag = await dbClient.query(`INSERT INTO crm_tags(name,color) VALUES('Nem regisztrált','#8b8177') ON CONFLICT ((lower(name))) DO UPDATE SET is_active=true RETURNING id`);
    await dbClient.query(`INSERT INTO crm_client_tags(client_id,tag_id) VALUES($1::uuid,$2::uuid) ON CONFLICT DO NOTHING`, [clientId, tag.rows[0].id]);
  } else {
    await dbClient.query(`DELETE FROM crm_client_tags WHERE client_id=$1::uuid AND tag_id IN (SELECT id FROM crm_tags WHERE lower(name)=lower('Nem regisztrált'))`, [clientId]);
  }
  return clientId;
}

router.post("/app/register", async (req: Request, res: Response, next) => {
  const fullName = clean(req.body?.full_name, 160), email = clean(req.body?.email, 200).toLowerCase(), phone = clean(req.body?.phone, 60), password = String(req.body?.password || "");
  if (fullName.length < 2 || !validEmail(email) || password.length < 8) return res.status(400).json({ error: "Név, érvényes e-mail és legalább 8 karakteres jelszó szükséges." });
  const client = await pool.connect();
  try {
    await ensureAppCustomerSchema(); await client.query("BEGIN");
    const exists = await client.query(`SELECT id FROM users WHERE lower(COALESCE(email,''))=$1 LIMIT 1`, [email]);
    if (exists.rowCount) { await client.query("ROLLBACK"); return res.status(409).json({ error: "Ezzel az e-mail címmel már létezik fiók. Jelentkezzen be." }); }
    const roleType = await client.query(`SELECT udt_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='users' AND column_name='role' LIMIT 1`);
    const hash = await bcrypt.hash(password, 12); let user;
    if (roleType.rows[0]?.udt_name === "jsonb") user = await client.query(`INSERT INTO users(full_name,email,password_hash,role) VALUES($1,$2,$3,to_jsonb('customer'::text)) RETURNING id::text`, [fullName,email,hash]);
    else if (roleType.rows[0]?.udt_name === "json") user = await client.query(`INSERT INTO users(full_name,email,password_hash,role) VALUES($1,$2,$3,to_json('customer'::text)) RETURNING id::text`, [fullName,email,hash]);
    else user = await client.query(`INSERT INTO users(full_name,email,password_hash,role) VALUES($1,$2,$3,'customer') RETURNING id::text`, [fullName,email,hash]);
    const customerId = await saveAppClient(client,{...req.body,full_name:fullName,email,phone}, true);
    await client.query("COMMIT");
    const token = jwt.sign({id:user.rows[0].id,userId:user.rows[0].id,email,role:"customer",customer_id:customerId}, JWT_SECRET, {expiresIn:"30d"});
    res.status(201).json({success:true,token,role:"customer",account_type:"customer",full_name:fullName,email,customer_id:customerId});
  } catch (error) { await client.query("ROLLBACK").catch(()=>{}); next(error); } finally { client.release(); }
});

router.post("/app/guest", async (req: Request, res: Response, next) => {
  const fullName = clean(req.body?.full_name, 160), email = clean(req.body?.email, 200).toLowerCase(), phone = clean(req.body?.phone, 60);
  if (fullName.length < 2 || (!phone && !validEmail(email))) return res.status(400).json({ error: "Név és legalább telefonszám vagy érvényes e-mail szükséges." });
  const client = await pool.connect();
  try { await ensureAppCustomerSchema(); await client.query("BEGIN"); const customerId = await saveAppClient(client,{...req.body,full_name:fullName,email,phone}, false); await client.query("COMMIT"); res.status(201).json({success:true,customer_id:customerId,guest:{full_name:fullName,email,phone,marketing_consent:Boolean(req.body?.marketing_consent)},tag:"Nem regisztrált"}); }
  catch(error){await client.query("ROLLBACK").catch(()=>{});next(error)} finally{client.release()}
});

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
