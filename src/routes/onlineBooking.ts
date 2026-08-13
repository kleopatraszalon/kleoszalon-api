import { Router } from "express";
import crypto from "crypto";
import db from "../db";
import ensureOnlineBooking from "../booking/ensureOnlineBooking";
import { ensureBookingWorkOrder, ensureBookingWorkOrderSchema } from "../services/bookingWorkOrder";
import bookingScheduleRouter from "./bookingSchedule";
import {bookingRecommendations,bookingRecommendationAiStatus} from "../booking/bookingRecommendations";

const router = Router();

// A régi /api/public/booking alias továbbra is kompatibilis marad, de nem
// kerülheti meg a Foglalás 3.0 közzétett munkaidő / nyitvatartás guardját.
// A kanonikus /api/public/marketing/booking útvonalon a guardot a
// publicMarketing router már a generic onlineBooking router előtt futtatja.
router.use((req,res,next)=>{
  if(String(req.baseUrl||"")==="/api/public/booking") return (bookingScheduleRouter as any)(req,res,next);
  return next();
});

const UUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const asUuidList = (value: unknown) => String(value || "").split(",").map((x) => x.trim()).filter(Boolean);
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const dayStart = (date: string) => new Date(`${date}T00:00:00`);
const addMinutes = (date: Date, minutes: number) => new Date(date.getTime() + minutes * 60000);
const publicCache=new Map<string,{expires:number;value:any}>();

type VoiceValidation={ok:true;id:string;intent:string}|{ok:false;status:number;error:string};
async function validateVoiceEvent(cx:any,id:string,allowedIntents:string[]):Promise<VoiceValidation>{
  // Egy event csak egy végső kimenethez köthető. Az advisory lock a két külön
  // cél-tábla (appointments / booking_waitlist) közötti versenyhelyzetet is kizárja.
  await cx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`,[id]);
  const event=(await cx.query(`SELECT id::text,intent,created_at FROM booking_voice_events WHERE id=$1::uuid LIMIT 1`,[id])).rows[0];
  if(!event)return{ok:false,status:400,error:"A Voice Booking esemény nem található."};
  if(new Date(event.created_at).getTime()<Date.now()-24*3600_000)return{ok:false,status:409,error:"A Voice Booking munkamenet lejárt. Indíts új hangos foglalást."};
  if(!allowedIntents.includes(String(event.intent||"")))return{ok:false,status:409,error:"Ez a Voice Booking esemény nem használható ehhez a művelethez."};
  const used=(await cx.query(`
    SELECT 'appointment' source FROM appointments WHERE voice_event_id=$1::uuid
    UNION ALL
    SELECT 'waitlist' source FROM booking_waitlist WHERE voice_event_id=$1::uuid
    LIMIT 1`,[id])).rows[0];
  if(used)return{ok:false,status:409,error:"Ez a Voice Booking esemény már fel lett használva."};
  return{ok:true,id:String(event.id),intent:String(event.intent)};
}

async function settings(locationId: string) {
  const cacheKey=`settings:${locationId}`,cached=publicCache.get(cacheKey);if(cached&&cached.expires>Date.now())return cached.value;
  await ensureOnlineBooking();
  const { rows } = await db.query(`SELECT * FROM online_booking_settings WHERE location_id=$1::uuid`, [locationId]);
  const value=rows[0] || {
    enabled: true,
    online_discount_percent: 5,
    slot_interval_minutes: 15,
    opening_minute: 480,
    closing_minute: 1200,
    booking_horizon_days: 60,
    minimum_notice_minutes: 60,
    require_staff_confirmation: true,
  };publicCache.set(cacheKey,{expires:Date.now()+60_000,value});return value;
}

const serviceLocationClause = `
  AND (
    NOT EXISTS (SELECT 1 FROM service_locations sl0 WHERE sl0.service_id=s.id)
    OR EXISTS (SELECT 1 FROM service_locations sl WHERE sl.service_id=s.id AND sl.location_id=$2::uuid)
  )`;

router.get("/health", async (_req, res) => {
  const cached=publicCache.get("health");if(cached&&cached.expires>Date.now())return res.json(cached.value);
  try {
    await ensureOnlineBooking();
    const [locations, services, employees] = await Promise.all([
      db.query(`SELECT count(*)::int count FROM locations WHERE COALESCE(is_active,true)=true`),
      db.query(`SELECT count(*)::int count FROM services WHERE COALESCE(is_active,true)=true AND COALESCE(online_bookable,true)=true`),
      db.query(`SELECT count(*)::int count FROM employees WHERE COALESCE(active,true)=true`),
    ]);
    const value={
      ok: true,
      database: true,
      locations: locations.rows[0]?.count || 0,
      services: services.rows[0]?.count || 0,
      employees: employees.rows[0]?.count || 0,
      voice_event_correlation:true,
    };publicCache.set("health",{expires:Date.now()+30_000,value});res.json(value);
  } catch (error: any) {
    res.status(500).json({ ok: false, database: false, error: error?.message || String(error) });
  }
});

router.get("/catalog", async (req, res) => {
  try {
    await ensureOnlineBooking();
    const locationId = String(req.query.location_id || "").trim();
    const cacheKey=`catalog:${locationId||"all"}`,cached=publicCache.get(cacheKey);if(cached&&cached.expires>Date.now())return res.json(cached.value);
    const locations = await db.query(`SELECT id,name FROM locations WHERE COALESCE(is_active,true)=true ORDER BY name`);
    if (!locationId){const value={locations:locations.rows,services:[],employees:[],settings:null};publicCache.set(cacheKey,{expires:Date.now()+5*60_000,value});return res.json(value)}

    const [serviceRows, employeeRows, cfg] = await Promise.all([
      db.query(
        `SELECT s.id,s.name,COALESCE(s.duration_minutes,30)::int duration_minutes,
                COALESCE(s.promo_price,s.list_price,s.base_price,0)::numeric price,
                COALESCE(st.name,'Egyéb szolgáltatások') category_name
         FROM services s
         LEFT JOIN service_types st ON st.id=s.service_type_id
         WHERE s.is_active=true AND COALESCE(s.online_bookable,true)=true
           AND (NOT EXISTS(SELECT 1 FROM service_locations sl0 WHERE sl0.service_id=s.id)
                OR EXISTS(SELECT 1 FROM service_locations sl WHERE sl.service_id=s.id AND sl.location_id=$1::uuid))
         ORDER BY st.name NULLS LAST,s.name`,
        [locationId]
      ),
      db.query(
        `SELECT id,COALESCE(NULLIF(btrim(full_name),''),NULLIF(btrim(concat_ws(' ',last_name,first_name)),''),'Munkatárs') full_name,photo_url
         FROM employees
         WHERE active=true AND (location_id=$1::uuid OR location_id IS NULL)
         ORDER BY COALESCE(NULLIF(full_name,''),last_name,first_name,'')`,
        [locationId]
      ),
      settings(locationId),
    ]);

    const value={locations:locations.rows,services:serviceRows.rows,employees:employeeRows.rows,settings:cfg};publicCache.set(cacheKey,{expires:Date.now()+5*60_000,value});res.json(value);
  } catch (error: any) {
    res.status(500).json({ error: "Az online foglalási adatok nem tölthetők be.", detail: error?.message || String(error) });
  }
});

router.get("/recommendations",async(req,res)=>{
  const locationId=String(req.query.location_id||'').trim(),serviceIds=asUuidList(req.query.service_ids);
  if(!UUID_RE.test(locationId)||!serviceIds.length||serviceIds.some(id=>!UUID_RE.test(id)))return res.status(400).json({error:'Érvényes location_id és service_ids szükséges.'});
  try{return res.json(await bookingRecommendations(locationId,serviceIds))}
  catch(error:any){console.error('[booking-recommendations] failed',error?.message||error);return res.json({recommendations:[],ai_used:false,ai_status:bookingRecommendationAiStatus(),selected_service_ids:serviceIds})}
});

router.get("/availability", async (req, res) => {
  try {
    await ensureOnlineBooking();
    const locationId = String(req.query.location_id || "").trim();
    const date = String(req.query.date || "").trim();
    const serviceIds = asUuidList(req.query.service_ids);
    const employeeId = String(req.query.employee_id || "").trim();

    if (!locationId || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !serviceIds.length) {
      return res.status(400).json({ error: "location_id, date és service_ids kötelező." });
    }

    const cfg = await settings(locationId);
    if (!cfg.enabled) return res.status(403).json({ error: "Az online foglalás ezen a telephelyen ki van kapcsolva." });

    const serviceResult = await db.query(
      `SELECT s.id,COALESCE(s.duration_minutes,30)::int duration_minutes
       FROM services s
       WHERE s.id=ANY($1::uuid[]) AND s.is_active=true AND COALESCE(s.online_bookable,true)=true
       ${serviceLocationClause}`,
      [serviceIds, locationId]
    );
    if (serviceResult.rows.length !== new Set(serviceIds).size) {
      return res.status(400).json({ error: "Egy vagy több szolgáltatás ezen a telephelyen nem foglalható." });
    }

    const duration = serviceResult.rows.reduce((sum: number, row: any) => sum + Number(row.duration_minutes || 30), 0);

    const employees = await db.query(
      `SELECT e.id,COALESCE(NULLIF(btrim(e.full_name),''),NULLIF(btrim(concat_ws(' ',e.last_name,e.first_name)),''),'Munkatárs') full_name
       FROM employees e
       WHERE e.active=true
         AND (e.location_id=$1::uuid OR e.location_id IS NULL)
         AND ($2::uuid IS NULL OR e.id=$2::uuid)
         AND (
           NOT EXISTS (SELECT 1 FROM employee_service_overrides eo0 WHERE eo0.employee_id=e.id)
           OR NOT EXISTS (
             SELECT 1
             FROM unnest($3::uuid[]) AS sid(service_id)
             WHERE NOT EXISTS (
               SELECT 1 FROM employee_service_overrides eo
               WHERE eo.employee_id=e.id AND eo.service_id=sid.service_id
             )
           )
         )
       ORDER BY COALESCE(NULLIF(e.full_name,''),e.last_name,e.first_name,'')`,
      [locationId, employeeId || null, serviceIds]
    );

    if (!employees.rows.length) return res.json({ duration_minutes: duration, slots: [] });

    const base = dayStart(date);
    const from = addMinutes(base, clamp(Number(cfg.opening_minute || 480), 0, 1439));
    const to = addMinutes(base, clamp(Number(cfg.closing_minute || 1200), 1, 1440));
    const nowMin = new Date(Date.now() + Number(cfg.minimum_notice_minutes || 0) * 60000);
    const horizon = new Date();
    horizon.setDate(horizon.getDate() + Number(cfg.booking_horizon_days || 60));
    if (from > horizon) return res.json({ duration_minutes: duration, slots: [] });

    const busy = await db.query(
      `SELECT employee_id,start_time,end_time FROM appointments
       WHERE location_id=$1::uuid AND employee_id=ANY($2::uuid[])
         AND status NOT IN ('cancelled','canceled','no_show')
         AND start_time<$4::timestamptz AND end_time>$3::timestamptz
       UNION ALL
       SELECT employee_id,start_time,end_time FROM appointment_technical_breaks
       WHERE location_id=$1::uuid AND employee_id=ANY($2::uuid[])
         AND start_time<$4::timestamptz AND end_time>$3::timestamptz`,
      [locationId, employees.rows.map((x: any) => x.id), from.toISOString(), to.toISOString()]
    );

    const slots: any[] = [];
    const step = Math.max(5, Number(cfg.slot_interval_minutes || 15));
    for (const employee of employees.rows) {
      const blocks = busy.rows.filter((x: any) => String(x.employee_id) === String(employee.id));
      for (let cursor = new Date(from); cursor < to; cursor = addMinutes(cursor, step)) {
        const end = addMinutes(cursor, duration);
        if (end > to || cursor < nowMin) continue;
        if (blocks.some((x: any) => new Date(x.start_time) < end && new Date(x.end_time) > cursor)) continue;
        slots.push({ employee_id: employee.id, employee_name: employee.full_name, start: cursor.toISOString(), end: end.toISOString() });
      }
    }

    res.json({ duration_minutes: duration, slots: slots.slice(0, 200) });
  } catch (error: any) {
    res.status(500).json({ error: "A szabad időpontok lekérése sikertelen.", detail: error?.message || String(error) });
  }
});

router.post("/book", async (req, res) => {
  const locationId = String(req.body?.location_id || "").trim();
  const employeeId = String(req.body?.employee_id || "").trim();
  const serviceIds = Array.isArray(req.body?.service_ids) ? req.body.service_ids.map(String).filter(Boolean) : [];
  const fullName = String(req.body?.client_name || "").trim();
  const phone = String(req.body?.phone || "").trim();
  const email = String(req.body?.email || "").trim();
  const start = new Date(req.body?.start_time);
  const bookingSource = String(req.body?.booking_source || "online") === "voice" ? "online_voice" : "online";
  const requestedVoiceEventId=bookingSource==="online_voice"?String(req.body?.voice_event_id||"").trim():"";

  if (!locationId || !employeeId || !serviceIds.length || !fullName || (!phone && !email) || !Number.isFinite(start.getTime())) {
    return res.status(400).json({ error: "Hiányos foglalási adatok." });
  }
  if(requestedVoiceEventId&&!UUID_RE.test(requestedVoiceEventId))return res.status(400).json({error:"Érvénytelen Voice Booking eseményazonosító."});

  const cx = await db.connect();
  try {
    await ensureOnlineBooking();
    await ensureBookingWorkOrderSchema(cx);
    await cx.query("BEGIN");
    let voiceEventId:string|null=null;
    if(requestedVoiceEventId){
      const voice=await validateVoiceEvent(cx,requestedVoiceEventId,["book"]);
      if(!voice.ok){await cx.query("ROLLBACK");return res.status(voice.status).json({error:voice.error});}
      voiceEventId=voice.id;
    }

    const cfgResult = await cx.query(`SELECT * FROM online_booking_settings WHERE location_id=$1::uuid`, [locationId]);
    const cfg = cfgResult.rows[0] || { enabled: true, online_discount_percent: 5, require_staff_confirmation: true };
    if (!cfg.enabled) {
      await cx.query("ROLLBACK");
      return res.status(403).json({ error: "Az online foglalás ki van kapcsolva." });
    }

    const services = await cx.query(
      `SELECT s.id,s.name,COALESCE(s.duration_minutes,30)::int duration_minutes,
              COALESCE(s.promo_price,s.list_price,s.base_price,0)::numeric price
       FROM services s
       WHERE s.id=ANY($1::uuid[]) AND s.is_active=true AND COALESCE(s.online_bookable,true)=true
       ${serviceLocationClause}`,
      [serviceIds, locationId]
    );
    if (services.rows.length !== new Set(serviceIds).size) {
      await cx.query("ROLLBACK");
      return res.status(400).json({ error: "Egy vagy több szolgáltatás ezen a telephelyen nem foglalható." });
    }

    const employeeCheck = await cx.query(
      `SELECT e.id
       FROM employees e
       WHERE e.id=$1::uuid AND e.active=true
         AND (e.location_id=$2::uuid OR e.location_id IS NULL)
         AND (
           NOT EXISTS (SELECT 1 FROM employee_service_overrides eo0 WHERE eo0.employee_id=e.id)
           OR NOT EXISTS (
             SELECT 1 FROM unnest($3::uuid[]) AS sid(service_id)
             WHERE NOT EXISTS (
               SELECT 1 FROM employee_service_overrides eo
               WHERE eo.employee_id=e.id AND eo.service_id=sid.service_id
             )
           )
         )
       LIMIT 1`,
      [employeeId, locationId, serviceIds]
    );
    if (!employeeCheck.rows[0]) {
      await cx.query("ROLLBACK");
      return res.status(400).json({ error: "A kiválasztott szakember nem végez minden kiválasztott szolgáltatást ezen a telephelyen." });
    }

    const duration = services.rows.reduce((sum: number, x: any) => sum + Number(x.duration_minutes || 30), 0);
    const end = addMinutes(start, duration);

    const conflict = await cx.query(
      `SELECT id FROM appointments
       WHERE employee_id=$1::uuid AND status NOT IN ('cancelled','canceled','no_show')
         AND start_time<$3::timestamptz AND end_time>$2::timestamptz LIMIT 1`,
      [employeeId, start.toISOString(), end.toISOString()]
    );
    const breakConflict = await cx.query(
      `SELECT id FROM appointment_technical_breaks
       WHERE employee_id=$1::uuid AND start_time<$3::timestamptz AND end_time>$2::timestamptz LIMIT 1`,
      [employeeId, start.toISOString(), end.toISOString()]
    );
    if (conflict.rowCount || breakConflict.rowCount) {
      await cx.query("ROLLBACK");
      return res.status(409).json({ error: "Ez az időpont időközben foglalttá vált. Válasszon másikat." });
    }

    let client = await cx.query(
      `SELECT id FROM clients
       WHERE location_id=$1::uuid
         AND (($2<>'' AND regexp_replace(COALESCE(phone,''),'[^0-9]','','g')=regexp_replace($2,'[^0-9]','','g'))
           OR ($3<>'' AND lower(COALESCE(email,''))=lower($3)))
       ORDER BY updated_at DESC NULLS LAST LIMIT 1`,
      [locationId, phone, email]
    );
    let clientId = client.rows[0]?.id;
    if (!clientId) {
      client = await cx.query(
        `INSERT INTO clients(full_name,name,phone,email,location_id,marketing_consent,is_active,source,created_at,updated_at)
         VALUES($1,$1,$2,$3,$4::uuid,$5,true,$6,now(),now()) RETURNING id`,
        [fullName, phone || null, email || null, locationId, Boolean(req.body?.marketing_consent), bookingSource]
      );
      clientId = client.rows[0].id;
    }

    const token = crypto.randomUUID();
    const status = cfg.require_staff_confirmation ? "pending" : "confirmed";
    const title = services.rows.map((x: any) => x.name).join(", ");
    const appointment = await cx.query(
      `INSERT INTO appointments(employee_id,client_id,location_id,title,start_time,end_time,status,notes,booking_source,voice_event_id,cancellation_token,confirmation_required,confirmed_at,updated_at)
       VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5::timestamptz,$6::timestamptz,$7,$8,$9,$10::uuid,$11::uuid,$12,$13,now()) RETURNING id`,
      [employeeId, clientId, locationId, title, start.toISOString(), end.toISOString(), status, req.body?.note || "", bookingSource, voiceEventId, token, Boolean(cfg.require_staff_confirmation), cfg.require_staff_confirmation ? null : new Date().toISOString()]
    );

    for (let i = 0; i < services.rows.length; i += 1) {
      const service = services.rows[i];
      await cx.query(
        `INSERT INTO appointment_services(appointment_id,service_id,duration_minutes,price,discount_percent,sort_order)
         VALUES($1::uuid,$2::uuid,$3,$4,$5,$6)`,
        [appointment.rows[0].id, service.id, service.duration_minutes, service.price, Number(cfg.online_discount_percent || 0), i]
      );
    }

    await cx.query(
      `INSERT INTO appointment_change_log(appointment_id,action,actor_key,after_data,note)
       VALUES($1::uuid,$2,'public',$3::jsonb,$4)`,
      [appointment.rows[0].id, bookingSource === "online_voice" ? "voice_created" : "online_created", JSON.stringify({ status, start_time: start, end_time: end, employee_id: employeeId, booking_source: bookingSource, voice_event_id:voiceEventId }), bookingSource === "online_voice" ? "Hangalapú online foglalás" : "Online foglalás"]
    );
    const workOrder = await ensureBookingWorkOrder(cx, String(appointment.rows[0].id), "public");

    await cx.query("COMMIT");
    res.status(201).json({ id: appointment.rows[0].id, status, confirmation_required: Boolean(cfg.require_staff_confirmation), cancellation_token: token, online_discount_percent: Number(cfg.online_discount_percent || 0), booking_source: bookingSource, voice_event_id:voiceEventId, work_order_id: workOrder.work_order_id, work_order_number: workOrder.work_order_number });
  } catch (error: any) {
    await cx.query("ROLLBACK").catch(() => undefined);
    if(String(error?.code||"")==="23505"&&String(error?.constraint||"").includes("voice_event"))return res.status(409).json({error:"Ez a Voice Booking esemény már fel lett használva."});
    // A kliens ne kapjon téves hibát, ha egy adatbázis/proxy megszakadás után a
    // foglalás valójában már tartósan létrejött. Az ellenőrzés szándékosan az
    // időpont + munkatárs + telephely + vendég elérhetőség teljes egyezését kéri,
    // ezért más vendég foglalását soha nem tekinti sikeres ismétlésnek.
    try {
      const persisted = await db.query(
        `SELECT a.id::text,a.status,a.cancellation_token::text,
                a.work_order_id::text,a.work_order_number,
                COALESCE(obs.require_staff_confirmation,true) confirmation_required,
                COALESCE(obs.online_discount_percent,0)::numeric online_discount_percent
         FROM appointments a
         JOIN clients cl ON cl.id::text=(to_jsonb(a)->>'client_id')
         LEFT JOIN online_booking_settings obs ON obs.location_id::text=(to_jsonb(a)->>'location_id')
         WHERE a.location_id::text=$1 AND a.employee_id::text=$2
           AND a.start_time=$3::timestamptz
           AND lower(COALESCE(a.status,'')) NOT IN ('cancelled','canceled')
           AND (
             ($4<>'' AND regexp_replace(COALESCE(cl.phone,''),'[^0-9]','','g')=regexp_replace($4,'[^0-9]','','g'))
             OR ($5<>'' AND lower(COALESCE(cl.email,''))=lower($5))
           )
         ORDER BY a.updated_at DESC NULLS LAST LIMIT 1`,
        [locationId, employeeId, start.toISOString(), phone, email]
      );
      const recovered=persisted.rows[0];
      if(recovered){
        console.warn("[online-booking] recovered persisted booking after response failure",{appointment_id:recovered.id,error:error?.message||String(error)});
        return res.status(200).json({id:recovered.id,status:recovered.status,confirmation_required:Boolean(recovered.confirmation_required),cancellation_token:recovered.cancellation_token,online_discount_percent:Number(recovered.online_discount_percent||0),booking_source:bookingSource,voice_event_id:requestedVoiceEventId||null,work_order_id:recovered.work_order_id||null,work_order_number:recovered.work_order_number||null,recovered:true});
      }
    } catch (recoveryError:any) {
      console.error("[online-booking] persisted booking recovery failed",recoveryError?.message||recoveryError);
    }
    res.status(500).json({ error: "Az online foglalás mentése sikertelen.", detail: error?.message || String(error) });
  } finally {
    cx.release();
  }
});

router.post("/waitlist", async (req, res) => {
  const locationId = String(req.body?.location_id || "").trim();
  const name = String(req.body?.client_name || "").trim();
  const serviceIds = Array.isArray(req.body?.service_ids) ? req.body.service_ids.map(String).filter(Boolean) : [];
  const source=String(req.body?.booking_source||"online")==="voice"?"online_voice":"online";
  const requestedVoiceEventId=source==="online_voice"?String(req.body?.voice_event_id||"").trim():"";
  if (!locationId || !name || !serviceIds.length) return res.status(400).json({ error: "Telephely, név és szolgáltatás szükséges." });
  if(requestedVoiceEventId&&!UUID_RE.test(requestedVoiceEventId))return res.status(400).json({error:"Érvénytelen Voice Booking eseményazonosító."});
  const cx=await db.connect();
  try {
    await ensureOnlineBooking();
    await cx.query("BEGIN");
    let voiceEventId:string|null=null;
    if(requestedVoiceEventId){
      const voice=await validateVoiceEvent(cx,requestedVoiceEventId,["book","waitlist"]);
      if(!voice.ok){await cx.query("ROLLBACK");return res.status(voice.status).json({error:voice.error});}
      voiceEventId=voice.id;
    }
    const { rows } = await cx.query(
      `INSERT INTO booking_waitlist(location_id,client_name,phone,email,service_ids,preferred_employee_id,preferred_from,preferred_to,note,source,voice_event_id)
       VALUES($1::uuid,$2,$3,$4,$5::uuid[],$6::uuid,$7::timestamptz,$8::timestamptz,$9,$10,$11::uuid)
       RETURNING id,status,created_at,voice_event_id::text`,
      [locationId, name, req.body?.phone || null, req.body?.email || null, serviceIds, req.body?.employee_id || null, req.body?.preferred_from || null, req.body?.preferred_to || null, req.body?.note || null, source, voiceEventId]
    );
    await cx.query("COMMIT");
    res.status(201).json(rows[0]);
  } catch (error: any) {
    await cx.query("ROLLBACK").catch(()=>undefined);
    if(String(error?.code||"")==="23505"&&String(error?.constraint||"").includes("voice_event"))return res.status(409).json({error:"Ez a Voice Booking esemény már fel lett használva."});
    res.status(500).json({ error: "A várólista mentése sikertelen.", detail: error?.message || String(error) });
  } finally {cx.release();}
});

router.post("/cancel/:token", async (req, res) => {
  const cx=await db.connect();
  try {
    await ensureOnlineBooking();
    await ensureBookingWorkOrderSchema(cx);
    const reason = String(req.body?.reason || "Online lemondás").trim();
    await cx.query('BEGIN');
    const appointment=(await cx.query(`SELECT * FROM appointments WHERE cancellation_token=$1::uuid FOR UPDATE`,[req.params.token])).rows[0];
    if(!appointment||['cancelled','canceled','completed','paid'].includes(String(appointment.status||'').toLowerCase())){await cx.query('ROLLBACK');return res.status(404).json({ error: "A foglalás nem található vagy már nem mondható le." })}
    let workOrder:any=null;
    if(appointment.work_order_id){
      workOrder=(await cx.query(`SELECT * FROM work_orders WHERE id=$1::uuid FOR UPDATE`,[appointment.work_order_id])).rows[0]||null;
      if(workOrder?.locked_at||workOrder?.archived_at||['completed','cancelled','no_show'].includes(String(workOrder?.status||'').toLowerCase())){await cx.query('ROLLBACK');return res.status(409).json({error:'A kapcsolódó munkalap már lezárt; a lemondáshoz kérjük, vegye fel a kapcsolatot a szalonnal.'})}
      const paid=Number((await cx.query(`SELECT COALESCE(SUM(amount),0)::numeric total FROM work_order_payments WHERE work_order_id=$1`,[appointment.work_order_id])).rows[0]?.total||0);
      if(paid>0||workOrder?.financial_closed_at){await cx.query('ROLLBACK');return res.status(409).json({error:'A foglaláshoz már fizetés tartozik; online lemondás helyett kérjük, vegye fel a kapcsolatot a szalonnal.'})}
    }
    const updated=(await cx.query(`UPDATE appointments SET status='cancelled',cancellation_reason=$2,cancelled_at=now(),updated_at=now() WHERE id=$1::uuid RETURNING id`,[appointment.id,reason])).rows[0];
    if(workOrder)await cx.query(`UPDATE work_orders SET status='cancelled',status_updated_at=now(),updated_at=now() WHERE id=$1::uuid`,[workOrder.id]);
    await cx.query(`INSERT INTO appointment_change_log(appointment_id,action,actor_key,note) VALUES($1::uuid,'cancelled','public',$2)`, [appointment.id, reason]);
    await cx.query('COMMIT');
    res.json({ ok: true, id: updated.id, work_order_id: workOrder?.id||null });
  } catch (error: any) {
    await cx.query('ROLLBACK').catch(()=>undefined);
    res.status(500).json({ error: "A lemondás sikertelen.", detail: error?.message || String(error) });
  } finally {cx.release()}
});

export default router;
