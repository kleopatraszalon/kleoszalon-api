import { Router } from "express";
import db from "../db";

const router=Router();
const UUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

router.get("/rules",async(_req,res)=>{
  try{
    const {rows}=await db.query(`
      SELECT r.*,l.name location_name,s.name service_name,sl.name staff_level_name
      FROM booking_last_minute_rules r
      LEFT JOIN locations l ON l.id=r.location_id
      LEFT JOIN services s ON s.id=r.service_id
      LEFT JOIN booking_staff_levels sl ON sl.id=r.staff_level_id
      ORDER BY r.is_active DESC,r.created_at DESC`);
    res.json({rules:rows});
  }catch(error:any){res.status(500).json({error:"A Last Minute szabályok nem tölthetők be.",detail:error?.message||String(error)});}
});

router.post("/rules",async(req,res)=>{
  try{
    const locationId=String(req.body?.location_id||"").trim(),serviceId=String(req.body?.service_id||"").trim(),staffLevelId=String(req.body?.staff_level_id||"").trim();
    if(locationId&&!UUID_RE.test(locationId))return res.status(400).json({error:"Érvénytelen location_id."});
    if(serviceId&&!UUID_RE.test(serviceId))return res.status(400).json({error:"Érvénytelen service_id."});
    if(staffLevelId&&!UUID_RE.test(staffLevelId))return res.status(400).json({error:"Érvénytelen staff_level_id."});
    const threshold=Math.max(0,Math.min(100,Number(req.body?.free_capacity_threshold_percent??50)));
    const discount=Math.max(1,Math.min(100,Number(req.body?.discount_percent??20)));
    const validity=Math.max(1,Math.min(168,Number(req.body?.validity_hours??24)));
    const name=String(req.body?.name||"Automatikus Last Minute").trim()||"Automatikus Last Minute";
    const {rows}=await db.query(`INSERT INTO booking_last_minute_rules(name,location_id,service_id,staff_level_id,free_capacity_threshold_percent,discount_percent,validity_hours,same_day_only,is_active)
      VALUES($1,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,$8,$9) RETURNING *`,[name,locationId||null,serviceId||null,staffLevelId||null,threshold,discount,validity,req.body?.same_day_only!==false,req.body?.is_active!==false]);
    res.status(201).json(rows[0]);
  }catch(error:any){res.status(500).json({error:"A Last Minute szabály nem menthető.",detail:error?.message||String(error)});}
});

router.patch("/rules/:id",async(req,res)=>{
  try{
    const id=String(req.params.id||"");if(!UUID_RE.test(id))return res.status(400).json({error:"Érvénytelen szabályazonosító."});
    const {rows}=await db.query(`UPDATE booking_last_minute_rules SET
      name=COALESCE($2,name),free_capacity_threshold_percent=COALESCE($3,free_capacity_threshold_percent),
      discount_percent=COALESCE($4,discount_percent),validity_hours=COALESCE($5,validity_hours),
      same_day_only=COALESCE($6,same_day_only),is_active=COALESCE($7,is_active),updated_at=now()
      WHERE id=$1::uuid RETURNING *`,[id,req.body?.name??null,req.body?.free_capacity_threshold_percent??null,req.body?.discount_percent??null,req.body?.validity_hours??null,req.body?.same_day_only??null,req.body?.is_active??null]);
    if(!rows[0])return res.status(404).json({error:"A szabály nem található."});res.json(rows[0]);
  }catch(error:any){res.status(500).json({error:"A Last Minute szabály nem módosítható.",detail:error?.message||String(error)});}
});

router.post("/rebuild",async(req,res)=>{
  const date=String(req.body?.date||new Date().toISOString().slice(0,10));
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return res.status(400).json({error:"Érvénytelen dátum."});
  const locationFilter=String(req.body?.location_id||"").trim();
  if(locationFilter&&!UUID_RE.test(locationFilter))return res.status(400).json({error:"Érvénytelen location_id."});
  const cx=await db.connect();
  try{
    await cx.query("BEGIN");
    await cx.query(`UPDATE booking_last_minute_offers SET status='expired',updated_at=now() WHERE status='active' AND (expires_at<=now() OR start_time<=now())`);
    const {rows:rules}=await cx.query(`SELECT r.*,COALESCE(obs.opening_minute,480)::int opening_minute,COALESCE(obs.closing_minute,1200)::int closing_minute
      FROM booking_last_minute_rules r
      LEFT JOIN online_booking_settings obs ON obs.location_id=r.location_id
      WHERE r.is_active=true AND ($1::uuid IS NULL OR r.location_id=$1::uuid OR r.location_id IS NULL)`,[locationFilter||null]);
    let generated=0;
    for(const rule of rules){
      if(!rule.location_id||!rule.service_id)continue;
      const service=(await cx.query(`SELECT id,COALESCE(duration_minutes,30)::int duration_minutes,COALESCE(promo_price,list_price,base_price,0)::numeric price FROM services WHERE id=$1::uuid AND is_active=true AND COALESCE(online_bookable,true)=true`,[rule.service_id])).rows[0];
      if(!service)continue;
      const opening=Number(rule.opening_minute||480),closing=Number(rule.closing_minute||1200),workMinutes=Math.max(1,closing-opening);
      const employees=(await cx.query(`SELECT e.id,e.booking_staff_level_id FROM employees e WHERE e.active=true AND (e.location_id=$1::uuid OR e.location_id IS NULL) AND ($2::uuid IS NULL OR e.booking_staff_level_id=$2::uuid)`,[rule.location_id,rule.staff_level_id||null])).rows;
      for(const employee of employees){
        const busy=(await cx.query(`SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (LEAST(end_time,$4::timestamptz)-GREATEST(start_time,$3::timestamptz)))/60),0)::numeric busy_minutes FROM appointments WHERE employee_id=$1::uuid AND location_id=$2::uuid AND status NOT IN ('cancelled','canceled','no_show') AND start_time<$4::timestamptz AND end_time>$3::timestamptz`,[
          employee.id,rule.location_id,`${date}T${String(Math.floor(opening/60)).padStart(2,'0')}:${String(opening%60).padStart(2,'0')}:00`,`${date}T${String(Math.floor(closing/60)).padStart(2,'0')}:${String(closing%60).padStart(2,'0')}:00`
        ])).rows[0];
        const freePercent=100-(Number(busy?.busy_minutes||0)/workMinutes*100);
        if(freePercent<Number(rule.free_capacity_threshold_percent||50))continue;
        const starts=(await cx.query(`SELECT gs AS start_time,gs+($5||' minutes')::interval AS end_time FROM generate_series($3::timestamptz,$4::timestamptz-($5||' minutes')::interval,interval '15 minutes') gs
          WHERE gs>now() AND NOT EXISTS(SELECT 1 FROM appointments a WHERE a.employee_id=$1::uuid AND a.location_id=$2::uuid AND a.status NOT IN ('cancelled','canceled','no_show') AND a.start_time<gs+($5||' minutes')::interval AND a.end_time>gs)
          ORDER BY gs LIMIT 8`,[employee.id,rule.location_id,`${date}T${String(Math.floor(opening/60)).padStart(2,'0')}:${String(opening%60).padStart(2,'0')}:00`,`${date}T${String(Math.floor(closing/60)).padStart(2,'0')}:${String(closing%60).padStart(2,'0')}:00`,service.duration_minutes])).rows;
        for(const candidate of starts){
          const original=Number(service.price||0),offer=Math.max(0,Math.round(original*(1-Number(rule.discount_percent)/100)));
          const inserted=await cx.query(`INSERT INTO booking_last_minute_offers(rule_id,location_id,service_id,employee_id,start_time,end_time,original_price,offer_price,discount_percent,expires_at,status)
            VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,$8,$9,LEAST($5::timestamptz,now()+($10||' hours')::interval),'active')
            ON CONFLICT DO NOTHING RETURNING id`,[rule.id,rule.location_id,rule.service_id,employee.id,candidate.start_time,candidate.end_time,original,offer,rule.discount_percent,rule.validity_hours]);
          generated+=inserted.rowCount||0;
        }
      }
    }
    await cx.query("COMMIT");res.json({ok:true,date,generated});
  }catch(error:any){await cx.query("ROLLBACK");res.status(500).json({error:"A Last Minute ajánlatok generálása sikertelen.",detail:error?.message||String(error)});}finally{cx.release();}
});

router.get("/offers",async(req,res)=>{
  try{const {rows}=await db.query(`SELECT o.*,l.name location_name,s.name service_name,COALESCE(NULLIF(e.full_name,''),concat_ws(' ',e.last_name,e.first_name),'Munkatárs') employee_name FROM booking_last_minute_offers o JOIN locations l ON l.id=o.location_id JOIN services s ON s.id=o.service_id JOIN employees e ON e.id=o.employee_id ORDER BY o.start_time DESC LIMIT 300`);res.json({offers:rows});}
  catch(error:any){res.status(500).json({error:"A Last Minute ajánlatok nem tölthetők be.",detail:error?.message||String(error)});}
});

export default router;
