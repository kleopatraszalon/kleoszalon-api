import { Router } from "express";
import db from "../db";
import ensureBookingV4 from "../booking/ensureBookingV4";

const router = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const uuidOrNull = (value: unknown) => {
  const v = String(value || "").trim();
  return v && UUID_RE.test(v) ? v : null;
};

router.use(async (_req, res, next) => {
  try {
    await ensureBookingV4();
    next();
  } catch (error: any) {
    res.status(500).json({ error: "A Booking 4.0 adatmodell inicializálása sikertelen.", detail: error?.message || String(error) });
  }
});

router.get("/catalog", async (_req, res) => {
  try {
    const [locations, services, staffLevels, employees] = await Promise.all([
      db.query(`SELECT id,name FROM locations WHERE COALESCE(is_active,true)=true ORDER BY name`),
      db.query(`SELECT s.id,s.name,COALESCE(st.name,'Egyéb szolgáltatások') category_name FROM services s LEFT JOIN service_types st ON st.id=s.service_type_id WHERE COALESCE(s.is_active,true)=true ORDER BY st.name NULLS LAST,s.name`),
      db.query(`SELECT id,code,name,sort_order,is_active FROM booking_staff_levels ORDER BY sort_order,name`),
      db.query(`SELECT e.id,COALESCE(NULLIF(btrim(e.full_name),''),NULLIF(btrim(concat_ws(' ',e.last_name,e.first_name)),''),'Munkatárs') full_name,e.location_id,e.booking_staff_level_id FROM employees e WHERE COALESCE(e.active,true)=true ORDER BY full_name`),
    ]);
    res.json({ locations: locations.rows, services: services.rows, staff_levels: staffLevels.rows, employees: employees.rows });
  } catch (error: any) {
    res.status(500).json({ error: "A Booking 4.0 admin törzsadatok nem tölthetők be.", detail: error?.message || String(error) });
  }
});

router.get("/staff-levels", async (_req, res) => {
  try {
    const { rows } = await db.query(`SELECT id,code,name,sort_order,is_active FROM booking_staff_levels ORDER BY sort_order,name`);
    res.json({ levels: rows });
  } catch (error: any) {
    res.status(500).json({ error: "A szakemberszintek nem tölthetők be.", detail: error?.message || String(error) });
  }
});

router.patch("/staff-levels/:id", async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Érvénytelen szakemberszint-azonosító." });
    const { rows } = await db.query(
      `UPDATE booking_staff_levels SET name=COALESCE(NULLIF($2,''),name),sort_order=COALESCE($3,sort_order),is_active=COALESCE($4,is_active),updated_at=now() WHERE id=$1::uuid RETURNING *`,
      [id, String(req.body?.name || "").trim(), req.body?.sort_order ?? null, req.body?.is_active ?? null]
    );
    if (!rows[0]) return res.status(404).json({ error: "A szakemberszint nem található." });
    res.json(rows[0]);
  } catch (error: any) {
    res.status(500).json({ error: "A szakemberszint nem módosítható.", detail: error?.message || String(error) });
  }
});

router.patch("/employees/:id/staff-level", async (req, res) => {
  try {
    const id = String(req.params.id || ""), levelId = String(req.body?.staff_level_id || "").trim();
    if (!UUID_RE.test(id) || (levelId && !UUID_RE.test(levelId))) return res.status(400).json({ error: "Érvénytelen azonosító." });
    const { rows } = await db.query(`UPDATE employees SET booking_staff_level_id=$2::uuid,updated_at=now() WHERE id=$1::uuid RETURNING id,booking_staff_level_id`, [id, levelId || null]);
    if (!rows[0]) return res.status(404).json({ error: "A munkatárs nem található." });
    res.json(rows[0]);
  } catch (error: any) {
    res.status(500).json({ error: "A szakemberszint hozzárendelése sikertelen.", detail: error?.message || String(error) });
  }
});

router.get("/prices", async (req, res) => {
  try {
    const locationId = uuidOrNull(req.query.location_id);
    const { rows } = await db.query(`
      SELECT p.id,p.service_id,p.staff_level_id,p.location_id,p.price,p.is_active,
             s.name service_name,l.name location_name,sl.code staff_level_code,sl.name staff_level_name
      FROM booking_service_prices_by_level p
      JOIN services s ON s.id=p.service_id
      JOIN booking_staff_levels sl ON sl.id=p.staff_level_id
      LEFT JOIN locations l ON l.id=p.location_id
      WHERE ($1::uuid IS NULL OR p.location_id=$1::uuid)
      ORDER BY s.name,sl.sort_order,l.name NULLS FIRST`, [locationId]);
    res.json({ prices: rows });
  } catch (error: any) {
    res.status(500).json({ error: "Az árszintek nem tölthetők be.", detail: error?.message || String(error) });
  }
});

router.post("/prices", async (req, res) => {
  try {
    const serviceId = String(req.body?.service_id || "").trim(), staffLevelId = String(req.body?.staff_level_id || "").trim();
    const locationId = uuidOrNull(req.body?.location_id);
    const price = Number(req.body?.price);
    if (!UUID_RE.test(serviceId) || !UUID_RE.test(staffLevelId) || !Number.isFinite(price) || price < 0) return res.status(400).json({ error: "Érvénytelen árszint-adatok." });
    const { rows } = await db.query(`
      INSERT INTO booking_service_prices_by_level(service_id,staff_level_id,location_id,price,is_active)
      VALUES($1::uuid,$2::uuid,$3::uuid,$4,true)
      ON CONFLICT(service_id,staff_level_id,COALESCE(location_id,'00000000-0000-0000-0000-000000000000'::uuid))
      DO UPDATE SET price=EXCLUDED.price,is_active=true,updated_at=now()
      RETURNING *`, [serviceId, staffLevelId, locationId, price]);
    res.status(201).json(rows[0]);
  } catch (error: any) {
    res.status(500).json({ error: "Az árszint nem menthető.", detail: error?.message || String(error) });
  }
});

router.patch("/prices/:id", async (req, res) => {
  try {
    const id = String(req.params.id || ""), price = req.body?.price == null ? null : Number(req.body.price);
    if (!UUID_RE.test(id) || (price != null && (!Number.isFinite(price) || price < 0))) return res.status(400).json({ error: "Érvénytelen árszint-adatok." });
    const { rows } = await db.query(`UPDATE booking_service_prices_by_level SET price=COALESCE($2,price),is_active=COALESCE($3,is_active),updated_at=now() WHERE id=$1::uuid RETURNING *`, [id, price, req.body?.is_active ?? null]);
    if (!rows[0]) return res.status(404).json({ error: "Az árszint nem található." });
    res.json(rows[0]);
  } catch (error: any) {
    res.status(500).json({ error: "Az árszint nem módosítható.", detail: error?.message || String(error) });
  }
});

router.get("/coupons", async (_req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT c.*,
        COALESCE((SELECT jsonb_agg(cl.location_id) FROM booking_coupon_locations cl WHERE cl.coupon_id=c.id),'[]'::jsonb) location_ids,
        COALESCE((SELECT jsonb_agg(cs.service_id) FROM booking_coupon_services cs WHERE cs.coupon_id=c.id),'[]'::jsonb) service_ids
      FROM booking_coupon_campaigns c ORDER BY c.is_active DESC,c.created_at DESC`);
    res.json({ coupons: rows });
  } catch (error: any) {
    res.status(500).json({ error: "A kuponok nem tölthetők be.", detail: error?.message || String(error) });
  }
});

router.post("/coupons", async (req, res) => {
  const cx = await db.connect();
  try {
    const code = String(req.body?.code || "").trim().toUpperCase(), name = String(req.body?.name || "").trim();
    const type = String(req.body?.discount_type || "percent"), value = Number(req.body?.discount_value);
    if (!code || !name || !["percent", "fixed"].includes(type) || !Number.isFinite(value) || value <= 0 || (type === "percent" && value > 100)) return res.status(400).json({ error: "Érvénytelen kuponadatok." });
    const locationIds = Array.isArray(req.body?.location_ids) ? req.body.location_ids.map(String).filter((x: string) => UUID_RE.test(x)) : [];
    const serviceIds = Array.isArray(req.body?.service_ids) ? req.body.service_ids.map(String).filter((x: string) => UUID_RE.test(x)) : [];
    await cx.query("BEGIN");
    const { rows } = await cx.query(`INSERT INTO booking_coupon_campaigns(code,name,discount_type,discount_value,valid_from,valid_until,minimum_booking_value,max_total_uses,max_uses_per_customer,combinable,exclude_last_minute,is_active) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`, [code,name,type,value,req.body?.valid_from||null,req.body?.valid_until||null,req.body?.minimum_booking_value||null,req.body?.max_total_uses||null,req.body?.max_uses_per_customer||null,Boolean(req.body?.combinable),req.body?.exclude_last_minute!==false,req.body?.is_active!==false]);
    const couponId = rows[0].id;
    for (const id of locationIds) await cx.query(`INSERT INTO booking_coupon_locations(coupon_id,location_id) VALUES($1::uuid,$2::uuid) ON CONFLICT DO NOTHING`, [couponId,id]);
    for (const id of serviceIds) await cx.query(`INSERT INTO booking_coupon_services(coupon_id,service_id) VALUES($1::uuid,$2::uuid) ON CONFLICT DO NOTHING`, [couponId,id]);
    await cx.query("COMMIT");
    res.status(201).json(rows[0]);
  } catch (error: any) {
    await cx.query("ROLLBACK").catch(() => undefined);
    if (String(error?.code || "") === "23505") return res.status(409).json({ error: "Ez a kuponkód már létezik." });
    res.status(500).json({ error: "A kupon nem menthető.", detail: error?.message || String(error) });
  } finally { cx.release(); }
});

router.patch("/coupons/:id", async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Érvénytelen kuponazonosító." });
    const { rows } = await db.query(`UPDATE booking_coupon_campaigns SET name=COALESCE($2,name),discount_value=COALESCE($3,discount_value),valid_from=COALESCE($4,valid_from),valid_until=COALESCE($5,valid_until),minimum_booking_value=COALESCE($6,minimum_booking_value),combinable=COALESCE($7,combinable),exclude_last_minute=COALESCE($8,exclude_last_minute),is_active=COALESCE($9,is_active),updated_at=now() WHERE id=$1::uuid RETURNING *`, [id,req.body?.name??null,req.body?.discount_value??null,req.body?.valid_from??null,req.body?.valid_until??null,req.body?.minimum_booking_value??null,req.body?.combinable??null,req.body?.exclude_last_minute??null,req.body?.is_active??null]);
    if (!rows[0]) return res.status(404).json({ error: "A kupon nem található." });
    res.json(rows[0]);
  } catch (error: any) {
    res.status(500).json({ error: "A kupon nem módosítható.", detail: error?.message || String(error) });
  }
});

router.get("/rules", async (_req, res) => {
  try {
    const { rows } = await db.query(`SELECT r.*,l.name location_name,s.name service_name,sl.name staff_level_name FROM booking_last_minute_rules r LEFT JOIN locations l ON l.id=r.location_id LEFT JOIN services s ON s.id=r.service_id LEFT JOIN booking_staff_levels sl ON sl.id=r.staff_level_id ORDER BY r.is_active DESC,r.created_at DESC`);
    res.json({ rules: rows });
  } catch (error: any) {
    res.status(500).json({ error: "A Last Minute szabályok nem tölthetők be.", detail: error?.message || String(error) });
  }
});

router.post("/rules", async (req, res) => {
  try {
    const locationId = String(req.body?.location_id || "").trim(), serviceId = String(req.body?.service_id || "").trim(), staffLevelId = String(req.body?.staff_level_id || "").trim();
    if (locationId && !UUID_RE.test(locationId)) return res.status(400).json({ error: "Érvénytelen location_id." });
    if (serviceId && !UUID_RE.test(serviceId)) return res.status(400).json({ error: "Érvénytelen service_id." });
    if (staffLevelId && !UUID_RE.test(staffLevelId)) return res.status(400).json({ error: "Érvénytelen staff_level_id." });
    const threshold = Math.max(0, Math.min(100, Number(req.body?.free_capacity_threshold_percent ?? 50)));
    const discount = Math.max(1, Math.min(100, Number(req.body?.discount_percent ?? 20)));
    const validity = Math.max(1, Math.min(168, Number(req.body?.validity_hours ?? 24)));
    const name = String(req.body?.name || "Automatikus Last Minute").trim() || "Automatikus Last Minute";
    const { rows } = await db.query(`INSERT INTO booking_last_minute_rules(name,location_id,service_id,staff_level_id,free_capacity_threshold_percent,discount_percent,validity_hours,same_day_only,is_active) VALUES($1,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,$8,$9) RETURNING *`, [name,locationId||null,serviceId||null,staffLevelId||null,threshold,discount,validity,req.body?.same_day_only!==false,req.body?.is_active!==false]);
    res.status(201).json(rows[0]);
  } catch (error: any) {
    res.status(500).json({ error: "A Last Minute szabály nem menthető.", detail: error?.message || String(error) });
  }
});

router.patch("/rules/:id", async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Érvénytelen szabályazonosító." });
    const { rows } = await db.query(`UPDATE booking_last_minute_rules SET name=COALESCE($2,name),free_capacity_threshold_percent=COALESCE($3,free_capacity_threshold_percent),discount_percent=COALESCE($4,discount_percent),validity_hours=COALESCE($5,validity_hours),same_day_only=COALESCE($6,same_day_only),is_active=COALESCE($7,is_active),updated_at=now() WHERE id=$1::uuid RETURNING *`, [id,req.body?.name??null,req.body?.free_capacity_threshold_percent??null,req.body?.discount_percent??null,req.body?.validity_hours??null,req.body?.same_day_only??null,req.body?.is_active??null]);
    if (!rows[0]) return res.status(404).json({ error: "A szabály nem található." });
    res.json(rows[0]);
  } catch (error: any) {
    res.status(500).json({ error: "A Last Minute szabály nem módosítható.", detail: error?.message || String(error) });
  }
});

router.post("/rebuild", async (req, res) => {
  const date = String(req.body?.date || new Date().toISOString().slice(0, 10));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "Érvénytelen dátum." });
  const locationFilter = String(req.body?.location_id || "").trim();
  if (locationFilter && !UUID_RE.test(locationFilter)) return res.status(400).json({ error: "Érvénytelen location_id." });
  const cx = await db.connect();
  try {
    await cx.query("BEGIN");
    await cx.query(`UPDATE booking_last_minute_offers SET status='expired',updated_at=now() WHERE status='active' AND (expires_at<=now() OR start_time<=now())`);
    const { rows: rules } = await cx.query(`SELECT r.*,COALESCE(obs.opening_minute,480)::int opening_minute,COALESCE(obs.closing_minute,1200)::int closing_minute FROM booking_last_minute_rules r LEFT JOIN online_booking_settings obs ON obs.location_id=r.location_id WHERE r.is_active=true AND ($1::uuid IS NULL OR r.location_id=$1::uuid OR r.location_id IS NULL)`, [locationFilter||null]);
    let generated = 0;
    for (const rule of rules) {
      if (!rule.location_id || !rule.service_id) continue;
      const service = (await cx.query(`SELECT id,COALESCE(duration_minutes,30)::int duration_minutes,COALESCE(promo_price,list_price,base_price,0)::numeric price FROM services WHERE id=$1::uuid AND is_active=true AND COALESCE(online_bookable,true)=true`, [rule.service_id])).rows[0];
      if (!service) continue;
      const opening = Number(rule.opening_minute||480), closing = Number(rule.closing_minute||1200), workMinutes = Math.max(1, closing-opening);
      const employees = (await cx.query(`SELECT e.id,e.booking_staff_level_id FROM employees e WHERE e.active=true AND (e.location_id=$1::uuid OR e.location_id IS NULL) AND ($2::uuid IS NULL OR e.booking_staff_level_id=$2::uuid)`, [rule.location_id,rule.staff_level_id||null])).rows;
      for (const employee of employees) {
        const busy = (await cx.query(`SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (LEAST(end_time,$4::timestamptz)-GREATEST(start_time,$3::timestamptz)))/60),0)::numeric busy_minutes FROM appointments WHERE employee_id=$1::uuid AND location_id=$2::uuid AND status NOT IN ('cancelled','canceled','no_show') AND start_time<$4::timestamptz AND end_time>$3::timestamptz`, [employee.id,rule.location_id,`${date}T${String(Math.floor(opening/60)).padStart(2,'0')}:${String(opening%60).padStart(2,'0')}:00`,`${date}T${String(Math.floor(closing/60)).padStart(2,'0')}:${String(closing%60).padStart(2,'0')}:00`])).rows[0];
        const freePercent = 100-(Number(busy?.busy_minutes||0)/workMinutes*100);
        if (freePercent < Number(rule.free_capacity_threshold_percent||50)) continue;
        const starts = (await cx.query(`SELECT gs AS start_time,gs+make_interval(mins=>$5::int) AS end_time FROM generate_series($3::timestamptz,$4::timestamptz-make_interval(mins=>$5::int),interval '15 minutes') gs WHERE gs>now() AND NOT EXISTS(SELECT 1 FROM appointments a WHERE a.employee_id=$1::uuid AND a.location_id=$2::uuid AND a.status NOT IN ('cancelled','canceled','no_show') AND a.start_time<gs+make_interval(mins=>$5::int) AND a.end_time>gs) ORDER BY gs LIMIT 8`, [employee.id,rule.location_id,`${date}T${String(Math.floor(opening/60)).padStart(2,'0')}:${String(opening%60).padStart(2,'0')}:00`,`${date}T${String(Math.floor(closing/60)).padStart(2,'0')}:${String(closing%60).padStart(2,'0')}:00`,service.duration_minutes])).rows;
        for (const candidate of starts) {
          const original = Number(service.price||0), offer = Math.max(0,Math.round(original*(1-Number(rule.discount_percent)/100)));
          const inserted = await cx.query(`INSERT INTO booking_last_minute_offers(rule_id,location_id,service_id,employee_id,start_time,end_time,original_price,offer_price,discount_percent,expires_at,status) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,$8,$9,LEAST($5::timestamptz,now()+make_interval(hours=>$10::int)),'active') ON CONFLICT DO NOTHING RETURNING id`, [rule.id,rule.location_id,rule.service_id,employee.id,candidate.start_time,candidate.end_time,original,offer,rule.discount_percent,rule.validity_hours]);
          generated += inserted.rowCount || 0;
        }
      }
    }
    await cx.query("COMMIT");
    res.json({ ok: true, date, generated });
  } catch (error: any) {
    await cx.query("ROLLBACK");
    res.status(500).json({ error: "A Last Minute ajánlatok generálása sikertelen.", detail: error?.message || String(error) });
  } finally { cx.release(); }
});

router.get("/offers", async (_req, res) => {
  try {
    const { rows } = await db.query(`SELECT o.*,l.name location_name,s.name service_name,COALESCE(NULLIF(e.full_name,''),concat_ws(' ',e.last_name,e.first_name),'Munkatárs') employee_name FROM booking_last_minute_offers o JOIN locations l ON l.id=o.location_id JOIN services s ON s.id=o.service_id JOIN employees e ON e.id=o.employee_id ORDER BY o.start_time DESC LIMIT 300`);
    res.json({ offers: rows });
  } catch (error: any) {
    res.status(500).json({ error: "A Last Minute ajánlatok nem tölthetők be.", detail: error?.message || String(error) });
  }
});

export default router;
