import { Router } from "express";
import crypto from "crypto";
import db from "../db";

const router = Router();
const asUuidList=(value:unknown)=>String(value||"").split(",").map(x=>x.trim()).filter(Boolean);
const clamp=(n:number,min:number,max:number)=>Math.min(max,Math.max(min,n));
const dayStart=(date:string)=>new Date(`${date}T00:00:00`);
const addMinutes=(date:Date,minutes:number)=>new Date(date.getTime()+minutes*60000);

async function settings(locationId:string){
  const{rows}=await db.query(`SELECT * FROM online_booking_settings WHERE location_id=$1::uuid`,[locationId]);
  return rows[0]||{enabled:true,online_discount_percent:5,slot_interval_minutes:15,opening_minute:480,closing_minute:1200,booking_horizon_days:60,minimum_notice_minutes:60,require_staff_confirmation:true};
}

router.get("/catalog",async(req,res)=>{
  try{
    const locationId=String(req.query.location_id||"").trim();
    const locations=await db.query(`SELECT id,name FROM locations ORDER BY name`);
    if(!locationId)return res.json({locations:locations.rows,services:[],employees:[],settings:null});
    const[serviceRows,employeeRows,cfg]=await Promise.all([
      db.query(`SELECT s.id,s.name,COALESCE(s.duration_minutes,30)::int duration_minutes,
        COALESCE(s.promo_price,s.list_price,s.base_price,0)::numeric price,COALESCE(st.name,'Egyéb szolgáltatások') category_name
        FROM services s LEFT JOIN service_types st ON st.id=s.service_type_id
        WHERE s.is_active=true AND COALESCE(s.online_bookable,true)=true
          AND (NOT EXISTS(SELECT 1 FROM service_locations sl0 WHERE sl0.service_id=s.id)
               OR EXISTS(SELECT 1 FROM service_locations sl WHERE sl.service_id=s.id AND sl.location_id=$1::uuid))
        ORDER BY COALESCE(st.display_order,999999),st.name,s.name`,[locationId]),
      db.query(`SELECT id,COALESCE(NULLIF(full_name,''),NULLIF(concat_ws(' ',last_name,first_name),''),'Munkatárs') full_name,photo_url,color
        FROM employees WHERE active=true AND (location_id=$1::uuid OR location_id IS NULL)
        ORDER BY COALESCE(NULLIF(full_name,''),last_name,first_name,'')`,[locationId]),
      settings(locationId),
    ]);
    res.json({locations:locations.rows,services:serviceRows.rows,employees:employeeRows.rows,settings:cfg});
  }catch(error:any){res.status(500).json({error:"Az online foglalási adatok nem tölthetők be.",detail:error?.message||String(error)});}
});

router.get("/availability",async(req,res)=>{
  try{
    const locationId=String(req.query.location_id||"").trim(),date=String(req.query.date||"").trim(),serviceIds=asUuidList(req.query.service_ids),employeeId=String(req.query.employee_id||"").trim();
    if(!locationId||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!serviceIds.length)return res.status(400).json({error:"location_id, date és service_ids kötelező."});
    const cfg=await settings(locationId);if(!cfg.enabled)return res.status(403).json({error:"Az online foglalás ezen a telephelyen ki van kapcsolva."});
    const serviceResult=await db.query(`SELECT id,COALESCE(duration_minutes,30)::int duration_minutes FROM services WHERE id=ANY($1::uuid[]) AND is_active=true AND COALESCE(online_bookable,true)=true`,[serviceIds]);
    if(serviceResult.rows.length!==new Set(serviceIds).size)return res.status(400).json({error:"Egy vagy több szolgáltatás nem foglalható."});
    const duration=serviceResult.rows.reduce((sum:number,row:any)=>sum+Number(row.duration_minutes||30),0);
    const employees=await db.query(`SELECT id,COALESCE(NULLIF(full_name,''),NULLIF(concat_ws(' ',last_name,first_name),''),'Munkatárs') full_name FROM employees
      WHERE active=true AND (location_id=$1::uuid OR location_id IS NULL) AND ($2::uuid IS NULL OR id=$2::uuid)
      ORDER BY COALESCE(NULLIF(full_name,''),last_name,first_name,'')`,[locationId,employeeId||null]);
    if(!employees.rows.length)return res.json({duration_minutes:duration,slots:[]});
    const base=dayStart(date),from=addMinutes(base,clamp(Number(cfg.opening_minute||480),0,1439)),to=addMinutes(base,clamp(Number(cfg.closing_minute||1200),1,1440));
    const nowMin=new Date(Date.now()+Number(cfg.minimum_notice_minutes||0)*60000),horizon=new Date();horizon.setDate(horizon.getDate()+Number(cfg.booking_horizon_days||60));
    if(from>horizon)return res.json({duration_minutes:duration,slots:[]});
    const busy=await db.query(`SELECT employee_id,start_time,end_time FROM appointments
      WHERE location_id=$1::uuid AND employee_id=ANY($2::uuid[]) AND status NOT IN ('cancelled','canceled','no_show') AND start_time<$4::timestamptz AND end_time>$3::timestamptz
      UNION ALL SELECT employee_id,start_time,end_time FROM appointment_technical_breaks
      WHERE location_id=$1::uuid AND employee_id=ANY($2::uuid[]) AND start_time<$4::timestamptz AND end_time>$3::timestamptz`,[locationId,employees.rows.map((x:any)=>x.id),from.toISOString(),to.toISOString()]);
    const slots:any[]=[],step=Math.max(5,Number(cfg.slot_interval_minutes||15));
    for(const employee of employees.rows){const blocks=busy.rows.filter((x:any)=>String(x.employee_id)===String(employee.id));for(let cursor=new Date(from);cursor<to;cursor=addMinutes(cursor,step)){const end=addMinutes(cursor,duration);if(end>to||cursor<nowMin)continue;if(blocks.some((x:any)=>new Date(x.start_time)<end&&new Date(x.end_time)>cursor))continue;slots.push({employee_id:employee.id,employee_name:employee.full_name,start:cursor.toISOString(),end:end.toISOString()});}}
    res.json({duration_minutes:duration,slots:slots.slice(0,200)});
  }catch(error:any){res.status(500).json({error:"A szabad időpontok lekérése sikertelen.",detail:error?.message||String(error)});}
});

router.post("/book",async(req,res)=>{
  const locationId=String(req.body?.location_id||"").trim(),employeeId=String(req.body?.employee_id||"").trim(),serviceIds=Array.isArray(req.body?.service_ids)?req.body.service_ids.map(String).filter(Boolean):[],fullName=String(req.body?.client_name||"").trim(),phone=String(req.body?.phone||"").trim(),email=String(req.body?.email||"").trim(),start=new Date(req.body?.start_time);
  if(!locationId||!employeeId||!serviceIds.length||!fullName||(!phone&&!email)||!Number.isFinite(start.getTime()))return res.status(400).json({error:"Hiányos foglalási adatok."});
  const cx=await db.connect();
  try{
    await cx.query("BEGIN");
    const cfgResult=await cx.query(`SELECT * FROM online_booking_settings WHERE location_id=$1::uuid`,[locationId]),cfg=cfgResult.rows[0]||{enabled:true,online_discount_percent:5,require_staff_confirmation:true};
    if(!cfg.enabled){await cx.query("ROLLBACK");return res.status(403).json({error:"Az online foglalás ki van kapcsolva."});}
    const services=await cx.query(`SELECT id,name,COALESCE(duration_minutes,30)::int duration_minutes,COALESCE(promo_price,list_price,base_price,0)::numeric price FROM services WHERE id=ANY($1::uuid[]) AND is_active=true AND COALESCE(online_bookable,true)=true`,[serviceIds]);
    if(services.rows.length!==new Set(serviceIds).size){await cx.query("ROLLBACK");return res.status(400).json({error:"Egy vagy több szolgáltatás nem foglalható."});}
    const duration=services.rows.reduce((sum:number,x:any)=>sum+Number(x.duration_minutes||30),0),end=addMinutes(start,duration);
    const conflict=await cx.query(`SELECT id FROM appointments WHERE employee_id=$1::uuid AND status NOT IN ('cancelled','canceled','no_show') AND start_time<$3::timestamptz AND end_time>$2::timestamptz LIMIT 1`,[employeeId,start.toISOString(),end.toISOString()]);
    const breakConflict=await cx.query(`SELECT id FROM appointment_technical_breaks WHERE employee_id=$1::uuid AND start_time<$3::timestamptz AND end_time>$2::timestamptz LIMIT 1`,[employeeId,start.toISOString(),end.toISOString()]);
    if(conflict.rowCount||breakConflict.rowCount){await cx.query("ROLLBACK");return res.status(409).json({error:"Ez az időpont időközben foglalttá vált. Válasszon másikat."});}
    let client=await cx.query(`SELECT id FROM clients WHERE location_id=$1::uuid AND (($2<>'' AND regexp_replace(COALESCE(phone,''),'[^0-9]','','g')=regexp_replace($2,'[^0-9]','','g')) OR ($3<>'' AND lower(COALESCE(email,''))=lower($3))) ORDER BY updated_at DESC NULLS LAST LIMIT 1`,[locationId,phone,email]);
    let clientId=client.rows[0]?.id;
    if(!clientId){client=await cx.query(`INSERT INTO clients(full_name,name,phone,email,location_id,marketing_consent,is_active,source,created_at,updated_at) VALUES($1,$1,$2,$3,$4::uuid,$5,true,'online_booking',now(),now()) RETURNING id`,[fullName,phone||null,email||null,locationId,Boolean(req.body?.marketing_consent)]);clientId=client.rows[0].id;}
    const token=crypto.randomUUID(),status=cfg.require_staff_confirmation?"pending":"confirmed",title=services.rows.map((x:any)=>x.name).join(", ");
    const appointment=await cx.query(`INSERT INTO appointments(employee_id,client_id,location_id,title,start_time,end_time,status,notes,booking_source,cancellation_token,confirmation_required,confirmed_at,updated_at) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5::timestamptz,$6::timestamptz,$7,$8,'online',$9::uuid,$10,$11,now()) RETURNING id`,[employeeId,clientId,locationId,title,start.toISOString(),end.toISOString(),status,req.body?.note||"",token,Boolean(cfg.require_staff_confirmation),cfg.require_staff_confirmation?null:new Date().toISOString()]);
    for(let i=0;i<services.rows.length;i+=1){const service=services.rows[i];await cx.query(`INSERT INTO appointment_services(appointment_id,service_id,duration_minutes,price,discount_percent,sort_order) VALUES($1::uuid,$2::uuid,$3,$4,$5,$6)`,[appointment.rows[0].id,service.id,service.duration_minutes,service.price,Number(cfg.online_discount_percent||0),i]);}
    await cx.query(`INSERT INTO appointment_change_log(appointment_id,action,actor_key,after_data,note) VALUES($1::uuid,'online_created','public',$2::jsonb,$3)`,[appointment.rows[0].id,JSON.stringify({status,start_time:start,end_time:end,employee_id:employeeId}),"Online foglalás"]);
    await cx.query("COMMIT");res.status(201).json({id:appointment.rows[0].id,status,confirmation_required:Boolean(cfg.require_staff_confirmation),cancellation_token:token,online_discount_percent:Number(cfg.online_discount_percent||0)});
  }catch(error:any){await cx.query("ROLLBACK").catch(()=>undefined);res.status(500).json({error:"Az online foglalás mentése sikertelen.",detail:error?.message||String(error)});}finally{cx.release();}
});

router.post("/waitlist",async(req,res)=>{
  try{const locationId=String(req.body?.location_id||"").trim(),name=String(req.body?.client_name||"").trim(),serviceIds=Array.isArray(req.body?.service_ids)?req.body.service_ids.map(String).filter(Boolean):[];if(!locationId||!name||!serviceIds.length)return res.status(400).json({error:"Telephely, név és szolgáltatás szükséges."});const{rows}=await db.query(`INSERT INTO booking_waitlist(location_id,client_name,phone,email,service_ids,preferred_employee_id,preferred_from,preferred_to,note,source) VALUES($1::uuid,$2,$3,$4,$5::uuid[],$6::uuid,$7::timestamptz,$8::timestamptz,$9,'online') RETURNING id,status,created_at`,[locationId,name,req.body?.phone||null,req.body?.email||null,serviceIds,req.body?.employee_id||null,req.body?.preferred_from||null,req.body?.preferred_to||null,req.body?.note||null]);res.status(201).json(rows[0]);}
  catch(error:any){res.status(500).json({error:"A várólista mentése sikertelen.",detail:error?.message||String(error)});}
});

router.post("/cancel/:token",async(req,res)=>{
  try{const reason=String(req.body?.reason||"Online lemondás").trim();const{rows}=await db.query(`UPDATE appointments SET status='cancelled',cancellation_reason=$2,cancelled_at=now(),updated_at=now() WHERE cancellation_token=$1::uuid AND status NOT IN ('cancelled','canceled','completed','paid') RETURNING id`,[req.params.token,reason]);if(!rows[0])return res.status(404).json({error:"A foglalás nem található vagy már nem mondható le."});await db.query(`INSERT INTO appointment_change_log(appointment_id,action,actor_key,note) VALUES($1::uuid,'cancelled','public',$2)`,[rows[0].id,reason]);res.json({ok:true,id:rows[0].id});}
  catch(error:any){res.status(500).json({error:"A lemondás sikertelen.",detail:error?.message||String(error)});}
});

export default router;
