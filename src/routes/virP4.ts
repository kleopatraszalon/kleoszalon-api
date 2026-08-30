import { Router, Response } from "express";
import pool from "../db";
import type { AuthRequest } from "../middleware/auth";
import { requireManagement } from "../middleware/requireRoles";

const router = Router();
router.use(requireManagement);

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const num=(v:unknown)=>Number.isFinite(Number(v))?Number(v):0;
const clamp=(v:number,min:number,max:number)=>Math.min(max,Math.max(min,v));

type Scope={tenantId:string;locationId:string|null};
async function scope(req:AuthRequest,res:Response):Promise<Scope|undefined>{
  const tenantId=String(req.user?.tenant_id||"").trim();
  if(!tenantId){res.status(403).json({ok:false,error:"A felhasználóhoz nincs tenant rendelve."});return;}
  const locationId=String(req.query.locationId||req.query.location_id||"").trim()||null;
  if(!locationId)return{tenantId,locationId:null};
  if(!UUID.test(locationId)){res.status(400).json({ok:false,error:"Érvénytelen telephelyazonosító."});return;}
  const owned=(await pool.query(`SELECT id FROM locations WHERE id=$1::uuid AND tenant_id=$2::uuid`,[locationId,tenantId])).rows[0];
  if(!owned){res.status(403).json({ok:false,error:"A telephely nem tartozik a tenantjához."});return;}
  return{tenantId,locationId};
}

router.get("/workforce-optimizer",async(req:AuthRequest,res:Response)=>{
  try{
    const s=await scope(req,res);if(!s)return;
    const days=clamp(Math.round(num(req.query.days)||14),7,30);
    const locations=(await pool.query(`SELECT id::text,name FROM locations WHERE tenant_id=$1::uuid AND active IS DISTINCT FROM false AND ($2::uuid IS NULL OR id=$2::uuid) ORDER BY name`,[s.tenantId,s.locationId])).rows;
    const items:any[]=[];
    for(const loc of locations){
      const rows=(await pool.query(`
        WITH dates AS (
          SELECT d::date day FROM generate_series(current_date,current_date+($2::int-1),interval '1 day') d
        ), hist AS (
          SELECT EXTRACT(ISODOW FROM a.start_time)::int dow,
                 COUNT(*)::numeric/GREATEST(COUNT(DISTINCT a.start_time::date),1) avg_bookings,
                 COALESCE(SUM(EXTRACT(EPOCH FROM (a.end_time-a.start_time))/60.0),0)::numeric/GREATEST(COUNT(DISTINCT a.start_time::date),1) avg_minutes
          FROM appointments a
          WHERE a.tenant_id=$3::uuid AND a.location_id=$1::uuid
            AND a.start_time>=now()-interval '56 days' AND a.start_time<now()
            AND lower(COALESCE(a.status,'')) NOT IN('cancelled','canceled','no_show','no-show')
          GROUP BY 1
        ), booked AS (
          SELECT a.start_time::date day,COUNT(*)::int booked_count,
                 COALESCE(SUM(EXTRACT(EPOCH FROM (a.end_time-a.start_time))/60.0),0)::numeric booked_minutes
          FROM appointments a
          WHERE a.tenant_id=$3::uuid AND a.location_id=$1::uuid
            AND a.start_time>=current_date AND a.start_time<current_date+$2::int
            AND lower(COALESCE(a.status,'')) NOT IN('cancelled','canceled','no_show','no-show')
          GROUP BY 1
        ), shifts AS (
          SELECT ws.work_date::date day,COUNT(DISTINCT ws.employee_id)::int staff_count,
                 COALESCE(SUM(EXTRACT(EPOCH FROM (ws.ends_at-ws.starts_at))/60.0),0)::numeric staff_minutes
          FROM work_shifts ws JOIN employees e ON e.id=ws.employee_id
          WHERE ws.work_date>=current_date AND ws.work_date<current_date+$2::int AND ws.status='published'
            AND e.tenant_id=$3::uuid AND e.location_id=$1::uuid AND COALESCE(e.active,true)=true
          GROUP BY 1
        )
        SELECT d.day,COALESCE(b.booked_count,0)::int booked_count,COALESCE(b.booked_minutes,0)::numeric booked_minutes,
               COALESCE(h.avg_bookings,0)::numeric historical_daily_bookings,COALESCE(h.avg_minutes,0)::numeric historical_daily_minutes,
               COALESCE(sh.staff_count,0)::int scheduled_staff,COALESCE(sh.staff_minutes,0)::numeric scheduled_minutes
        FROM dates d LEFT JOIN hist h ON h.dow=EXTRACT(ISODOW FROM d.day)::int LEFT JOIN booked b ON b.day=d.day LEFT JOIN shifts sh ON sh.day=d.day
        ORDER BY d.day`,[loc.id,days,s.tenantId])).rows;

      const skills=(await pool.query(`SELECT COUNT(DISTINCT o.service_id)::int configured_services,
        COUNT(*) FILTER(WHERE COALESCE(o.can_perform,true)=false OR (o.qualification_valid_until IS NOT NULL AND o.qualification_valid_until<current_date))::int blocked_skill_rows,
        COUNT(*) FILTER(WHERE o.qualification_valid_until BETWEEN current_date AND current_date+30)::int expiring_30d
        FROM employee_service_overrides o JOIN employees e ON e.id=o.employee_id
        WHERE e.tenant_id=$2::uuid AND e.location_id=$1::uuid AND COALESCE(e.active,true)=true`,[loc.id,s.tenantId])).rows[0]||{};

      for(const r of rows){
        const demandMinutes=Math.max(num(r.booked_minutes),num(r.historical_daily_minutes));
        const requiredStaff=demandMinutes>0?Math.max(1,Math.ceil(demandMinutes/(8*60*0.8))):0;
        const scheduled=num(r.scheduled_staff);
        const gap=requiredStaff-scheduled;
        const utilization=num(r.scheduled_minutes)>0?Math.round((demandMinutes/num(r.scheduled_minutes))*100):null;
        const status=gap>=2?"CRITICAL_SHORTAGE":gap===1?"SHORTAGE":gap<=-2?"SURPLUS":"BALANCED";
        items.push({location_id:loc.id,location_name:loc.name,day:r.day,booked_count:num(r.booked_count),historical_daily_bookings:Math.round(num(r.historical_daily_bookings)*10)/10,demand_minutes:Math.round(demandMinutes),scheduled_staff:scheduled,scheduled_minutes:Math.round(num(r.scheduled_minutes)),required_staff:requiredStaff,staff_gap:gap,utilization_percent:utilization,status,skill_coverage:{configured_services:num(skills.configured_services),blocked_skill_rows:num(skills.blocked_skill_rows),expiring_30d:num(skills.expiring_30d)},rationale:gap>0?`A várható terheléshez ${gap} további munkatárs-kapacitás javasolt.`:gap<0?`A beosztott kapacitás ${Math.abs(gap)} fővel meghaladja a becsült igényt.`:"A beosztott létszám illeszkedik a becsült igényhez."});
      }
    }
    const shortages=items.filter(x=>x.staff_gap>0);
    res.json({ok:true,model:"forecast_capacity_workforce_optimizer_v1",days,automatic_scheduling:false,decision_support_only:true,summary:{days_analyzed:items.length,shortage_days:shortages.length,critical_days:items.filter(x=>x.status==="CRITICAL_SHORTAGE").length,total_staff_gap:shortages.reduce((a,x)=>a+x.staff_gap,0),expiring_qualifications:Math.max(0,...items.map(x=>x.skill_coverage.expiring_30d))},items});
  }catch(e:any){res.status(500).json({ok:false,error:e?.message||"workforce_optimizer_failed"});}
});

export default router;
