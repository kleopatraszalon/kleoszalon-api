import { Router, Response } from "express";
import pool from "../db";
import type { AuthRequest } from "../middleware/auth";
import { requireManagement } from "../middleware/requireRoles";
import { findCalendarGaps, matchWaitlist, upcomingRiskCandidates } from "../booking/virWave1Engine";

const router=Router();
router.use(requireManagement);

type Scope={tenantId:string;locationId:string|null};
function businessDate(){const parts=new Intl.DateTimeFormat("en-GB",{timeZone:process.env.BUSINESS_TIMEZONE||"Europe/Budapest",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date());const p=Object.fromEntries(parts.map(x=>[x.type,x.value]));return `${p.year}-${p.month}-${p.day}`}
function dateValue(v:unknown,fallback:string){const s=String(v||"");return /^\d{4}-\d{2}-\d{2}$/.test(s)?s:fallback}
async function resolveScope(req:AuthRequest,res:Response):Promise<Scope|undefined>{const tenantId=String(req.user?.tenant_id||"").trim();if(!tenantId){res.status(403).json({ok:false,error:"A felhasználóhoz nincs tenant rendelve."});return}const requested=String(req.query.locationId||req.query.location_id||"").trim();if(!requested)return{tenantId,locationId:null};const {rows}=await pool.query(`SELECT id::text FROM locations WHERE id=$1::uuid AND tenant_id=$2::uuid LIMIT 1`,[requested,tenantId]);if(!rows[0]){res.status(403).json({ok:false,error:"A telephely nem tartozik a felhasználó tenantjához."});return}return{tenantId,locationId:requested}}
async function tenantLocations(scope:Scope){if(scope.locationId)return[scope.locationId];const {rows}=await pool.query(`SELECT id::text FROM locations WHERE tenant_id=$1::uuid ORDER BY name`,[scope.tenantId]);return rows.map((r:any)=>String(r.id))}

const profitabilityCte=`
  WITH base AS (
    SELECT w.id,w.location_id,w.employee_id,w.appointment_id,
      COALESCE(NULLIF(to_jsonb(w)->>'total_amount','')::numeric,NULLIF(to_jsonb(w)->>'grand_total','')::numeric,NULLIF(to_jsonb(w)->>'total','')::numeric,
        (SELECT COALESCE(SUM(COALESCE(NULLIF(to_jsonb(i)->>'line_total','')::numeric,0)),0) FROM work_order_items i WHERE i.work_order_id=w.id),0)::numeric revenue
    FROM work_orders w
    WHERE w.tenant_id=$1::uuid AND w.created_at::date BETWEEN $2::date AND $3::date
      AND ($4::uuid IS NULL OR w.location_id=$4::uuid)
      AND lower(COALESCE(w.status,'')) NOT IN('waiting','arrived','in_progress','cancelled','no_show')
  ), economics AS (
    SELECT b.*,
      COALESCE((SELECT SUM(CASE WHEN lower(COALESCE(i.item_type,''))='product' THEN COALESCE(NULLIF(to_jsonb(i)->>'cost_total','')::numeric,NULLIF(to_jsonb(i)->>'cost_price','')::numeric*COALESCE(NULLIF(to_jsonb(i)->>'quantity','')::numeric,1),0) ELSE 0 END) FROM work_order_items i WHERE i.work_order_id=b.id),0)::numeric material_cost,
      COALESCE((SELECT SUM(COALESCE(NULLIF(to_jsonb(c)->>'amount','')::numeric,NULLIF(to_jsonb(c)->>'commission_amount','')::numeric,0)) FROM work_order_commission_events c WHERE c.work_order_id=b.id),0)::numeric commission_cost,
      COALESCE(
        GREATEST(0,EXTRACT(EPOCH FROM(a.end_time-a.start_time))/3600),
        (SELECT COALESCE(SUM(COALESCE(NULLIF(to_jsonb(i)->>'duration_minutes','')::numeric,0)),0)/60 FROM work_order_items i WHERE i.work_order_id=b.id),0
      )::numeric work_hours,
      COALESCE(
        NULLIF(to_jsonb(ca)->>'hourly_rate','')::numeric,
        NULLIF(to_jsonb(cp)->>'hourly_rate','')::numeric,
        NULLIF(to_jsonb(e)->>'hourly_wage','')::numeric,
        NULLIF(to_jsonb(p)->>'base_hourly_wage','')::numeric,
        NULLIF(to_jsonb(ca)->>'monthly_base','')::numeric/174.0,
        NULLIF(to_jsonb(cp)->>'monthly_base','')::numeric/174.0,
        NULLIF(to_jsonb(e)->>'monthly_wage','')::numeric/174.0,
        NULLIF(to_jsonb(p)->>'base_monthly_wage','')::numeric/174.0,
        0
      )::numeric labor_rate
    FROM base b
    LEFT JOIN appointments a ON a.id=b.appointment_id
    LEFT JOIN employees e ON e.id=b.employee_id
    LEFT JOIN hr_positions p ON p.id=e.position_id
    LEFT JOIN LATERAL (
      SELECT x.* FROM employee_compensation_assignments x
      WHERE x.employee_id=b.employee_id AND x.is_active=true AND x.valid_from<=$3::date AND (x.valid_to IS NULL OR x.valid_to>=$2::date)
      ORDER BY x.valid_from DESC LIMIT 1
    ) ca ON true
    LEFT JOIN compensation_plans cp ON cp.id=ca.compensation_plan_id
  ), x AS (
    SELECT economics.*,(work_hours*labor_rate)::numeric labor_cost,
      (revenue-material_cost-commission_cost-(work_hours*labor_rate))::numeric contribution_margin
    FROM economics
  )`;

router.get("/profitability",async(req:AuthRequest,res:Response)=>{try{
  const scope=await resolveScope(req,res);if(!scope)return;const today=businessDate(),from=dateValue(req.query.from,today),to=dateValue(req.query.to,today);
  const {rows}=await pool.query(`${profitabilityCte}
    SELECT COALESCE(SUM(revenue),0)::numeric revenue,COALESCE(SUM(material_cost),0)::numeric material_cost,COALESCE(SUM(commission_cost),0)::numeric commission_cost,
      COALESCE(SUM(labor_cost),0)::numeric labor_cost,COALESCE(SUM(contribution_margin),0)::numeric contribution_margin,
      CASE WHEN COALESCE(SUM(revenue),0)>0 THEN ROUND(SUM(contribution_margin)/SUM(revenue)*100,2) ELSE 0 END margin_percent,
      COUNT(*)::int closed_workorders,COALESCE(SUM(work_hours),0)::numeric productive_hours
    FROM x`,[scope.tenantId,from,to,scope.locationId]);
  const byLocation=await pool.query(`${profitabilityCte}
    SELECT x.location_id,l.name location_name,COALESCE(SUM(revenue),0)::numeric revenue,COALESCE(SUM(material_cost),0)::numeric material_cost,
      COALESCE(SUM(commission_cost),0)::numeric commission_cost,COALESCE(SUM(labor_cost),0)::numeric labor_cost,
      COALESCE(SUM(contribution_margin),0)::numeric contribution_margin,
      CASE WHEN COALESCE(SUM(revenue),0)>0 THEN ROUND(SUM(contribution_margin)/SUM(revenue)*100,2) ELSE 0 END margin_percent,
      COUNT(*)::int closed_workorders,COALESCE(SUM(work_hours),0)::numeric productive_hours
    FROM x LEFT JOIN locations l ON l.id=x.location_id GROUP BY x.location_id,l.name ORDER BY contribution_margin DESC`,[scope.tenantId,from,to,scope.locationId]);
  return res.json({ok:true,from,to,summary:rows[0]||{},by_location:byLocation.rows,cost_model:{includes_material_cost:true,includes_commission_cost:true,includes_direct_labor:true,monthly_hours_standard:174,excludes_employer_contributions_and_overhead:true}});
}catch(error:any){return res.status(500).json({ok:false,error:error?.message||"vir_profitability_failed"})}});

router.get("/capacity",async(req:AuthRequest,res:Response)=>{try{
  const scope=await resolveScope(req,res);if(!scope)return;const horizon=Math.max(1,Math.min(31,Number(req.query.horizonDays||7)||7));const ids=await tenantLocations(scope);const gaps:any[]=[];
  for(const locationId of ids){const localGaps=await findCalendarGaps(locationId,horizon);const matches=await matchWaitlist(locationId,localGaps);for(const gap of localGaps){const match=matches.find((m:any)=>m.employee_id===gap.employee_id&&m.gap_start===gap.start);gaps.push({...gap,waitlist_match:match||null});}}
  const summary={gaps:gaps.length,gap_minutes:gaps.reduce((s,x)=>s+Number(x.minutes||0),0),estimated_open_capacity_value:gaps.reduce((s,x)=>s+Number(x.estimated_value||0),0),matched_gaps:gaps.filter(x=>x.waitlist_match).length};
  return res.json({ok:true,horizon_days:horizon,summary,gaps:gaps.slice(0,160)});
}catch(error:any){return res.status(500).json({ok:false,error:error?.message||"vir_capacity_failed"})}});

router.get("/no-show",async(req:AuthRequest,res:Response)=>{try{
  const scope=await resolveScope(req,res);if(!scope)return;const days=Math.max(1,Math.min(60,Number(req.query.days||14)||14));const ids=await tenantLocations(scope);const candidates:any[]=[];
  for(const locationId of ids){for(const row of await upcomingRiskCandidates(locationId,days))candidates.push({...row,location_id:locationId});}
  candidates.sort((a,b)=>Number(b.score||0)-Number(a.score||0));
  return res.json({ok:true,days,summary:{elevated:candidates.length,high:candidates.filter(x=>Number(x.score||0)>=70).length,medium:candidates.filter(x=>Number(x.score||0)>=40&&Number(x.score||0)<70).length},candidates:candidates.slice(0,160)});
}catch(error:any){return res.status(500).json({ok:false,error:error?.message||"vir_no_show_failed"})}});

export default router;
