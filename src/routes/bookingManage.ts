import { Router } from "express";
import db from "../db";
import ensureOnlineBooking from "../booking/ensureOnlineBooking";
import { ensureBookingWorkOrderSchema } from "../services/bookingWorkOrder";
import { queueAppointmentCommunications } from "../booking/communications";

const router=Router();
const UUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const addMinutes=(date:Date,minutes:number)=>new Date(date.getTime()+minutes*60000);
const inactiveStatuses=new Set(["cancelled","canceled","no_show","completed","paid"]);

async function loadWorkOrder(cx:any,appointment:any,lock=false){
  const suffix=lock?" FOR UPDATE":"";
  const {rows}=await cx.query(`SELECT * FROM work_orders WHERE ($1::uuid IS NOT NULL AND id=$1::uuid) OR appointment_id=$2::uuid ORDER BY CASE WHEN id=$1::uuid THEN 0 ELSE 1 END LIMIT 1${suffix}`,[appointment.work_order_id||null,appointment.id]);
  return rows[0]||null;
}

async function assertMutableWorkOrder(cx:any,appointment:any){
  const wo=await loadWorkOrder(cx,appointment,true);if(!wo)return null;
  if(wo.locked_at||wo.archived_at||["completed","cancelled","no_show"].includes(String(wo.status||"").toLowerCase()))throw Object.assign(new Error("A kapcsolódó munkalap már lezárt; az időpont online nem módosítható."),{status:409});
  if(wo.financial_closed_at)throw Object.assign(new Error("A foglalás pénzügyileg már lezárt; online módosítás nem lehetséges."),{status:409});
  const paid=Number((await cx.query(`SELECT COALESCE(SUM(amount),0)::numeric total FROM work_order_payments WHERE work_order_id=$1::uuid`,[wo.id])).rows[0]?.total||0);
  if(paid>0)throw Object.assign(new Error("A foglaláshoz már fizetés tartozik; kérjük, egyeztessen a szalonnal."),{status:409});
  return wo;
}

router.get("/:token",async(req,res)=>{
  try{
    await ensureOnlineBooking();
    const token=String(req.params.token||"").trim();
    if(!UUID_RE.test(token))return res.status(404).json({error:"A foglalási hivatkozás érvénytelen."});
    const {rows}=await db.query(`SELECT a.id::text,a.location_id::text,a.employee_id::text,a.title,
      kleo_booking_utc(a.start_time) start_time,kleo_booking_utc(a.end_time) end_time,a.status,a.confirmation_required,
      COALESCE(l.name,'Kleopátra Szalon') location_name,COALESCE(e.full_name,'Szakember') employee_name,COALESCE(c.full_name,c.name,'Vendég') client_name,
      COALESCE((SELECT array_agg(aps.service_id::text ORDER BY aps.sort_order,aps.created_at) FROM appointment_services aps WHERE aps.appointment_id=a.id),ARRAY[]::text[]) service_ids,
      COALESCE((SELECT json_agg(json_build_object('id',aps.service_id::text,'name',COALESCE(s.name,'Szolgáltatás'),'duration_minutes',aps.duration_minutes,'price',aps.price) ORDER BY aps.sort_order,aps.created_at) FROM appointment_services aps LEFT JOIN services s ON s.id=aps.service_id WHERE aps.appointment_id=a.id),'[]'::json) services
      FROM appointments a LEFT JOIN locations l ON l.id=a.location_id LEFT JOIN employees e ON e.id=a.employee_id LEFT JOIN clients c ON c.id=a.client_id
      WHERE a.cancellation_token=$1::uuid LIMIT 1`,[token]);
    const a=rows[0];if(!a)return res.status(404).json({error:"A foglalás nem található."});
    const active=!inactiveStatuses.has(String(a.status||"").toLowerCase())&&new Date(a.end_time)>new Date();
    res.json({...a,can_reschedule:active,can_cancel:active,management_token_valid:true});
  }catch(error:any){console.error("GET booking manage:",error);res.status(500).json({error:"A foglalás adatai nem tölthetők be.",detail:error?.message||String(error)});}
});

router.post("/:token/reschedule",async(req,res)=>{
  const cx=await db.connect();
  try{
    await ensureOnlineBooking();await ensureBookingWorkOrderSchema(cx);await cx.query("BEGIN");
    const token=String(req.params.token||"").trim();if(!UUID_RE.test(token)){await cx.query("ROLLBACK");return res.status(404).json({error:"A foglalási hivatkozás érvénytelen."});}
    const appointment=(await cx.query(`SELECT a.*,kleo_booking_utc(a.start_time) booking_start_time,kleo_booking_utc(a.end_time) booking_end_time FROM appointments a WHERE cancellation_token=$1::uuid FOR UPDATE`,[token])).rows[0];
    if(!appointment){await cx.query("ROLLBACK");return res.status(404).json({error:"A foglalás nem található."});}
    if(inactiveStatuses.has(String(appointment.status||"").toLowerCase())||new Date(appointment.booking_end_time)<=new Date()){await cx.query("ROLLBACK");return res.status(409).json({error:"Ez az időpont már nem módosítható online."});}
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
    const before={start_time:appointment.booking_start_time,end_time:appointment.booking_end_time,employee_id:appointment.employee_id,status:appointment.status};
    const updated=(await cx.query(`UPDATE appointments SET employee_id=$2::uuid,start_time=$3::timestamptz,end_time=$4::timestamptz,status=$5,confirmation_required=$6,confirmed_at=$7::timestamptz,updated_at=now() WHERE id=$1::uuid RETURNING id,status,employee_id,confirmation_required,kleo_booking_utc(start_time) start_time,kleo_booking_utc(end_time) end_time`,[appointment.id,employeeId,start.toISOString(),end.toISOString(),nextStatus,Boolean(cfg.require_staff_confirmation),cfg.require_staff_confirmation?null:new Date().toISOString()])).rows[0];
    if(wo)await cx.query(`UPDATE work_orders SET employee_id=$2::uuid,updated_at=now() WHERE id=$1::uuid`,[wo.id,employeeId]);
    const after={start_time:updated.start_time,end_time:updated.end_time,employee_id:updated.employee_id,status:updated.status};
    await cx.query(`INSERT INTO appointment_change_log(appointment_id,action,actor_key,before_data,after_data,note) VALUES($1::uuid,'public_rescheduled','public-token',$2::jsonb,$3::jsonb,$4)`,[appointment.id,JSON.stringify(before),JSON.stringify(after),String(req.body?.note||"Vendég által nyilvános kezelőlinkről áthelyezve").slice(0,500)]);
    await cx.query("COMMIT");
    queueAppointmentCommunications(String(updated.id),"rescheduled").catch(error=>console.warn("public reschedule communication:",error?.message||String(error)));
    res.json({ok:true,id:String(updated.id),status:updated.status,start_time:updated.start_time,end_time:updated.end_time,employee_id:String(updated.employee_id),confirmation_required:Boolean(updated.confirmation_required)});
  }catch(error:any){await cx.query("ROLLBACK").catch(()=>undefined);if(error?.status)return res.status(error.status).json({error:error.message});console.error("POST booking manage reschedule:",error);res.status(500).json({error:"Az időpont módosítása sikertelen.",detail:error?.message||String(error)});}finally{cx.release()}
});

router.post("/:token/cancel",async(req,res)=>{
  const cx=await db.connect();
  try{
    await ensureOnlineBooking();await ensureBookingWorkOrderSchema(cx);await cx.query("BEGIN");
    const token=String(req.params.token||"").trim();if(!UUID_RE.test(token)){await cx.query("ROLLBACK");return res.status(404).json({error:"A foglalási hivatkozás érvénytelen."});}
    const appointment=(await cx.query(`SELECT a.*,kleo_booking_utc(a.start_time) booking_start_time FROM appointments a WHERE cancellation_token=$1::uuid FOR UPDATE`,[token])).rows[0];
    if(!appointment){await cx.query("ROLLBACK");return res.status(404).json({error:"A foglalás nem található."});}
    const currentStatus=String(appointment.status||"").toLowerCase();
    if(currentStatus==="cancelled"||currentStatus==="canceled"){
      await cx.query("COMMIT");
      return res.json({ok:true,id:String(appointment.id),status:"cancelled",idempotent:true});
    }
    if(inactiveStatuses.has(currentStatus)){await cx.query("ROLLBACK");return res.status(409).json({error:"A foglalás állapota miatt már nem mondható le."});}
    const wo=await assertMutableWorkOrder(cx,appointment);
    const reason=String(req.body?.reason||"Vendég által online lemondva").trim().slice(0,500)||"Vendég által online lemondva";
    const before={status:appointment.status,start_time:appointment.booking_start_time,employee_id:appointment.employee_id};
    const updated=(await cx.query(`UPDATE appointments SET status='cancelled',cancellation_reason=$2,cancelled_at=COALESCE(cancelled_at,now()),updated_at=now() WHERE id=$1::uuid RETURNING *`,[appointment.id,reason])).rows[0];
    if(wo)await cx.query(`UPDATE work_orders SET status='cancelled',status_updated_at=now(),updated_at=now() WHERE id=$1::uuid`,[wo.id]);
    await cx.query(`INSERT INTO appointment_change_log(appointment_id,action,actor_key,before_data,after_data,note) VALUES($1::uuid,'public_cancelled','public-token',$2::jsonb,$3::jsonb,$4)`,[appointment.id,JSON.stringify(before),JSON.stringify({status:updated.status,cancelled_at:updated.cancelled_at}),reason]);
    await cx.query("COMMIT");
    queueAppointmentCommunications(String(updated.id),"cancelled").catch(error=>console.warn("public cancel communication:",error?.message||String(error)));
    res.json({ok:true,id:String(updated.id),status:updated.status,idempotent:false});
  }catch(error:any){await cx.query("ROLLBACK").catch(()=>undefined);if(error?.status)return res.status(error.status).json({error:error.message});console.error("POST booking manage cancel:",error);res.status(500).json({error:"A lemondás sikertelen.",detail:error?.message||String(error)});}finally{cx.release()}
});

export default router;