import { Router } from "express";
import db from "../db";
import ensureBookingV4 from "../booking/ensureBookingV4";

const router = Router();
const UUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const normCode=(v:unknown)=>String(v||"").trim().toUpperCase();
const asIds=(v:unknown)=>Array.isArray(v)?v.map(String).filter(Boolean):String(v||"").split(",").map(x=>x.trim()).filter(Boolean);

router.use(async(_req,res,next)=>{try{await ensureBookingV4();next()}catch(error:any){res.status(500).json({error:"A Booking 4.0 adatmodell inicializálása sikertelen.",detail:error?.message||String(error)})}});

router.get("/v4/pricelist",async(req,res)=>{
  try{
    const locationId=String(req.query.location_id||"").trim();
    if(locationId&&!UUID_RE.test(locationId))return res.status(400).json({error:"Érvénytelen location_id."});
    const [locationsResult,servicesResult]=await Promise.all([
      db.query(`SELECT id,name FROM locations WHERE COALESCE(is_active,true)=true ORDER BY name`),
      db.query(`
        SELECT s.id,s.name,COALESCE(s.duration_minutes,30)::int duration_minutes,
               COALESCE(st.name,'Egyéb') category_name,
               CASE
                 WHEN lower(COALESCE(st.name,'')||' '||s.name) ~ '(haj|fodr|balayage|melír|dauer)' THEN 'hair'
                 WHEN lower(COALESCE(st.name,'')||' '||s.name) ~ '(manik|pedik|köröm|gél ?lakk|kéz|láb)' THEN 'handsfeet'
                 WHEN lower(COALESCE(st.name,'')||' '||s.name) ~ '(masszázs|massage)' THEN 'massage'
                 ELSE 'beauty'
               END department_code,
               CASE
                 WHEN lower(COALESCE(st.name,'')||' '||s.name) ~ '(haj|fodr|balayage|melír|dauer)' THEN 'Fodrászat'
                 WHEN lower(COALESCE(st.name,'')||' '||s.name) ~ '(manik|pedik|köröm|gél ?lakk|kéz|láb)' THEN 'Kéz- és lábápolás'
                 WHEN lower(COALESCE(st.name,'')||' '||s.name) ~ '(masszázs|massage)' THEN 'Masszázs'
                 ELSE 'Kozmetika'
               END department_name,
               COALESCE(s.promo_price,s.list_price,s.base_price,0)::numeric base_price,
               COALESCE((
                 SELECT jsonb_object_agg(x.code,x.price)
                 FROM (
                   SELECT DISTINCT ON (lvl.code) lvl.code,p.price
                   FROM booking_service_prices_by_level p
                   JOIN booking_staff_levels lvl ON lvl.id=p.staff_level_id AND lvl.is_active=true
                   WHERE p.service_id=s.id AND p.is_active=true
                     AND ($1::uuid IS NULL OR p.location_id=$1::uuid OR p.location_id IS NULL)
                   ORDER BY lvl.code,(p.location_id=$1::uuid) DESC NULLS LAST,p.updated_at DESC
                 ) x
               ),'{}'::jsonb) level_prices
        FROM services s
        LEFT JOIN service_types st ON st.id=s.service_type_id
        WHERE COALESCE(s.is_active,true)=true AND COALESCE(s.online_bookable,true)=true
          AND ($1::uuid IS NULL OR NOT EXISTS(SELECT 1 FROM service_locations sl0 WHERE sl0.service_id=s.id)
               OR EXISTS(SELECT 1 FROM service_locations sl WHERE sl.service_id=s.id AND sl.location_id=$1::uuid))
        ORDER BY department_name,category_name,s.name`,[locationId||null])
    ]);
    const services=servicesResult.rows.map((row:any)=>({
      ...row,
      level_prices:{
        normal:Number(row.level_prices?.normal??row.base_price??0),
        top:row.level_prices?.top!=null?Number(row.level_prices.top):null,
        master:row.level_prices?.master!=null?Number(row.level_prices.master):null,
        trainee:row.level_prices?.trainee!=null?Number(row.level_prices.trainee):null,
      }
    }));
    res.json({locations:locationsResult.rows,services});
  }catch(error:any){res.status(500).json({error:"Az árlista nem tölthető be.",detail:error?.message||String(error)});}
});

router.get("/v4/last-minute",async(req,res)=>{
  try{
    const locationId=String(req.query.location_id||"").trim();
    if(locationId&&!UUID_RE.test(locationId))return res.status(400).json({error:"Érvénytelen location_id."});
    const {rows}=await db.query(`
      SELECT o.id,o.location_id,o.service_id,o.employee_id,o.start_time,o.end_time,
             o.original_price,o.offer_price,o.discount_percent,o.expires_at,
             l.name location_name,s.name service_name,
             COALESCE(NULLIF(btrim(e.full_name),''),NULLIF(btrim(concat_ws(' ',e.last_name,e.first_name)),''),'Munkatárs') employee_name,
             e.photo_url
      FROM booking_last_minute_offers o
      JOIN locations l ON l.id=o.location_id
      JOIN services s ON s.id=o.service_id
      JOIN employees e ON e.id=o.employee_id
      WHERE o.status='active' AND o.expires_at>now() AND o.start_time>now()
        AND ($1::uuid IS NULL OR o.location_id=$1::uuid)
      ORDER BY o.start_time ASC
      LIMIT 40`,[locationId||null]);
    res.json({offers:rows});
  }catch(error:any){res.status(500).json({error:"A Last Minute ajánlatok nem tölthetők be.",detail:error?.message||String(error)});}
});

router.get("/v4/staff",async(req,res)=>{
  try{
    const locationId=String(req.query.location_id||"").trim();
    const category=String(req.query.category||"").trim();
    const level=String(req.query.level||"").trim();
    if(locationId&&!UUID_RE.test(locationId))return res.status(400).json({error:"Érvénytelen location_id."});
    const {rows}=await db.query(`
      SELECT e.id,COALESCE(NULLIF(btrim(e.full_name),''),NULLIF(btrim(concat_ws(' ',e.last_name,e.first_name)),''),'Munkatárs') full_name,
             e.photo_url,e.public_bio,e.is_top_specialist,lvl.code staff_level_code,lvl.name staff_level_name,
             COALESCE((SELECT jsonb_agg(jsonb_build_object('code',c.category_code,'name',c.category_name,'primary',c.is_primary) ORDER BY c.is_primary DESC,c.category_name)
                       FROM employee_professional_categories c WHERE c.employee_id=e.id),'[]'::jsonb) categories,
             COALESCE((SELECT jsonb_agg(jsonb_build_object('url',p.image_url,'caption',p.caption) ORDER BY p.sort_order,p.created_at)
                       FROM employee_reference_photos p WHERE p.employee_id=e.id AND p.is_active=true),'[]'::jsonb) reference_photos
      FROM employees e
      LEFT JOIN booking_staff_levels lvl ON lvl.id=e.booking_staff_level_id
      WHERE e.active=true AND ($1::uuid IS NULL OR e.location_id=$1::uuid OR e.location_id IS NULL)
        AND ($2='' OR EXISTS(SELECT 1 FROM employee_professional_categories c WHERE c.employee_id=e.id AND (lower(c.category_code)=lower($2) OR lower(c.category_name)=lower($2))))
        AND ($3='' OR lower(COALESCE(lvl.code,''))=lower($3))
      ORDER BY e.is_top_specialist DESC,full_name`,[locationId||null,category,level]);
    res.json({staff:rows});
  }catch(error:any){res.status(500).json({error:"A szakemberek nem tölthetők be.",detail:error?.message||String(error)});}
});

router.post("/v4/coupon/validate",async(req,res)=>{
  try{
    const code=normCode(req.body?.code),locationId=String(req.body?.location_id||"").trim();
    const serviceIds=asIds(req.body?.service_ids),subtotal=Math.max(0,Number(req.body?.subtotal||0));
    if(!code)return res.status(400).json({valid:false,error:"Kuponkód szükséges."});
    if(locationId&&!UUID_RE.test(locationId))return res.status(400).json({valid:false,error:"Érvénytelen location_id."});
    if(serviceIds.some(id=>!UUID_RE.test(id)))return res.status(400).json({valid:false,error:"Érvénytelen szolgáltatásazonosító."});
    const {rows}=await db.query(`
      SELECT c.*,
        (NOT EXISTS(SELECT 1 FROM booking_coupon_locations cl WHERE cl.coupon_id=c.id)
          OR EXISTS(SELECT 1 FROM booking_coupon_locations cl WHERE cl.coupon_id=c.id AND cl.location_id=$2::uuid)) location_ok,
        (NOT EXISTS(SELECT 1 FROM booking_coupon_services cs WHERE cs.coupon_id=c.id)
          OR EXISTS(SELECT 1 FROM booking_coupon_services cs WHERE cs.coupon_id=c.id AND cs.service_id=ANY($3::uuid[]))) service_ok
      FROM booking_coupon_campaigns c
      WHERE upper(c.code)=upper($1) AND c.is_active=true
        AND (c.valid_from IS NULL OR c.valid_from<=now()) AND (c.valid_until IS NULL OR c.valid_until>=now())
      LIMIT 1`,[code,locationId||null,serviceIds]);
    const c=rows[0];
    if(!c)return res.status(404).json({valid:false,error:"A kupon nem található vagy lejárt."});
    if(!c.location_ok||!c.service_ok)return res.status(400).json({valid:false,error:"A kupon erre a foglalásra nem használható."});
    if(c.minimum_booking_value!=null&&subtotal<Number(c.minimum_booking_value))return res.status(400).json({valid:false,error:`A kupon minimum ${Number(c.minimum_booking_value).toLocaleString('hu-HU')} Ft foglalási értéktől érvényes.`});
    const discount=c.discount_type==='percent'?subtotal*(Number(c.discount_value)/100):Number(c.discount_value);
    const capped=Math.max(0,Math.min(subtotal,discount));
    res.json({valid:true,coupon_id:c.id,code:c.code,name:c.name,discount_type:c.discount_type,discount_value:Number(c.discount_value),discount_amount:Math.round(capped),total_after_discount:Math.max(0,Math.round(subtotal-capped)),combinable:Boolean(c.combinable),exclude_last_minute:Boolean(c.exclude_last_minute)});
  }catch(error:any){res.status(500).json({valid:false,error:"A kupon ellenőrzése sikertelen.",detail:error?.message||String(error)});}
});

router.post("/v4/booking-meta",async(req,res)=>{
  try{
    const appointmentId=String(req.body?.appointment_id||"").trim();
    if(!UUID_RE.test(appointmentId))return res.status(400).json({error:"Érvénytelen appointment_id."});
    const bookedForOther=Boolean(req.body?.booking_for_other);
    const guestName=String(req.body?.guest_name||"").trim(),guestPhone=String(req.body?.guest_phone||"").trim(),guestEmail=String(req.body?.guest_email||"").trim();
    const email=String(req.body?.email||"").trim(),phone=String(req.body?.phone||"").trim();
    const marketingConsent=Boolean(req.body?.marketing_consent);
    const exists=(await db.query(`SELECT id FROM appointments WHERE id=$1::uuid LIMIT 1`,[appointmentId])).rows[0];
    if(!exists)return res.status(404).json({error:"A foglalás nem található."});
    await db.query(`
      INSERT INTO booking_guest_beneficiaries(appointment_id,booked_for_other,guest_name,guest_phone,guest_email,relationship_label)
      VALUES($1::uuid,$2,$3,$4,$5,$6)
      ON CONFLICT(appointment_id) DO UPDATE SET booked_for_other=EXCLUDED.booked_for_other,guest_name=EXCLUDED.guest_name,
        guest_phone=EXCLUDED.guest_phone,guest_email=EXCLUDED.guest_email,relationship_label=EXCLUDED.relationship_label,updated_at=now()`,
      [appointmentId,bookedForOther,bookedForOther?guestName:null,bookedForOther?guestPhone:null,bookedForOther?guestEmail:null,String(req.body?.relationship_label||"").trim()||null]);
    await db.query(`INSERT INTO booking_marketing_consents(appointment_id,email,phone,channel,consented,consented_at)
      VALUES($1::uuid,$2,$3,'email',$4,CASE WHEN $4 THEN now() ELSE NULL END)`,[appointmentId,email||null,phone||null,marketingConsent]);
    res.json({ok:true,appointment_id:appointmentId,marketing_consent:marketingConsent});
  }catch(error:any){res.status(500).json({error:"A Booking 4.0 kiegészítő adatok mentése sikertelen.",detail:error?.message||String(error)});}
});

export default router;
