import {Router} from "express";
import crypto from "crypto";
import db from "../db";
import ensureOnlineBooking from "../booking/ensureOnlineBooking";

const router=Router();
const UUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIVE=['waiting','pending','booked','confirmed','arrived','in_progress','paid'];
const list=(v:any)=>String(v||'').split(',').map((x:string)=>x.trim()).filter(Boolean);
const plus=(d:Date,min:number)=>new Date(d.getTime()+min*60000);
const overlap=(a1:Date,a2:Date,b1:Date,b2:Date)=>a1<b2&&a2>b1;

async function ensureResourceSchema(){
 await ensureOnlineBooking();
 await db.query(`
  CREATE TABLE IF NOT EXISTS booking_resources(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    name text NOT NULL,resource_group text NOT NULL,resource_type text NOT NULL DEFAULT 'other',note text,
    active boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS booking_resources_location_group_idx ON booking_resources(location_id,resource_group,active);
  CREATE TABLE IF NOT EXISTS service_resource_requirements(
    service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,resource_group text NOT NULL,
    quantity integer NOT NULL DEFAULT 1 CHECK(quantity>0 AND quantity<=20),note text,PRIMARY KEY(service_id,resource_group)
  );
  CREATE TABLE IF NOT EXISTS appointment_resource_allocations(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),appointment_id uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
    service_id uuid REFERENCES services(id) ON DELETE SET NULL,resource_id uuid NOT NULL REFERENCES booking_resources(id) ON DELETE RESTRICT,
    start_time timestamptz NOT NULL,end_time timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),CHECK(end_time>start_time)
  );
  CREATE INDEX IF NOT EXISTS appointment_resource_allocations_resource_time_idx ON appointment_resource_allocations(resource_id,start_time,end_time);
  CREATE TABLE IF NOT EXISTS online_booking_resource_holds(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),hold_group uuid NOT NULL,location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    resource_id uuid NOT NULL REFERENCES booking_resources(id) ON DELETE CASCADE,start_time timestamptz NOT NULL,end_time timestamptz NOT NULL,
    expires_at timestamptz NOT NULL DEFAULT(now()+interval '2 minutes'),consumed_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),CHECK(end_time>start_time)
  );
  CREATE INDEX IF NOT EXISTS online_booking_resource_holds_active_idx ON online_booking_resource_holds(resource_id,start_time,end_time,expires_at) WHERE consumed_at IS NULL;
 `);
 await db.query(`
  CREATE OR REPLACE FUNCTION kleo_online_booking_resource_allocate()
  RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE a record; req record; h record; i integer;
  BEGIN
    SELECT id,location_id,employee_id,start_time,end_time,booking_source INTO a FROM appointments WHERE id=NEW.appointment_id;
    IF a.id IS NULL OR COALESCE(a.booking_source,'internal') NOT IN ('online','online_voice') THEN RETURN NEW; END IF;
    FOR req IN SELECT resource_group,quantity FROM service_resource_requirements WHERE service_id=NEW.service_id ORDER BY resource_group LOOP
      FOR i IN 1..req.quantity LOOP
        SELECT h0.* INTO h
        FROM online_booking_resource_holds h0 JOIN booking_resources r ON r.id=h0.resource_id
        WHERE h0.location_id=a.location_id AND h0.employee_id=a.employee_id AND h0.service_id=NEW.service_id
          AND h0.consumed_at IS NULL AND h0.expires_at>now() AND r.resource_group=req.resource_group
          AND h0.start_time>=a.start_time AND h0.end_time<=a.end_time
        ORDER BY h0.created_at,h0.id LIMIT 1 FOR UPDATE OF h0 SKIP LOCKED;
        IF h.id IS NULL THEN
          RAISE EXCEPTION 'A szükséges erőforrás időközben foglalttá vált. Kérjük, válasszon másik időpontot.' USING ERRCODE='P0001';
        END IF;
        INSERT INTO appointment_resource_allocations(appointment_id,service_id,resource_id,start_time,end_time)
        VALUES(NEW.appointment_id,NEW.service_id,h.resource_id,h.start_time,h.end_time);
        UPDATE online_booking_resource_holds SET consumed_at=now() WHERE id=h.id;
        h:=NULL;
      END LOOP;
    END LOOP;
    RETURN NEW;
  END $$;
  DROP TRIGGER IF EXISTS trg_online_booking_resource_allocate ON appointment_services;
  CREATE TRIGGER trg_online_booking_resource_allocate AFTER INSERT ON appointment_services
    FOR EACH ROW EXECUTE FUNCTION kleo_online_booking_resource_allocate();
 `);
}

async function resourceContext(locationId:string,serviceIds:string[],from:Date,to:Date){
 const [services,requirements,resources,allocations,holds]=await Promise.all([
  db.query(`SELECT id::text,COALESCE(duration_minutes,30)::int duration_minutes FROM services WHERE id=ANY($1::uuid[]) ORDER BY array_position($1::uuid[],id)`,[serviceIds]),
  db.query(`SELECT service_id::text,resource_group,quantity FROM service_resource_requirements WHERE service_id=ANY($1::uuid[]) ORDER BY service_id,resource_group`,[serviceIds]),
  db.query(`SELECT id::text,resource_group FROM booking_resources WHERE location_id=$1::uuid AND active=true ORDER BY resource_group,id`,[locationId]),
  db.query(`SELECT ara.resource_id::text,ara.start_time,ara.end_time FROM appointment_resource_allocations ara JOIN appointments a ON a.id=ara.appointment_id WHERE a.location_id=$1::uuid AND a.status=ANY($4::text[]) AND ara.start_time<$3::timestamptz AND ara.end_time>$2::timestamptz`,[locationId,from.toISOString(),to.toISOString(),ACTIVE]),
  db.query(`SELECT resource_id::text,start_time,end_time FROM online_booking_resource_holds WHERE location_id=$1::uuid AND consumed_at IS NULL AND expires_at>now() AND start_time<$3::timestamptz AND end_time>$2::timestamptz`,[locationId,from.toISOString(),to.toISOString()])
 ]);
 return{services:services.rows,requirements:requirements.rows,resources:resources.rows,allocations:allocations.rows,holds:holds.rows};
}

function resourcesFit(ctx:any,start:Date){
 let cursor=new Date(start);const local:{resource_id:string,start:Date,end:Date}[]=[];
 for(const service of ctx.services){const st=new Date(cursor),en=plus(st,Number(service.duration_minutes||30));cursor=en;const reqs=ctx.requirements.filter((r:any)=>String(r.service_id)===String(service.id));
  for(const req of reqs){const candidates=ctx.resources.filter((r:any)=>String(r.resource_group)===String(req.resource_group));let count=0;for(const r of candidates){if(count>=Number(req.quantity||1))break;const rid=String(r.id);if(local.some(x=>x.resource_id===rid&&overlap(st,en,x.start,x.end)))continue;if(ctx.allocations.some((x:any)=>String(x.resource_id)===rid&&overlap(st,en,new Date(x.start_time),new Date(x.end_time))))continue;if(ctx.holds.some((x:any)=>String(x.resource_id)===rid&&overlap(st,en,new Date(x.start_time),new Date(x.end_time))))continue;local.push({resource_id:rid,start:st,end:en});count++}if(count<Number(req.quantity||1))return false}
 }
 return true;
}

router.get('/availability',async(req,res,next)=>{try{
 await ensureResourceSchema();const locationId=String(req.query.location_id||'').trim(),date=String(req.query.date||'').trim(),serviceIds=list(req.query.service_ids),employeeId=String(req.query.employee_id||'').trim();if(!UUID_RE.test(locationId)||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!serviceIds.length||serviceIds.some(x=>!UUID_RE.test(x)))return next();
 const requirementCount=Number((await db.query(`SELECT count(*) n FROM service_resource_requirements WHERE service_id=ANY($1::uuid[])`,[serviceIds])).rows[0]?.n||0);if(!requirementCount)return next();
 const cfg=(await db.query(`SELECT * FROM online_booking_settings WHERE location_id=$1::uuid`,[locationId])).rows[0]||{enabled:true,slot_interval_minutes:15,opening_minute:480,closing_minute:1200,booking_horizon_days:60,minimum_notice_minutes:60};if(!cfg.enabled)return res.status(403).json({error:'Az online foglalás ezen a telephelyen ki van kapcsolva.'});
 const sr=await db.query(`SELECT id::text,COALESCE(duration_minutes,30)::int duration_minutes FROM services WHERE id=ANY($1::uuid[]) AND is_active=true AND COALESCE(online_bookable,true)=true AND (NOT EXISTS(SELECT 1 FROM service_locations sl0 WHERE sl0.service_id=services.id) OR EXISTS(SELECT 1 FROM service_locations sl WHERE sl.service_id=services.id AND sl.location_id=$2::uuid)) ORDER BY array_position($1::uuid[],id)`,[serviceIds,locationId]);if(sr.rows.length!==new Set(serviceIds).size)return res.status(400).json({error:'Egy vagy több szolgáltatás ezen a telephelyen nem foglalható.'});
 const duration=sr.rows.reduce((s:any,x:any)=>s+Number(x.duration_minutes||30),0),employees=await db.query(`SELECT e.id::text,COALESCE(NULLIF(btrim(e.full_name),''),NULLIF(btrim(concat_ws(' ',e.last_name,e.first_name)),''),'Munkatárs') full_name FROM employees e WHERE e.active=true AND (e.location_id=$1::uuid OR e.location_id IS NULL) AND ($2::uuid IS NULL OR e.id=$2::uuid) AND (NOT EXISTS(SELECT 1 FROM employee_service_overrides eo0 WHERE eo0.employee_id=e.id) OR NOT EXISTS(SELECT 1 FROM unnest($3::uuid[]) sid(service_id) WHERE NOT EXISTS(SELECT 1 FROM employee_service_overrides eo WHERE eo.employee_id=e.id AND eo.service_id=sid.service_id)))`,[locationId,employeeId||null,serviceIds]);if(!employees.rows.length)return res.json({duration_minutes:duration,slots:[],resource_aware:true});
 const base=new Date(`${date}T00:00:00`),from=plus(base,Math.max(0,Math.min(1439,Number(cfg.opening_minute||480)))),to=plus(base,Math.max(1,Math.min(1440,Number(cfg.closing_minute||1200)))),nowMin=new Date(Date.now()+Number(cfg.minimum_notice_minutes||0)*60000);const horizon=new Date();horizon.setDate(horizon.getDate()+Number(cfg.booking_horizon_days||60));if(from>horizon)return res.json({duration_minutes:duration,slots:[],resource_aware:true});
 const [busy,ctx]=await Promise.all([db.query(`SELECT employee_id::text,start_time,end_time FROM appointments WHERE location_id=$1::uuid AND employee_id=ANY($2::uuid[]) AND status NOT IN('cancelled','canceled','no_show') AND start_time<$4::timestamptz AND end_time>$3::timestamptz UNION ALL SELECT employee_id::text,start_time,end_time FROM appointment_technical_breaks WHERE location_id=$1::uuid AND employee_id=ANY($2::uuid[]) AND start_time<$4::timestamptz AND end_time>$3::timestamptz`,[locationId,employees.rows.map((x:any)=>x.id),from.toISOString(),to.toISOString()]),resourceContext(locationId,serviceIds,from,to)]);
 const slots:any[]=[],step=Math.max(5,Number(cfg.slot_interval_minutes||15));for(const e of employees.rows){const blocks=busy.rows.filter((x:any)=>String(x.employee_id)===String(e.id));for(let cur=new Date(from);cur<to;cur=plus(cur,step)){const end=plus(cur,duration);if(end>to||cur<nowMin)continue;if(blocks.some((x:any)=>overlap(cur,end,new Date(x.start_time),new Date(x.end_time))))continue;if(!resourcesFit(ctx,cur))continue;slots.push({employee_id:e.id,employee_name:e.full_name,start:cur.toISOString(),end:end.toISOString(),resource_aware:true})}}
 return res.json({duration_minutes:duration,slots:slots.slice(0,200),resource_aware:true});
 }catch(e){next(e)}});

router.post('/book',async(req,res,next)=>{const locationId=String(req.body?.location_id||'').trim(),employeeId=String(req.body?.employee_id||'').trim(),serviceIds=Array.isArray(req.body?.service_ids)?req.body.service_ids.map(String).filter(Boolean):[],start=new Date(req.body?.start_time);if(!UUID_RE.test(locationId)||!UUID_RE.test(employeeId)||!serviceIds.length||serviceIds.some((x:string)=>!UUID_RE.test(x))||!Number.isFinite(start.getTime()))return next();const cx=await db.connect();try{
 await ensureResourceSchema();const reqs=(await cx.query(`SELECT service_id::text,resource_group,quantity FROM service_resource_requirements WHERE service_id=ANY($1::uuid[]) ORDER BY service_id,resource_group`,[serviceIds])).rows;if(!reqs.length)return next();const services=(await cx.query(`SELECT id::text,COALESCE(duration_minutes,30)::int duration_minutes FROM services WHERE id=ANY($1::uuid[]) ORDER BY array_position($1::uuid[],id)`,[serviceIds])).rows;if(services.length!==new Set(serviceIds).size)return next();
 await cx.query('BEGIN');await cx.query(`DELETE FROM online_booking_resource_holds WHERE expires_at<=now() OR (consumed_at IS NOT NULL AND consumed_at<now()-interval '10 minutes')`);const holdGroup=crypto.randomUUID();let cursor=new Date(start);
 for(const s of services){const st=new Date(cursor),en=plus(st,Number(s.duration_minutes||30));cursor=en;for(const rr of reqs.filter((x:any)=>String(x.service_id)===String(s.id))){let chosen=0;const candidates=(await cx.query(`SELECT id::text FROM booking_resources WHERE location_id=$1::uuid AND active=true AND resource_group=$2 ORDER BY id`,[locationId,rr.resource_group])).rows;for(const r of candidates){if(chosen>=Number(rr.quantity||1))break;await cx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`,[`online-resource:${r.id}`]);const busy=(await cx.query(`SELECT 1 FROM appointment_resource_allocations ara JOIN appointments a ON a.id=ara.appointment_id WHERE ara.resource_id=$1::uuid AND a.status=ANY($4::text[]) AND ara.start_time<$3::timestamptz AND ara.end_time>$2::timestamptz UNION ALL SELECT 1 FROM online_booking_resource_holds h WHERE h.resource_id=$1::uuid AND h.consumed_at IS NULL AND h.expires_at>now() AND h.start_time<$3::timestamptz AND h.end_time>$2::timestamptz LIMIT 1`,[r.id,st.toISOString(),en.toISOString(),ACTIVE])).rows[0];if(busy)continue;await cx.query(`INSERT INTO online_booking_resource_holds(hold_group,location_id,employee_id,service_id,resource_id,start_time,end_time) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::timestamptz,$7::timestamptz)`,[holdGroup,locationId,employeeId,s.id,r.id,st.toISOString(),en.toISOString()]);chosen++}if(chosen<Number(rr.quantity||1)){await cx.query('ROLLBACK');return res.status(409).json({error:`A szükséges ${rr.resource_group} erőforrás időközben foglalttá vált. Válasszon másik időpontot.`,resource_conflict:true})}}
 }
 await cx.query('COMMIT');(req as any).resourceHoldGroup=holdGroup;return next();
 }catch(e){await cx.query('ROLLBACK').catch(()=>undefined);next(e)}finally{cx.release()}});

export default router;
