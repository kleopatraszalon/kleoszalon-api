import { Router, Request, Response, NextFunction } from "express";
import db from "../db";
import ensureOnlineBooking from "../booking/ensureOnlineBooking";

const router=Router();
const UUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const asUuidList=(value:unknown)=>String(value||"").split(",").map(x=>x.trim()).filter(Boolean);
const addMinutes=(date:Date,minutes:number)=>new Date(date.getTime()+minutes*60000);

async function config(locationId:string){
  await ensureOnlineBooking();
  const {rows}=await db.query(`SELECT * FROM online_booking_settings WHERE location_id=$1::uuid`,[locationId]);
  return rows[0]||{enabled:true,slot_interval_minutes:15,opening_minute:480,closing_minute:1200,booking_horizon_days:60,minimum_notice_minutes:60};
}
async function dayBounds(date:string,cfg:any){
  const {rows}=await db.query(`SELECT (($1::date+make_interval(mins=>$2::int)) AT TIME ZONE 'Europe/Budapest') starts_at,(($1::date+make_interval(mins=>$3::int)) AT TIME ZONE 'Europe/Budapest') ends_at`,[date,Number(cfg.opening_minute||480),Number(cfg.closing_minute||1200)]);
  return{from:new Date(rows[0].starts_at),to:new Date(rows[0].ends_at)};
}
async function hasWorkShifts(){return Boolean((await db.query(`SELECT to_regclass('public.work_shifts') IS NOT NULL ok`)).rows[0]?.ok);}

async function serviceDuration(serviceIds:string[],locationId:string){
  const result=await db.query(`SELECT s.id::text id,COALESCE(s.duration_minutes,30)::int duration_minutes FROM services s WHERE s.id=ANY($1::uuid[]) AND COALESCE(s.is_active,true)=true AND COALESCE(s.online_bookable,true)=true AND (NOT EXISTS(SELECT 1 FROM service_locations sl0 WHERE sl0.service_id=s.id) OR EXISTS(SELECT 1 FROM service_locations sl WHERE sl.service_id=s.id AND sl.location_id=$2::uuid))`,[serviceIds,locationId]);
  if(result.rows.length!==new Set(serviceIds).size)return null;
  return result.rows.reduce((sum:number,row:any)=>sum+Math.max(5,Number(row.duration_minutes||30)),0);
}

async function eligibleEmployees(locationId:string,employeeId:string,serviceIds:string[]){
  return (await db.query(`SELECT e.id::text id,COALESCE(NULLIF(e.full_name,''),NULLIF(concat_ws(' ',e.last_name,e.first_name),''),'Munkatárs') full_name FROM employees e WHERE COALESCE(e.active,true)=true AND (e.location_id=$1::uuid OR e.location_id IS NULL) AND ($2::uuid IS NULL OR e.id=$2::uuid) AND (NOT EXISTS(SELECT 1 FROM employee_service_overrides eo0 WHERE eo0.employee_id=e.id) OR NOT EXISTS(SELECT 1 FROM unnest($3::uuid[]) sid(service_id) WHERE NOT EXISTS(SELECT 1 FROM employee_service_overrides eo WHERE eo.employee_id=e.id AND eo.service_id=sid.service_id))) ORDER BY full_name`,[locationId,employeeId||null,serviceIds])).rows;
}

type Interval={from:Date;to:Date};
async function shiftIntervals(locationId:string,date:string,employeeIds:string[],fallback:Interval){
  if(!employeeIds.length||!(await hasWorkShifts()))return{source:"salon_hours_fallback",map:new Map<string,Interval[]>(employeeIds.map(id=>[id,[fallback]]))};
  const publishedCount=Number((await db.query(`SELECT count(*)::int count FROM work_shifts s JOIN employees e ON e.id=s.employee_id WHERE s.work_date=$1::date AND s.status='published' AND (s.location_id=$2::uuid OR (s.location_id IS NULL AND (e.location_id=$2::uuid OR e.location_id IS NULL)))`,[date,locationId])).rows[0]?.count||0);
  if(publishedCount<=0)return{source:"salon_hours_fallback",map:new Map<string,Interval[]>(employeeIds.map(id=>[id,[fallback]]))};
  const {rows}=await db.query(`SELECT s.employee_id::text employee_id,s.starts_at,s.ends_at FROM work_shifts s JOIN employees e ON e.id=s.employee_id WHERE s.work_date=$1::date AND s.status='published' AND s.employee_id=ANY($2::uuid[]) AND (s.location_id=$3::uuid OR (s.location_id IS NULL AND (e.location_id=$3::uuid OR e.location_id IS NULL))) ORDER BY s.employee_id,s.starts_at`,[date,employeeIds,locationId]);
  const map=new Map<string,Interval[]>();
  for(const row of rows){const id=String(row.employee_id),from=new Date(row.starts_at),to=new Date(row.ends_at);if(to<=from)continue;const clipped={from:from<fallback.from?fallback.from:from,to:to>fallback.to?fallback.to:to};if(clipped.to<=clipped.from)continue;const list=map.get(id)||[];list.push(clipped);map.set(id,list);}
  return{source:"published_shifts",map};
}

router.get("/availability",async(req:Request,res:Response)=>{
  try{
    const locationId=String(req.query.location_id||"").trim(),date=String(req.query.date||"").trim(),serviceIds=asUuidList(req.query.service_ids),employeeId=String(req.query.employee_id||"").trim();
    const excludeRaw=String(req.query.exclude_appointment_id||"").trim();
    if(excludeRaw&&!UUID_RE.test(excludeRaw))return res.status(400).json({error:"Érvénytelen exclude_appointment_id."});
    const excludeAppointmentId=excludeRaw||null;
    if(!locationId||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!serviceIds.length)return res.status(400).json({error:"location_id, date és service_ids kötelező."});
    const cfg=await config(locationId);if(cfg.enabled===false)return res.status(403).json({error:"Az online foglalás ezen a telephelyen ki van kapcsolva."});
    const duration=await serviceDuration(serviceIds,locationId);if(duration==null)return res.status(400).json({error:"Egy vagy több szolgáltatás ezen a telephelyen nem foglalható."});
    const employees=await eligibleEmployees(locationId,employeeId,serviceIds);if(!employees.length)return res.json({duration_minutes:duration,slots:[],schedule_source:"published_shifts"});
    const bounds=await dayBounds(date,cfg),horizon=new Date();horizon.setDate(horizon.getDate()+Number(cfg.booking_horizon_days||60));if(bounds.from>horizon)return res.json({duration_minutes:duration,slots:[],schedule_source:"outside_horizon"});
    const employeeIds=employees.map((x:any)=>String(x.id));const schedule=await shiftIntervals(locationId,date,employeeIds,bounds);
    const busy=(await db.query(`SELECT employee_id::text employee_id,start_time,end_time FROM appointments WHERE ($5::uuid IS NULL OR id<>$5::uuid) AND location_id=$1::uuid AND employee_id=ANY($2::uuid[]) AND status NOT IN('cancelled','canceled','no_show') AND start_time<$4::timestamptz AND end_time>$3::timestamptz UNION ALL SELECT employee_id::text employee_id,start_time,end_time FROM appointment_technical_breaks WHERE location_id=$1::uuid AND employee_id=ANY($2::uuid[]) AND start_time<$4::timestamptz AND end_time>$3::timestamptz`,[locationId,employeeIds,bounds.from.toISOString(),bounds.to.toISOString(),excludeAppointmentId])).rows;
    const busyMap=new Map<string,any[]>();for(const row of busy){const id=String(row.employee_id),list=busyMap.get(id)||[];list.push(row);busyMap.set(id,list);}
    const slots:any[]=[],step=Math.max(5,Number(cfg.slot_interval_minutes||15)),noticeAt=new Date(Date.now()+Number(cfg.minimum_notice_minutes||0)*60000);
    for(const employee of employees){const id=String(employee.id),blocks=busyMap.get(id)||[],intervals=schedule.map.get(id)||[];for(const interval of intervals){for(let cursor=new Date(interval.from);cursor<interval.to;cursor=addMinutes(cursor,step)){const end=addMinutes(cursor,duration);if(cursor<noticeAt||end>interval.to)continue;if(blocks.some((b:any)=>new Date(b.start_time)<end&&new Date(b.end_time)>cursor))continue;slots.push({employee_id:id,employee_name:employee.full_name,start:cursor.toISOString(),end:end.toISOString()});}}}
    return res.json({duration_minutes:duration,slots:slots.sort((a,b)=>a.start.localeCompare(b.start)||a.employee_name.localeCompare(b.employee_name,"hu")).slice(0,240),schedule_source:schedule.source,excludes_current_appointment:Boolean(excludeAppointmentId)});
  }catch(error:any){console.error("GET booking schedule availability:",error);return res.status(500).json({error:"A szabad időpontok lekérése sikertelen.",detail:error?.message||String(error)});}
});

async function validateBookSchedule(req:Request,res:Response,next:NextFunction){
  if(req.method!=="POST")return next();
  try{
    const locationId=String(req.body?.location_id||"").trim(),employeeId=String(req.body?.employee_id||"").trim(),serviceIds=Array.isArray(req.body?.service_ids)?req.body.service_ids.map(String).filter(Boolean):[],start=new Date(req.body?.start_time);
    if(!locationId||!employeeId||!serviceIds.length||!Number.isFinite(start.getTime()))return next();
    const cfg=await config(locationId),duration=await serviceDuration(serviceIds,locationId);if(duration==null)return next();const end=addMinutes(start,duration);
    const local=(await db.query(`SELECT to_char(($1::timestamptz AT TIME ZONE 'Europe/Budapest')::date,'YYYY-MM-DD') AS booking_day,EXTRACT(HOUR FROM ($1::timestamptz AT TIME ZONE 'Europe/Budapest'))::int*60+EXTRACT(MINUTE FROM ($1::timestamptz AT TIME ZONE 'Europe/Budapest'))::int AS start_min,to_char(($2::timestamptz AT TIME ZONE 'Europe/Budapest')::date,'YYYY-MM-DD') AS end_day,EXTRACT(HOUR FROM ($2::timestamptz AT TIME ZONE 'Europe/Budapest'))::int*60+EXTRACT(MINUTE FROM ($2::timestamptz AT TIME ZONE 'Europe/Budapest'))::int AS end_min`,[start.toISOString(),end.toISOString()])).rows[0];
    if(local.booking_day!==local.end_day||Number(local.start_min)<Number(cfg.opening_minute||480)||Number(local.end_min)>Number(cfg.closing_minute||1200))return res.status(409).json({error:"A kiválasztott időpont a szalon online foglalási nyitvatartásán kívül esik."});
    const noticeAt=new Date(Date.now()+Number(cfg.minimum_notice_minutes||0)*60000),horizon=new Date();horizon.setDate(horizon.getDate()+Number(cfg.booking_horizon_days||60));if(start<noticeAt||start>horizon)return res.status(409).json({error:"A kiválasztott időpont már nem esik az online foglalási időablakba."});
    if(await hasWorkShifts()){
      const published=(await db.query(`SELECT COUNT(*)::int count FROM work_shifts s JOIN employees e ON e.id=s.employee_id WHERE s.work_date=$1::date AND s.status='published' AND (s.location_id=$2::uuid OR (s.location_id IS NULL AND (e.location_id=$2::uuid OR e.location_id IS NULL)))`,[local.booking_day,locationId])).rows[0]?.count||0;
      if(Number(published)>0){const covering=(await db.query(`SELECT id FROM work_shifts WHERE employee_id=$1::uuid AND work_date=$2::date AND status='published' AND starts_at<=$3::timestamptz AND ends_at>=$4::timestamptz LIMIT 1`,[employeeId,local.booking_day,start.toISOString(),end.toISOString()])).rows[0];if(!covering)return res.status(409).json({error:"A szakember ebben az időpontban nincs közzétett munkaidő-beosztásban."});}
    }
    return next();
  }catch(error:any){console.error("booking schedule guard:",error);return res.status(500).json({error:"A munkaidő-beosztás ellenőrzése sikertelen.",detail:error?.message||String(error)});}
}
router.use("/book",validateBookSchedule);

export default router;
