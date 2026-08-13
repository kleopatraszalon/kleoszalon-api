import {Router} from "express";
import db from "../db";
import {requireAuth,AuthRequest} from "../middleware/auth";
import {ensureBookingWorkOrder,ensureBookingWorkOrderSchema} from "../services/bookingWorkOrder";

const router=Router();
router.use(requireAuth);
const ACTIVE_STATUSES=['waiting','pending','booked','confirmed','arrived','in_progress','paid'];
const UUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const actor=(req:AuthRequest)=>req.user?.email||String(req.user?.id||'unknown');
const roles=(req:AuthRequest)=>{const raw:any=req.user?.role;if(Array.isArray(raw))return raw.map(String).map(x=>x.toLowerCase());try{const a=JSON.parse(String(raw||''));if(Array.isArray(a))return a.map(String).map(x=>x.toLowerCase())}catch{}return String(raw||'').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean)};
const MANAGERS=new Set(['admin','administrator','rendszergazda','superadmin','super_admin','location_manager','salon_manager','szalonvezető','szalonvezeto','üzletvezető','uzletvezeto','store_manager','branch_manager']);
const requireManager=(req:AuthRequest,res:any,next:any)=>roles(req).some(x=>MANAGERS.has(x))?next():res.status(403).json({error:'Erőforrás-beállítást csak adminisztrátor vagy vezető módosíthat.'});
const groupKey=(v:any)=>String(v||'').trim().toLocaleLowerCase('hu-HU').replace(/[^a-z0-9áéíóöőúüű_-]+/gi,'-').replace(/^-+|-+$/g,'').slice(0,80);

async function ensureSchema(cx:any=db){
 await cx.query(`
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE TABLE IF NOT EXISTS booking_resources(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    name text NOT NULL,resource_group text NOT NULL,resource_type text NOT NULL DEFAULT 'other',note text,
    active boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS booking_resources_location_group_idx ON booking_resources(location_id,resource_group,active);
  CREATE UNIQUE INDEX IF NOT EXISTS booking_resources_name_uq ON booking_resources(location_id,lower(name)) WHERE active=true;

  CREATE TABLE IF NOT EXISTS service_resource_requirements(
    service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,resource_group text NOT NULL,
    quantity integer NOT NULL DEFAULT 1 CHECK(quantity>0 AND quantity<=20),note text,
    PRIMARY KEY(service_id,resource_group)
  );

  CREATE TABLE IF NOT EXISTS appointment_staff_assignments(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),appointment_id uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
    service_id uuid REFERENCES services(id) ON DELETE SET NULL,employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
    start_time timestamptz NOT NULL,end_time timestamptz NOT NULL,is_primary boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),CHECK(end_time>start_time)
  );
  CREATE INDEX IF NOT EXISTS appointment_staff_assignments_employee_time_idx ON appointment_staff_assignments(employee_id,start_time,end_time);
  CREATE INDEX IF NOT EXISTS appointment_staff_assignments_appointment_idx ON appointment_staff_assignments(appointment_id);

  CREATE TABLE IF NOT EXISTS appointment_resource_allocations(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),appointment_id uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
    service_id uuid REFERENCES services(id) ON DELETE SET NULL,resource_id uuid NOT NULL REFERENCES booking_resources(id) ON DELETE RESTRICT,
    start_time timestamptz NOT NULL,end_time timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),CHECK(end_time>start_time)
  );
  CREATE INDEX IF NOT EXISTS appointment_resource_allocations_resource_time_idx ON appointment_resource_allocations(resource_id,start_time,end_time);
  CREATE INDEX IF NOT EXISTS appointment_resource_allocations_appointment_idx ON appointment_resource_allocations(appointment_id);

  CREATE TABLE IF NOT EXISTS appointment_change_log(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),appointment_id uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
    action text NOT NULL,actor_key text,before_data jsonb,after_data jsonb,note text,created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS appointment_services(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),appointment_id uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
    service_id uuid NOT NULL REFERENCES services(id),duration_minutes integer NOT NULL DEFAULT 30,price numeric(12,2) NOT NULL DEFAULT 0,
    discount_percent numeric(5,2) NOT NULL DEFAULT 0,sort_order integer NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now()
  );
  ALTER TABLE appointment_services ADD COLUMN IF NOT EXISTS assigned_employee_id uuid;
  ALTER TABLE appointment_services ADD COLUMN IF NOT EXISTS scheduled_start_time timestamptz;
  ALTER TABLE appointment_services ADD COLUMN IF NOT EXISTS scheduled_end_time timestamptz;
 `);
}
router.use(async(_req,_res,next)=>{try{await ensureSchema();next()}catch(e){next(e)}});

type RequestedService={service_id:string;employee_id:string;resource_ids?:string[]};
type PlannedService={service_id:string;service_name:string;employee_id:string;employee_name:string;duration_minutes:number;price:number;start_time:string;end_time:string;resource_ids:string[]};

function overlap(a1:Date,a2:Date,b1:Date,b2:Date){return a1<b2&&a2>b1}

async function buildPlan(cx:any,payload:any,lock=false){
 const locationId=String(payload?.location_id||'').trim(),mode=String(payload?.booking_mode||'sequential')==='parallel'?'parallel':'sequential';
 const start=new Date(payload?.start_time),requested:Array<RequestedService>=Array.isArray(payload?.services)?payload.services:[];
 const conflicts:any[]=[];
 if(!UUID_RE.test(locationId)||!Number.isFinite(start.getTime())||!requested.length)return{ok:false,conflicts:[{type:'validation',message:'Telephely, kezdési idő és legalább egy szolgáltatás kötelező.'}]};
 if(requested.some(x=>!UUID_RE.test(String(x.service_id||''))||!UUID_RE.test(String(x.employee_id||''))))return{ok:false,conflicts:[{type:'validation',message:'Érvénytelen szolgáltatás- vagy munkatársazonosító.'}]};
 const serviceIds=[...new Set(requested.map(x=>String(x.service_id)))],employeeIds=[...new Set(requested.map(x=>String(x.employee_id)))];
 const serviceRows=(await cx.query(`SELECT id::text,name,COALESCE(duration_minutes,30)::int duration_minutes,COALESCE(promo_price,list_price,base_price,0)::numeric price FROM services WHERE id=ANY($1::uuid[]) AND COALESCE(is_active,true)=true`,[serviceIds])).rows;
 if(serviceRows.length!==serviceIds.length)return{ok:false,conflicts:[{type:'service',message:'Egy vagy több szolgáltatás nem található vagy inaktív.'}]};
 const employeeRows=(await cx.query(`SELECT id::text,COALESCE(NULLIF(full_name,''),NULLIF(concat_ws(' ',last_name,first_name),''),email,'Munkatárs') name,location_id::text FROM employees WHERE id=ANY($1::uuid[]) AND COALESCE(active,true)=true`,[employeeIds])).rows;
 if(employeeRows.length!==employeeIds.length)return{ok:false,conflicts:[{type:'staff',message:'Egy vagy több munkatárs nem található vagy inaktív.'}]};
 for(const e of employeeRows)if(e.location_id&&String(e.location_id)!==locationId)conflicts.push({type:'staff_location',employee_id:e.id,message:`${e.name} másik telephelyhez tartozik.`});
 if(conflicts.length)return{ok:false,conflicts};
 const sm=new Map(serviceRows.map((x:any)=>[String(x.id),x])),em=new Map(employeeRows.map((x:any)=>[String(x.id),x]));
 let cursor=new Date(start),overallEnd=new Date(start);const planned:PlannedService[]=[];
 for(const item of requested){const s:any=sm.get(String(item.service_id)),e:any=em.get(String(item.employee_id));const st=mode==='parallel'?new Date(start):new Date(cursor);const en=new Date(st.getTime()+Number(s.duration_minutes||30)*60000);if(mode==='sequential')cursor=en;if(en>overallEnd)overallEnd=en;planned.push({service_id:String(s.id),service_name:String(s.name),employee_id:String(e.id),employee_name:String(e.name),duration_minutes:Number(s.duration_minutes||30),price:Number(s.price||0),start_time:st.toISOString(),end_time:en.toISOString(),resource_ids:[]})}

 for(const employeeId of employeeIds){if(lock)await cx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`,[`booking-staff:${employeeId}`]);const intervals=planned.filter(x=>x.employee_id===employeeId);for(const p of intervals){
   const busy=(await cx.query(`SELECT id::text,title,start_time,end_time FROM appointments WHERE employee_id=$1::uuid AND status=ANY($4::text[]) AND start_time<$3::timestamptz AND end_time>$2::timestamptz LIMIT 1`,[employeeId,p.start_time,p.end_time,ACTIVE_STATUSES])).rows[0];
   const secondary=(await cx.query(`SELECT a.id::text,a.title,asa.start_time,asa.end_time FROM appointment_staff_assignments asa JOIN appointments a ON a.id=asa.appointment_id WHERE asa.employee_id=$1::uuid AND a.status=ANY($4::text[]) AND asa.start_time<$3::timestamptz AND asa.end_time>$2::timestamptz LIMIT 1`,[employeeId,p.start_time,p.end_time,ACTIVE_STATUSES])).rows[0];
   const br=(await cx.query(`SELECT id::text,title,start_time,end_time FROM appointment_technical_breaks WHERE employee_id=$1::uuid AND start_time<$3::timestamptz AND end_time>$2::timestamptz LIMIT 1`,[employeeId,p.start_time,p.end_time])).rows[0];
   if(busy||secondary||br)conflicts.push({type:'staff',employee_id,service_id:p.service_id,start_time:p.start_time,end_time:p.end_time,message:`${p.employee_name} ebben az időszakban foglalt vagy technikai szüneten van.`});
 }}
 if(conflicts.length)return{ok:false,booking_mode:mode,start_time:start.toISOString(),end_time:overallEnd.toISOString(),services:planned,conflicts};

 const reqRows=(await cx.query(`SELECT service_id::text,resource_group,quantity FROM service_resource_requirements WHERE service_id=ANY($1::uuid[]) ORDER BY service_id,resource_group`,[serviceIds])).rows;
 const allResources=(await cx.query(`SELECT id::text,name,resource_group,resource_type FROM booking_resources WHERE location_id=$1::uuid AND active=true ORDER BY resource_group,name`,[locationId])).rows;
 const localAllocations:{resource_id:string;start:Date;end:Date}[]=[];
 for(let i=0;i<planned.length;i++){const p=planned[i],source=requested[i],requirements=reqRows.filter((x:any)=>String(x.service_id)===p.service_id);for(const requirement of requirements){const st=new Date(p.start_time),en=new Date(p.end_time),needed=Number(requirement.quantity||1);let candidates=allResources.filter((r:any)=>String(r.resource_group)===String(requirement.resource_group));const preferred=(Array.isArray(source.resource_ids)?source.resource_ids:[]).map(String);if(preferred.length){const preferredMatches=candidates.filter((r:any)=>preferred.includes(String(r.id)));candidates=[...preferredMatches,...candidates.filter((r:any)=>!preferred.includes(String(r.id)))]}
   const chosen:any[]=[];for(const resource of candidates){if(chosen.length>=needed)break;if(localAllocations.some(x=>x.resource_id===String(resource.id)&&overlap(st,en,x.start,x.end)))continue;if(lock)await cx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`,[`booking-resource:${resource.id}`]);const busy=(await cx.query(`SELECT ara.id FROM appointment_resource_allocations ara JOIN appointments a ON a.id=ara.appointment_id WHERE ara.resource_id=$1::uuid AND a.status=ANY($4::text[]) AND ara.start_time<$3::timestamptz AND ara.end_time>$2::timestamptz LIMIT 1`,[resource.id,p.start_time,p.end_time,ACTIVE_STATUSES])).rows[0];if(busy)continue;chosen.push(resource);localAllocations.push({resource_id:String(resource.id),start:st,end:en})}
   if(chosen.length<needed){conflicts.push({type:'resource',service_id:p.service_id,resource_group:requirement.resource_group,required:needed,available:chosen.length,message:`A(z) ${requirement.resource_group} erőforráscsoportból nincs elegendő szabad kapacitás.`})}else p.resource_ids.push(...chosen.map((x:any)=>String(x.id)));
 }}
 return{ok:conflicts.length===0,booking_mode:mode,start_time:start.toISOString(),end_time:overallEnd.toISOString(),duration_minutes:Math.round((overallEnd.getTime()-start.getTime())/60000),services:planned,resource_allocations:planned.flatMap(p=>p.resource_ids.map(resource_id=>({service_id:p.service_id,resource_id,start_time:p.start_time,end_time:p.end_time}))),conflicts};
}

router.get('/resources',async(req,res,next)=>{try{const locationId=String(req.query.location_id||'').trim();if(!UUID_RE.test(locationId))return res.status(400).json({error:'Érvényes location_id kötelező.'});const {rows}=await db.query(`SELECT r.*,COALESCE((SELECT count(*) FROM appointment_resource_allocations ara JOIN appointments a ON a.id=ara.appointment_id WHERE ara.resource_id=r.id AND a.status=ANY($2::text[]) AND ara.end_time>now()),0)::int future_allocations FROM booking_resources r WHERE r.location_id=$1::uuid ORDER BY r.active DESC,r.resource_group,r.name`,[locationId,ACTIVE_STATUSES]);res.json(rows)}catch(e){next(e)}});
router.post('/resources',requireManager,async(req:AuthRequest,res,next)=>{try{const locationId=String(req.body?.location_id||'').trim(),name=String(req.body?.name||'').trim(),group=groupKey(req.body?.resource_group||req.body?.resource_type),type=String(req.body?.resource_type||'other').trim().toLowerCase();if(!UUID_RE.test(locationId)||!name||!group)return res.status(400).json({error:'Telephely, név és erőforráscsoport kötelező.'});const {rows}=await db.query(`INSERT INTO booking_resources(location_id,name,resource_group,resource_type,note) VALUES($1::uuid,$2,$3,$4,$5) RETURNING *`,[locationId,name,group,type,req.body?.note||null]);res.status(201).json(rows[0])}catch(e){next(e)}});
router.patch('/resources/:id',requireManager,async(req,res,next)=>{try{const {rows}=await db.query(`UPDATE booking_resources SET name=COALESCE($2,name),resource_group=COALESCE($3,resource_group),resource_type=COALESCE($4,resource_type),note=COALESCE($5,note),active=COALESCE($6,active),updated_at=now() WHERE id=$1::uuid RETURNING *`,[req.params.id,req.body?.name||null,req.body?.resource_group?groupKey(req.body.resource_group):null,req.body?.resource_type||null,req.body?.note??null,req.body?.active??null]);if(!rows[0])return res.status(404).json({error:'Az erőforrás nem található.'});res.json(rows[0])}catch(e){next(e)}});

router.get('/service-resources/:serviceId',async(req,res,next)=>{try{const {rows}=await db.query(`SELECT * FROM service_resource_requirements WHERE service_id=$1::uuid ORDER BY resource_group`,[req.params.serviceId]);res.json(rows)}catch(e){next(e)}});
router.put('/service-resources/:serviceId',requireManager,async(req,res,next)=>{const cx=await db.connect();try{const requirements=Array.isArray(req.body?.requirements)?req.body.requirements:[];await cx.query('BEGIN');await cx.query(`DELETE FROM service_resource_requirements WHERE service_id=$1::uuid`,[req.params.serviceId]);for(const r of requirements){const group=groupKey(r?.resource_group),qty=Math.min(20,Math.max(1,Math.floor(Number(r?.quantity||1))));if(group)await cx.query(`INSERT INTO service_resource_requirements(service_id,resource_group,quantity,note) VALUES($1::uuid,$2,$3,$4)`,[req.params.serviceId,group,qty,r?.note||null])}await cx.query('COMMIT');res.json({ok:true,requirements:(await db.query(`SELECT * FROM service_resource_requirements WHERE service_id=$1::uuid ORDER BY resource_group`,[req.params.serviceId])).rows})}catch(e){await cx.query('ROLLBACK').catch(()=>undefined);next(e)}finally{cx.release()}});

router.post('/availability',async(req,res,next)=>{try{const plan=await buildPlan(db,req.body,false);res.status(plan.ok?200:409).json(plan)}catch(e){next(e)}});

router.post('/appointments',async(req:AuthRequest,res,next)=>{const cx=await db.connect();try{
 await ensureBookingWorkOrderSchema(cx);await ensureSchema(cx);await cx.query('BEGIN');const plan:any=await buildPlan(cx,req.body,true);if(!plan.ok){await cx.query('ROLLBACK');return res.status(409).json(plan)};
 const clientId=String(req.body?.client_id||'').trim(),locationId=String(req.body?.location_id||'').trim();if(clientId&&!UUID_RE.test(clientId)){await cx.query('ROLLBACK');return res.status(400).json({error:'Érvénytelen vendégazonosító.'})}
 const primary=plan.services[0],title=String(req.body?.title||plan.services.map((x:any)=>x.service_name).join(', ')).trim(),note=String(req.body?.notes||req.body?.note||'').trim();
 const ap=(await cx.query(`INSERT INTO appointments(employee_id,client_id,location_id,title,start_time,end_time,status,notes,booking_source,updated_at) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5::timestamptz,$6::timestamptz,'confirmed',$7,'internal_advanced',now()) RETURNING id::text`,[primary.employee_id,clientId||null,locationId,title,plan.start_time,plan.end_time,note])).rows[0];const appointmentId=String(ap.id);
 for(let i=0;i<plan.services.length;i++){const p=plan.services[i];await cx.query(`INSERT INTO appointment_services(appointment_id,service_id,duration_minutes,price,discount_percent,sort_order,assigned_employee_id,scheduled_start_time,scheduled_end_time) VALUES($1::uuid,$2::uuid,$3,$4,0,$5,$6::uuid,$7::timestamptz,$8::timestamptz)`,[appointmentId,p.service_id,p.duration_minutes,p.price,i,p.employee_id,p.start_time,p.end_time]);await cx.query(`INSERT INTO appointment_staff_assignments(appointment_id,service_id,employee_id,start_time,end_time,is_primary) VALUES($1::uuid,$2::uuid,$3::uuid,$4::timestamptz,$5::timestamptz,$6)`,[appointmentId,p.service_id,p.employee_id,p.start_time,p.end_time,i===0])}
 for(const a of plan.resource_allocations||[])await cx.query(`INSERT INTO appointment_resource_allocations(appointment_id,service_id,resource_id,start_time,end_time) VALUES($1::uuid,$2::uuid,$3::uuid,$4::timestamptz,$5::timestamptz)`,[appointmentId,a.service_id,a.resource_id,a.start_time,a.end_time]);
 await cx.query(`INSERT INTO appointment_change_log(appointment_id,action,actor_key,after_data,note) VALUES($1::uuid,'advanced_created',$2,$3::jsonb,$4)`,[appointmentId,actor(req),JSON.stringify({booking_mode:plan.booking_mode,services:plan.services,resource_allocations:plan.resource_allocations}),plan.booking_mode==='parallel'?'4Hands / párhuzamos foglalás':'Több szakemberes szekvenciális foglalás']);
 const workOrder=await ensureBookingWorkOrder(cx,appointmentId,actor(req));if(workOrder.work_order_id)await cx.query(`UPDATE work_orders SET source_snapshot=COALESCE(source_snapshot,'{}'::jsonb)||$2::jsonb,updated_at=now() WHERE id::text=$1`,[workOrder.work_order_id,JSON.stringify({booking_mode:plan.booking_mode,staff_assignments:plan.services,resource_allocations:plan.resource_allocations})]);
 await cx.query('COMMIT');res.status(201).json({appointment_id:appointmentId,work_order_id:workOrder.work_order_id,work_order_number:workOrder.work_order_number,...plan});
 }catch(e){await cx.query('ROLLBACK').catch(()=>undefined);next(e)}finally{cx.release()}});

router.get('/appointments/:id/allocations',async(req,res,next)=>{try{const [staff,resources]=await Promise.all([db.query(`SELECT asa.*,COALESCE(e.full_name,e.name,e.email) employee_name,s.name service_name FROM appointment_staff_assignments asa LEFT JOIN employees e ON e.id=asa.employee_id LEFT JOIN services s ON s.id=asa.service_id WHERE asa.appointment_id=$1::uuid ORDER BY asa.start_time,asa.created_at`,[req.params.id]),db.query(`SELECT ara.*,r.name resource_name,r.resource_group,r.resource_type,s.name service_name FROM appointment_resource_allocations ara JOIN booking_resources r ON r.id=ara.resource_id LEFT JOIN services s ON s.id=ara.service_id WHERE ara.appointment_id=$1::uuid ORDER BY ara.start_time,r.name`,[req.params.id])]);res.json({staff:staff.rows,resources:resources.rows})}catch(e){next(e)}});

export default router;
