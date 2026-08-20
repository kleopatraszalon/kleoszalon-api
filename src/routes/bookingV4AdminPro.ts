import { Router } from "express";
import db from "../db";
import ensureBookingV4 from "../booking/ensureBookingV4";
import ensureBookingV4Chain from "../booking/ensureBookingV4Chain";
import ensureOnlineBooking from "../booking/ensureOnlineBooking";
import bookingV4AutomationRouter from "./bookingV4Automation";

const router=Router();
const UUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const uuid=(v:unknown)=>{const s=String(v||"").trim();return UUID_RE.test(s)?s:null};
const bounded=(v:unknown,min:number,max:number,fallback:number)=>{const n=Number(v);return Number.isFinite(n)?Math.max(min,Math.min(max,n)):fallback};

router.use(async(_req,res,next)=>{try{await Promise.all([ensureBookingV4(),ensureBookingV4Chain(),ensureOnlineBooking()]);next()}catch(error:any){res.status(500).json({error:"A Booking 4.0 admin központ inicializálása sikertelen.",detail:error?.message||String(error)})}});
router.use("/automation",bookingV4AutomationRouter);

router.get("/overview",async(req,res)=>{
  try{
    const locationId=uuid(req.query.location_id);
    const days=Math.round(bounded(req.query.days,1,365,30));
    const [summary,byLocation,recent]=await Promise.all([
      db.query(`SELECT
        (SELECT count(*)::int FROM appointments a WHERE a.start_time::date=current_date AND lower(COALESCE(a.status,'')) NOT IN('cancelled','canceled') AND ($1::uuid IS NULL OR a.location_id=$1::uuid)) bookings_today,
        (SELECT count(*)::int FROM appointments a WHERE lower(COALESCE(a.status,''))='pending' AND ($1::uuid IS NULL OR a.location_id=$1::uuid)) pending_bookings,
        (SELECT count(*)::int FROM booking_chains c WHERE c.created_at>=now()-($2::text||' days')::interval AND ($1::uuid IS NULL OR c.location_id=$1::uuid)) chains_period,
        (SELECT COALESCE(sum(GREATEST(0,EXTRACT(EPOCH FROM(c.end_time-c.start_time))/60-c.total_gap_minutes)),0)::int FROM booking_chains c WHERE c.created_at>=now()-($2::text||' days')::interval AND ($1::uuid IS NULL OR c.location_id=$1::uuid)) chain_service_minutes,
        (SELECT count(*)::int FROM booking_coupon_campaigns WHERE is_active=true AND (valid_until IS NULL OR valid_until>=now())) active_coupons,
        (SELECT count(*)::int FROM booking_coupon_redemptions r JOIN appointments a ON a.id=r.appointment_id WHERE r.created_at>=now()-($2::text||' days')::interval AND ($1::uuid IS NULL OR a.location_id=$1::uuid)) coupon_redemptions,
        (SELECT COALESCE(sum(r.discount_amount),0)::numeric FROM booking_coupon_redemptions r JOIN appointments a ON a.id=r.appointment_id WHERE r.created_at>=now()-($2::text||' days')::interval AND ($1::uuid IS NULL OR a.location_id=$1::uuid)) coupon_discount_value,
        (SELECT count(*)::int FROM booking_last_minute_offers o WHERE o.status='active' AND o.expires_at>now() AND ($1::uuid IS NULL OR o.location_id=$1::uuid)) active_last_minute,
        (SELECT count(*)::int FROM booking_service_recommendations r WHERE r.is_active=true AND ($1::uuid IS NULL OR r.location_id=$1::uuid OR r.location_id IS NULL)) active_recommendations,
        (SELECT count(*)::int FROM employees e WHERE e.active=true AND e.booking_staff_level_id IS NOT NULL AND ($1::uuid IS NULL OR e.location_id=$1::uuid OR e.location_id IS NULL)) classified_staff,
        (SELECT count(*)::int FROM employees e WHERE e.active=true AND ($1::uuid IS NULL OR e.location_id=$1::uuid OR e.location_id IS NULL)) active_staff`,[locationId,days]),
      db.query(`SELECT l.id,l.name,
        count(DISTINCT a.id) FILTER(WHERE a.start_time>=now()-($2::text||' days')::interval AND lower(COALESCE(a.status,'')) NOT IN('cancelled','canceled'))::int bookings,
        count(DISTINCT c.id) FILTER(WHERE c.created_at>=now()-($2::text||' days')::interval)::int chains,
        count(DISTINCT o.id) FILTER(WHERE o.status='active' AND o.expires_at>now())::int active_offers
        FROM locations l LEFT JOIN appointments a ON a.location_id=l.id LEFT JOIN booking_chains c ON c.location_id=l.id LEFT JOIN booking_last_minute_offers o ON o.location_id=l.id
        WHERE COALESCE(l.is_active,true)=true AND ($1::uuid IS NULL OR l.id=$1::uuid)
        GROUP BY l.id,l.name ORDER BY l.name`,[locationId,days]),
      db.query(`SELECT a.id,a.start_time,a.end_time,a.status,a.booking_source,l.name location_name,
        COALESCE(NULLIF(btrim(cl.full_name),''),NULLIF(btrim(cl.name),''),'Vendég') client_name,
        COALESCE(NULLIF(btrim(e.full_name),''),NULLIF(btrim(concat_ws(' ',e.last_name,e.first_name)),''),'Munkatárs') employee_name,a.title
        FROM appointments a JOIN locations l ON l.id=a.location_id LEFT JOIN clients cl ON cl.id=a.client_id LEFT JOIN employees e ON e.id=a.employee_id
        WHERE a.start_time>=now()-interval '1 day' AND ($1::uuid IS NULL OR a.location_id=$1::uuid)
        ORDER BY a.start_time DESC LIMIT 12`,[locationId])
    ]);
    res.json({period_days:days,summary:summary.rows[0]||{},locations:byLocation.rows,recent_bookings:recent.rows});
  }catch(error:any){res.status(500).json({error:"A Booking 4.0 áttekintés nem tölthető be.",detail:error?.message||String(error)});}
});

router.get("/recommendations",async(req,res)=>{
  try{const locationId=uuid(req.query.location_id);const{rows}=await db.query(`SELECT r.id,r.source_service_id,r.recommended_service_id,r.location_id,r.priority,r.recommendation_type,r.label,r.discount_percent,r.is_active,
    s1.name source_service_name,s2.name recommended_service_name,l.name location_name
    FROM booking_service_recommendations r JOIN services s1 ON s1.id=r.source_service_id JOIN services s2 ON s2.id=r.recommended_service_id LEFT JOIN locations l ON l.id=r.location_id
    WHERE ($1::uuid IS NULL OR r.location_id=$1::uuid OR r.location_id IS NULL) ORDER BY r.is_active DESC,r.priority,s1.name,s2.name`,[locationId]);res.json({recommendations:rows})}catch(error:any){res.status(500).json({error:"Az ajánlások nem tölthetők be.",detail:error?.message||String(error)})}
});
router.post("/recommendations",async(req,res)=>{
  const source=uuid(req.body?.source_service_id),recommended=uuid(req.body?.recommended_service_id),locationId=uuid(req.body?.location_id);const type=String(req.body?.recommendation_type||"cross_sell");
  if(!source||!recommended||source===recommended||!["upsell","cross_sell","bundle"].includes(type))return res.status(400).json({error:"Érvényes forrás- és ajánlott szolgáltatás szükséges."});
  try{const{rows}=await db.query(`INSERT INTO booking_service_recommendations(source_service_id,recommended_service_id,location_id,priority,recommendation_type,label,discount_percent,is_active) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,true) RETURNING *`,[source,recommended,locationId,Math.round(bounded(req.body?.priority,1,999,100)),type,String(req.body?.label||"").trim()||null,req.body?.discount_percent==null||req.body?.discount_percent===""?null:bounded(req.body.discount_percent,0,100,0)]);res.status(201).json(rows[0])}catch(error:any){res.status(500).json({error:"Az ajánlás nem menthető.",detail:error?.message||String(error)})}
});
router.patch("/recommendations/:id",async(req,res)=>{const id=uuid(req.params.id);if(!id)return res.status(400).json({error:"Érvénytelen ajánlásazonosító."});try{const{rows}=await db.query(`UPDATE booking_service_recommendations SET priority=COALESCE($2,priority),label=COALESCE($3,label),discount_percent=COALESCE($4,discount_percent),is_active=COALESCE($5,is_active),updated_at=now() WHERE id=$1::uuid RETURNING *`,[id,req.body?.priority??null,req.body?.label??null,req.body?.discount_percent??null,req.body?.is_active??null]);if(!rows[0])return res.status(404).json({error:"Az ajánlás nem található."});res.json(rows[0])}catch(error:any){res.status(500).json({error:"Az ajánlás nem módosítható.",detail:error?.message||String(error)})}});

router.get("/staff-profiles",async(req,res)=>{try{const locationId=uuid(req.query.location_id);const{rows}=await db.query(`SELECT e.id,e.location_id,COALESCE(NULLIF(btrim(e.full_name),''),NULLIF(btrim(concat_ws(' ',e.last_name,e.first_name)),''),'Munkatárs') full_name,e.photo_url,e.public_bio,e.is_top_specialist,e.booking_staff_level_id,l.name location_name,sl.name staff_level_name,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('category_code',c.category_code,'category_name',c.category_name,'is_primary',c.is_primary) ORDER BY c.is_primary DESC,c.category_name) FROM employee_professional_categories c WHERE c.employee_id=e.id),'[]'::jsonb) categories,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id',p.id,'image_url',p.image_url,'caption',p.caption,'sort_order',p.sort_order) ORDER BY p.sort_order,p.created_at) FROM employee_reference_photos p WHERE p.employee_id=e.id AND p.is_active=true),'[]'::jsonb) reference_photos
  FROM employees e LEFT JOIN locations l ON l.id=e.location_id LEFT JOIN booking_staff_levels sl ON sl.id=e.booking_staff_level_id WHERE e.active=true AND ($1::uuid IS NULL OR e.location_id=$1::uuid OR e.location_id IS NULL) ORDER BY e.is_top_specialist DESC,full_name`,[locationId]);res.json({staff:rows})}catch(error:any){res.status(500).json({error:"A szakemberprofilok nem tölthetők be.",detail:error?.message||String(error)})}});
router.patch("/staff-profiles/:id",async(req,res)=>{const id=uuid(req.params.id);if(!id)return res.status(400).json({error:"Érvénytelen munkatársazonosító."});try{const{rows}=await db.query(`UPDATE employees SET public_bio=COALESCE($2,public_bio),is_top_specialist=COALESCE($3,is_top_specialist),booking_staff_level_id=COALESCE($4::uuid,booking_staff_level_id),updated_at=now() WHERE id=$1::uuid RETURNING id,public_bio,is_top_specialist,booking_staff_level_id`,[id,req.body?.public_bio??null,req.body?.is_top_specialist??null,uuid(req.body?.booking_staff_level_id)]);if(!rows[0])return res.status(404).json({error:"A munkatárs nem található."});res.json(rows[0])}catch(error:any){res.status(500).json({error:"A szakemberprofil nem módosítható.",detail:error?.message||String(error)})}});

router.get("/location-settings",async(_req,res)=>{try{const{rows}=await db.query(`SELECT l.id location_id,l.name location_name,COALESCE(s.enabled,true) enabled,COALESCE(s.opening_minute,480)::int opening_minute,COALESCE(s.closing_minute,1200)::int closing_minute,COALESCE(s.slot_interval_minutes,15)::int slot_interval_minutes,COALESCE(s.minimum_notice_minutes,60)::int minimum_notice_minutes,COALESCE(s.booking_horizon_days,60)::int booking_horizon_days,COALESCE(s.online_discount_percent,0)::numeric online_discount_percent,COALESCE(s.require_staff_confirmation,true) require_staff_confirmation FROM locations l LEFT JOIN online_booking_settings s ON s.location_id=l.id WHERE COALESCE(l.is_active,true)=true ORDER BY l.name`);res.json({settings:rows})}catch(error:any){res.status(500).json({error:"A szalonok foglalási beállításai nem tölthetők be.",detail:error?.message||String(error)})}});
router.put("/location-settings/:locationId",async(req,res)=>{const locationId=uuid(req.params.locationId);if(!locationId)return res.status(400).json({error:"Érvénytelen szalonazonosító."});const opening=Math.round(bounded(req.body?.opening_minute,0,1439,480)),closing=Math.round(bounded(req.body?.closing_minute,1,1440,1200));if(closing<=opening)return res.status(400).json({error:"A zárási időnek a nyitási idő után kell lennie."});try{const{rows}=await db.query(`INSERT INTO online_booking_settings(location_id,enabled,opening_minute,closing_minute,slot_interval_minutes,minimum_notice_minutes,booking_horizon_days,online_discount_percent,require_staff_confirmation,updated_at) VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,now()) ON CONFLICT(location_id) DO UPDATE SET enabled=EXCLUDED.enabled,opening_minute=EXCLUDED.opening_minute,closing_minute=EXCLUDED.closing_minute,slot_interval_minutes=EXCLUDED.slot_interval_minutes,minimum_notice_minutes=EXCLUDED.minimum_notice_minutes,booking_horizon_days=EXCLUDED.booking_horizon_days,online_discount_percent=EXCLUDED.online_discount_percent,require_staff_confirmation=EXCLUDED.require_staff_confirmation,updated_at=now() RETURNING *`,[locationId,req.body?.enabled!==false,opening,closing,Math.round(bounded(req.body?.slot_interval_minutes,5,120,15)),Math.round(bounded(req.body?.minimum_notice_minutes,0,10080,60)),Math.round(bounded(req.body?.booking_horizon_days,1,365,60)),bounded(req.body?.online_discount_percent,0,100,0),req.body?.require_staff_confirmation!==false]);res.json(rows[0])}catch(error:any){res.status(500).json({error:"A szalon foglalási beállításai nem menthetők.",detail:error?.message||String(error)})}});

router.post("/chains/:id/cancel",async(req,res)=>{const id=uuid(req.params.id);if(!id)return res.status(400).json({error:"Érvénytelen láncazonosító."});const reason=String(req.body?.reason||"Booking 4.0 admin lemondás").trim();const cx=await db.connect();try{await cx.query("BEGIN");const chain=(await cx.query(`SELECT id,status FROM booking_chains WHERE id=$1::uuid FOR UPDATE`,[id])).rows[0];if(!chain){await cx.query("ROLLBACK");return res.status(404).json({error:"A foglalási lánc nem található."});}if(chain.status==='cancelled'){await cx.query("ROLLBACK");return res.json({ok:true,already_cancelled:true});}const items=(await cx.query(`SELECT appointment_id FROM booking_chain_items WHERE chain_id=$1::uuid ORDER BY sequence_no`,[id])).rows;for(const item of items){await cx.query(`UPDATE appointments SET status='cancelled',notes=concat_ws(E'\n',NULLIF(notes,''),$2),updated_at=now() WHERE id=$1::uuid AND lower(COALESCE(status,'')) NOT IN('cancelled','canceled','completed')`,[item.appointment_id,reason]);await cx.query(`INSERT INTO appointment_change_log(appointment_id,action,actor_key,after_data,note) VALUES($1::uuid,'booking_v4_chain_cancelled','admin',$2::jsonb,$3)`,[item.appointment_id,JSON.stringify({chain_id:id,status:'cancelled'}),reason]);}await cx.query(`UPDATE booking_chains SET status='cancelled',updated_at=now() WHERE id=$1::uuid`,[id]);await cx.query("COMMIT");res.json({ok:true,chain_id:id,cancelled_appointments:items.length})}catch(error:any){await cx.query("ROLLBACK").catch(()=>undefined);res.status(500).json({error:"A foglalási lánc nem mondható le.",detail:error?.message||String(error)})}finally{cx.release()}});

export default router;