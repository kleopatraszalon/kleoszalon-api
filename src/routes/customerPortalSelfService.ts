import { Router, Response, NextFunction } from "express";
import db from "../db";
import { AuthRequest, requireAuth } from "../middleware/auth";
import { ensureCustomerPortal } from "../customerPortal/ensureCustomerPortal";

const router=Router();
const asyncRoute=(handler:(req:AuthRequest,res:Response)=>Promise<any>)=>(req:AuthRequest,res:Response,next:NextFunction)=>handler(req,res).catch(next);
const addMinutes=(date:Date,minutes:number)=>new Date(date.getTime()+minutes*60000);
const roleList=(raw:unknown)=>{
  if(Array.isArray(raw))return raw.map(String).map(x=>x.toLowerCase());
  const text=String(raw??"");
  try{const parsed=JSON.parse(text);if(Array.isArray(parsed))return parsed.map(String).map(x=>x.toLowerCase());}catch{}
  return text.split(",").map(x=>x.replace(/[\[\]"]/g,"").trim().toLowerCase()).filter(Boolean);
};
const isCustomer=(req:AuthRequest)=>roleList(req.user?.role).some(r=>["customer","client","guest","ugyfel","ügyfél","vendeg","vendég"].includes(r));

router.use(requireAuth);
router.use(async(_req,_res,next)=>{try{await ensureCustomerPortal();next();}catch(error){next(error)}});
router.use((req:AuthRequest,res,next)=>isCustomer(req)?next():res.status(403).json({error:"Ez a felület csak ügyfél belépéssel használható."}));

type Customer={id:string;full_name:string;email:string|null;phone:string|null;birth_date:string|null;city:string|null;address:string|null;preferred_contact:string|null;marketing_consent:boolean;location_id:string|null;location_name:string|null};
async function resolveCustomer(req:AuthRequest,cx:any=db):Promise<Customer|null>{
  const email=String(req.user?.email||"").trim();if(!email)return null;
  const{rows}=await cx.query(`SELECT c.id::text id,COALESCE(NULLIF(c.full_name,''),NULLIF(c.name,''),'Vendég') full_name,c.email,c.phone,c.birth_date,c.city,c.address,c.preferred_contact,COALESCE(c.marketing_consent,false) marketing_consent,c.location_id::text location_id,l.name location_name FROM clients c LEFT JOIN locations l ON l.id=c.location_id WHERE lower(COALESCE(c.email,''))=lower($1) ORDER BY c.updated_at DESC NULLS LAST,c.created_at DESC NULLS LAST LIMIT 1`,[email]);
  return rows[0]||null;
}
function actor(req:AuthRequest){return String(req.user?.id||req.user?.email||"customer");}
async function loadWorkOrder(cx:any,appointment:any){
  const{rows}=await cx.query(`SELECT * FROM work_orders WHERE ($1::uuid IS NOT NULL AND id=$1::uuid) OR appointment_id=$2::uuid ORDER BY CASE WHEN id=$1::uuid THEN 0 ELSE 1 END LIMIT 1 FOR UPDATE`,[appointment.work_order_id||null,appointment.id]);
  return rows[0]||null;
}
async function assertMutableWorkOrder(cx:any,appointment:any){
  const wo=await loadWorkOrder(cx,appointment);if(!wo)return null;
  if(wo.locked_at||wo.archived_at||["completed","cancelled","no_show"].includes(String(wo.status||"").toLowerCase()))throw Object.assign(new Error("A kapcsolódó munkalap már lezárt; az időpont nem módosítható online."),{status:409});
  if(wo.financial_closed_at)throw Object.assign(new Error("A foglalás pénzügyileg már lezárt; online módosítás nem lehetséges."),{status:409});
  const paid=Number((await cx.query(`SELECT COALESCE(SUM(amount),0)::numeric total FROM work_order_payments WHERE work_order_id=$1::uuid`,[wo.id])).rows[0]?.total||0);
  if(paid>0)throw Object.assign(new Error("A foglaláshoz már fizetés tartozik; kérjük, egyeztessen a szalonnal."),{status:409});
  return wo;
}

router.get("/self-service/profile",asyncRoute(async(req,res)=>{
  const customer=await resolveCustomer(req);if(!customer)return res.status(404).json({error:"A belépett fiókhoz nem található ügyféladatlap."});
  res.json({...customer,email_read_only:true});
}));

router.patch("/self-service/profile",asyncRoute(async(req,res)=>{
  const customer=await resolveCustomer(req);if(!customer)return res.status(404).json({error:"A belépett fiókhoz nem található ügyféladatlap."});
  const b=req.body||{};
  const preferred=String(b.preferred_contact??customer.preferred_contact??"email").trim().toLowerCase();
  if(!["email","sms","both"].includes(preferred))return res.status(400).json({error:"Az értesítési mód email, sms vagy both lehet."});
  const phone=b.phone===undefined?customer.phone:String(b.phone||"").trim()||null;
  if(["sms","both"].includes(preferred)&&!phone)return res.status(400).json({error:"SMS értesítéshez telefonszám szükséges."});
  const birth=b.birth_date===undefined?customer.birth_date:(String(b.birth_date||"").trim()||null);
  if(birth&&!/^\d{4}-\d{2}-\d{2}$/.test(birth))return res.status(400).json({error:"A születési dátum formátuma YYYY-MM-DD legyen."});
  const before={full_name:customer.full_name,phone:customer.phone,birth_date:customer.birth_date,city:customer.city,address:customer.address,preferred_contact:customer.preferred_contact,marketing_consent:customer.marketing_consent};
  const{rows}=await db.query(`UPDATE clients SET full_name=$2,name=$2,phone=$3,birth_date=$4::date,city=$5,address=$6,preferred_contact=$7,marketing_consent=$8,updated_at=now() WHERE id=$1::uuid RETURNING id::text,full_name,email,phone,birth_date,city,address,preferred_contact,marketing_consent,location_id::text`,[
    customer.id,String(b.full_name??customer.full_name).trim()||customer.full_name,phone,birth,b.city===undefined?customer.city:(String(b.city||"").trim()||null),b.address===undefined?customer.address:(String(b.address||"").trim()||null),preferred,b.marketing_consent===undefined?customer.marketing_consent:Boolean(b.marketing_consent)
  ]);
  const saved=rows[0];
  await db.query(`INSERT INTO customer_self_service_log(client_id,action,before_data,after_data,actor_user_id) VALUES($1::uuid,'profile_update',$2::jsonb,$3::jsonb,$4)`,[customer.id,JSON.stringify(before),JSON.stringify(saved),actor(req)]);
  res.json({...saved,email_read_only:true});
}));

router.get("/self-service/appointments",asyncRoute(async(req,res)=>{
  const customer=await resolveCustomer(req);if(!customer)return res.status(404).json({error:"A belépett fiókhoz nem található ügyféladatlap."});
  const{rows}=await db.query(`SELECT a.id::text,a.title,a.start_time,a.end_time,a.status,a.location_id::text,a.employee_id::text,COALESCE(e.full_name,'Szakember') employee_name,l.name location_name,
    COALESCE((SELECT array_agg(aps.service_id::text ORDER BY aps.sort_order,aps.created_at) FROM appointment_services aps WHERE aps.appointment_id=a.id),ARRAY[]::text[]) service_ids,
    COALESCE((SELECT json_agg(json_build_object('id',aps.service_id::text,'name',COALESCE(s.name,'Szolgáltatás'),'duration_minutes',aps.duration_minutes,'price',aps.price) ORDER BY aps.sort_order,aps.created_at) FROM appointment_services aps LEFT JOIN services s ON s.id=aps.service_id WHERE aps.appointment_id=a.id),'[]'::json) services
    FROM appointments a LEFT JOIN employees e ON e.id=a.employee_id LEFT JOIN locations l ON l.id=a.location_id
    WHERE a.client_id=$1::uuid AND a.start_time>=now()-interval '1 day' AND a.status NOT IN('cancelled','canceled','no_show','completed','paid') ORDER BY a.start_time LIMIT 30`,[customer.id]);
  res.json(rows);
}));

router.patch("/self-service/appointments/:id/reschedule",asyncRoute(async(req,res)=>{
  const cx=await db.connect();
  try{
    await cx.query("BEGIN");
    const customer=await resolveCustomer(req,cx);if(!customer){await cx.query("ROLLBACK");return res.status(404).json({error:"A belépett fiókhoz nem található ügyféladatlap."});}
    const appointment=(await cx.query(`SELECT * FROM appointments WHERE id=$1::uuid AND client_id=$2::uuid FOR UPDATE`,[req.params.id,customer.id])).rows[0];
    if(!appointment){await cx.query("ROLLBACK");return res.status(404).json({error:"Az időpont nem található."});}
    if(["cancelled","canceled","no_show","completed","paid"].includes(String(appointment.status||"").toLowerCase())){await cx.query("ROLLBACK");return res.status(409).json({error:"Ez az időpont már nem módosítható."});}
    const wo=await assertMutableWorkOrder(cx,appointment);
    const serviceRows=(await cx.query(`SELECT service_id::text service_id,duration_minutes,price FROM appointment_services WHERE appointment_id=$1::uuid ORDER BY sort_order,created_at`,[appointment.id])).rows;
    if(!serviceRows.length){await cx.query("ROLLBACK");return res.status(409).json({error:"A foglalás szolgáltatáslistája hiányos; kérjük, egyeztessen a szalonnal."});}
    const serviceIds=serviceRows.map((x:any)=>String(x.service_id));
    const employeeId=String(req.body?.employee_id||appointment.employee_id||"").trim();
    const start=new Date(req.body?.start_time);if(!employeeId||!Number.isFinite(start.getTime())){await cx.query("ROLLBACK");return res.status(400).json({error:"Szakember és érvényes új kezdési időpont szükséges."});}
    const duration=serviceRows.reduce((sum:number,x:any)=>sum+Math.max(5,Number(x.duration_minutes||30)),0),end=addMinutes(start,duration);
    const cfg=(await cx.query(`SELECT * FROM online_booking_settings WHERE location_id=$1::uuid`,[appointment.location_id])).rows[0]||{enabled:true,opening_minute:480,closing_minute:1200,booking_horizon_days:60,minimum_notice_minutes:60,require_staff_confirmation:true};
    if(cfg.enabled===false){await cx.query("ROLLBACK");return res.status(403).json({error:"Az online időpontmódosítás ezen a szalonban ki van kapcsolva."});}
    const noticeAt=new Date(Date.now()+Number(cfg.minimum_notice_minutes||0)*60000),horizon=new Date();horizon.setDate(horizon.getDate()+Number(cfg.booking_horizon_days||60));
    if(start<noticeAt||start>horizon){await cx.query("ROLLBACK");return res.status(409).json({error:"Az új időpont nem esik az online módosítási időablakba."});}
    const local=(await cx.query(`SELECT to_char(($1::timestamptz AT TIME ZONE 'Europe/Budapest')::date,'YYYY-MM-DD') AS booking_day,EXTRACT(HOUR FROM ($1::timestamptz AT TIME ZONE 'Europe/Budapest'))::int*60+EXTRACT(MINUTE FROM ($1::timestamptz AT TIME ZONE 'Europe/Budapest'))::int AS start_min,to_char(($2::timestamptz AT TIME ZONE 'Europe/Budapest')::date,'YYYY-MM-DD') AS end_day,EXTRACT(HOUR FROM ($2::timestamptz AT TIME ZONE 'Europe/Budapest'))::int*60+EXTRACT(MINUTE FROM ($2::timestamptz AT TIME ZONE 'Europe/Budapest'))::int AS end_min`,[start.toISOString(),end.toISOString()])).rows[0];
    if(local.booking_day!==local.end_day||Number(local.start_min)<Number(cfg.opening_minute||480)||Number(local.end_min)>Number(cfg.closing_minute||1200)){await cx.query("ROLLBACK");return res.status(409).json({error:"Az új időpont a szalon online foglalási nyitvatartásán kívül esik."});}
    const employee=(await cx.query(`SELECT e.id FROM employees e WHERE e.id=$1::uuid AND COALESCE(e.active,true)=true AND (e.location_id=$2::uuid OR e.location_id IS NULL) AND (NOT EXISTS(SELECT 1 FROM employee_service_overrides eo0 WHERE eo0.employee_id=e.id) OR NOT EXISTS(SELECT 1 FROM unnest($3::uuid[]) sid(service_id) WHERE NOT EXISTS(SELECT 1 FROM employee_service_overrides eo WHERE eo.employee_id=e.id AND eo.service_id=sid.service_id))) LIMIT 1`,[employeeId,appointment.location_id,serviceIds])).rows[0];
    if(!employee){await cx.query("ROLLBACK");return res.status(400).json({error:"A kiválasztott szakember nem végez minden foglalt szolgáltatást ebben a szalonban."});}
    const published=Number((await cx.query(`SELECT COUNT(*)::int count FROM work_shifts s JOIN employees e ON e.id=s.employee_id WHERE s.work_date=$1::date AND s.status='published' AND (s.location_id=$2::uuid OR (s.location_id IS NULL AND (e.location_id=$2::uuid OR e.location_id IS NULL)))`,[local.booking_day,appointment.location_id])).rows[0]?.count||0);
    if(published>0){const covering=(await cx.query(`SELECT id FROM work_shifts WHERE employee_id=$1::uuid AND work_date=$2::date AND status='published' AND starts_at<=$3::timestamptz AND ends_at>=$4::timestamptz LIMIT 1`,[employeeId,local.booking_day,start.toISOString(),end.toISOString()])).rows[0];if(!covering){await cx.query("ROLLBACK");return res.status(409).json({error:"A szakember ebben az időpontban nincs közzétett munkaidő-beosztásban."});}}
    const conflict=(await cx.query(`SELECT id FROM appointments WHERE id<>$1::uuid AND employee_id=$2::uuid AND status NOT IN('cancelled','canceled','no_show') AND start_time<$4::timestamptz AND end_time>$3::timestamptz LIMIT 1`,[appointment.id,employeeId,start.toISOString(),end.toISOString()])).rows[0];
    const breakConflict=(await cx.query(`SELECT id FROM appointment_technical_breaks WHERE employee_id=$1::uuid AND start_time<$3::timestamptz AND end_time>$2::timestamptz LIMIT 1`,[employeeId,start.toISOString(),end.toISOString()])).rows[0];
    if(conflict||breakConflict){await cx.query("ROLLBACK");return res.status(409).json({error:"Ez az időpont időközben foglalttá vált. Válasszon másikat."});}
    const nextStatus=cfg.require_staff_confirmation?"pending":"confirmed";
    const before={start_time:appointment.start_time,end_time:appointment.end_time,employee_id:appointment.employee_id,status:appointment.status};
    const updated=(await cx.query(`UPDATE appointments SET employee_id=$2::uuid,start_time=$3::timestamptz,end_time=$4::timestamptz,status=$5,confirmation_required=$6,confirmed_at=$7::timestamptz,updated_at=now() WHERE id=$1::uuid RETURNING *`,[appointment.id,employeeId,start.toISOString(),end.toISOString(),nextStatus,Boolean(cfg.require_staff_confirmation),cfg.require_staff_confirmation?null:new Date().toISOString()])).rows[0];
    if(wo)await cx.query(`UPDATE work_orders SET employee_id=$2::uuid,updated_at=now() WHERE id=$1::uuid`,[wo.id,employeeId]);
    const after={start_time:updated.start_time,end_time:updated.end_time,employee_id:updated.employee_id,status:updated.status};
    await cx.query(`INSERT INTO appointment_change_log(appointment_id,action,actor_key,before_data,after_data,note) VALUES($1::uuid,'customer_rescheduled',$2,$3::jsonb,$4::jsonb,$5)`,[appointment.id,`customer:${customer.id}`,JSON.stringify(before),JSON.stringify(after),String(req.body?.note||"Ügyfél által online áthelyezve")]);
    await cx.query(`INSERT INTO customer_self_service_log(client_id,appointment_id,action,before_data,after_data,note,actor_user_id) VALUES($1::uuid,$2::uuid,'appointment_reschedule',$3::jsonb,$4::jsonb,$5,$6)`,[customer.id,appointment.id,JSON.stringify(before),JSON.stringify(after),String(req.body?.note||"Ügyfél által online áthelyezve"),actor(req)]);
    await cx.query("COMMIT");
    res.json({ok:true,id:String(updated.id),status:updated.status,start_time:updated.start_time,end_time:updated.end_time,employee_id:String(updated.employee_id),confirmation_required:Boolean(updated.confirmation_required)});
  }catch(error:any){await cx.query("ROLLBACK").catch(()=>undefined);if(error?.status)return res.status(error.status).json({error:error.message});throw error}finally{cx.release()}
}));

router.post("/self-service/appointments/:id/cancel",asyncRoute(async(req,res)=>{
  const cx=await db.connect();
  try{
    await cx.query("BEGIN");
    const customer=await resolveCustomer(req,cx);if(!customer){await cx.query("ROLLBACK");return res.status(404).json({error:"A belépett fiókhoz nem található ügyféladatlap."});}
    const appointment=(await cx.query(`SELECT * FROM appointments WHERE id=$1::uuid AND client_id=$2::uuid FOR UPDATE`,[req.params.id,customer.id])).rows[0];
    if(!appointment){await cx.query("ROLLBACK");return res.status(404).json({error:"Az időpont nem található."});}
    if(["cancelled","canceled","completed","paid","no_show"].includes(String(appointment.status||"").toLowerCase())){await cx.query("ROLLBACK");return res.status(409).json({error:"Ez az időpont már nem mondható le online."});}
    const wo=await assertMutableWorkOrder(cx,appointment);
    const reason=String(req.body?.reason||"Ügyfél által online lemondva").trim().slice(0,500)||"Ügyfél által online lemondva";
    const before={status:appointment.status,start_time:appointment.start_time,employee_id:appointment.employee_id};
    const updated=(await cx.query(`UPDATE appointments SET status='cancelled',cancellation_reason=$2,cancelled_at=now(),updated_at=now() WHERE id=$1::uuid RETURNING *`,[appointment.id,reason])).rows[0];
    if(wo)await cx.query(`UPDATE work_orders SET status='cancelled',status_updated_at=now(),updated_at=now() WHERE id=$1::uuid`,[wo.id]);
    const after={status:updated.status,cancelled_at:updated.cancelled_at,cancellation_reason:updated.cancellation_reason};
    await cx.query(`INSERT INTO appointment_change_log(appointment_id,action,actor_key,before_data,after_data,note) VALUES($1::uuid,'customer_cancelled',$2,$3::jsonb,$4::jsonb,$5)`,[appointment.id,`customer:${customer.id}`,JSON.stringify(before),JSON.stringify(after),reason]);
    await cx.query(`INSERT INTO customer_self_service_log(client_id,appointment_id,action,before_data,after_data,note,actor_user_id) VALUES($1::uuid,$2::uuid,'appointment_cancel',$3::jsonb,$4::jsonb,$5,$6)`,[customer.id,appointment.id,JSON.stringify(before),JSON.stringify(after),reason,actor(req)]);
    await cx.query("COMMIT");
    res.json({ok:true,id:String(updated.id),status:updated.status});
  }catch(error:any){await cx.query("ROLLBACK").catch(()=>undefined);if(error?.status)return res.status(error.status).json({error:error.message});throw error}finally{cx.release()}
}));

export default router;
