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

router.get("/profitability",async(req:AuthRequest,res:Response)=>{try{
  const scope=await resolveScope(req,res);if(!scope)return;const today=businessDate(),from=dateValue(req.query.from,today),to=dateValue(req.query.to,today);
  const {rows}=await pool.query(`
    WITH base AS (
      SELECT w.id,w.location_id,w.employee_id,
        COALESCE(NULLIF(to_jsonb(w)->>'total_amount','')::numeric,NULLIF(to_jsonb(w)->>'grand_total','')::numeric,NULLIF(to_jsonb(w)->>'total','')::numeric,
          (SELECT COALESCE(SUM(COALESCE(NULLIF(to_jsonb(i)->>'line_total','')::numeric,0)),0) FROM work_order_items i WHERE i.work_order_id=w.id),0)::numeric revenue
      FROM work_orders w
      WHERE w.tenant_id=$1::uuid AND w.created_at::date BETWEEN $2::date AND $3::date
        AND ($4::uuid IS NULL OR w.location_id=$4::uuid)
        AND lower(COALESCE(w.status,'')) NOT IN('waiting','arrived','in_progress','cancelled','no_show')
    ), costs AS (
      SELECT b.id,
        COALESCE((SELECT SUM(CASE WHEN lower(COALESCE(i.item_type,''))='product' THEN COALESCE(NULLIF(to_jsonb(i)->>'cost_total','')::numeric,NULLIF(to_jsonb(i)->>'cost_price','')::numeric*COALESCE(NULLIF(to_jsonb(i)->>'quantity','')::numeric,1),0) ELSE 0 END) FROM work_order_items i WHERE i.work_order_id=b.id),0)::numeric material_cost,
        COALESCE((SELECT SUM(COALESCE(NULLIF(to_jsonb(c)->>'amount','')::numeric,NULLIF(to_jsonb(c)->>'commission_amount','')::numeric,0)) FROM work_order_commission_events c WHERE c.work_order_id=b.id),0)::numeric commission_cost
      FROM base b
    ), x AS (SELECT b.*,c.material_cost,c.commission_cost,(b.revenue-c.material_cost-c.commission_cost)::numeric contribution_margin FROM base b JOIN costs c ON c.id=b.id)
    SELECT COALESCE(SUM(revenue),0)::numeric revenue,COALESCE(SUM(material_cost),0)::numeric material_cost,COALESCE(SUM(commission_cost),0)::numeric commission_cost,
      COALESCE(SUM(contribution_margin),0)::numeric contribution_margin,CASE WHEN COALESCE(SUM(revenue),0)>0 THEN ROUND(SUM(contribution_margin)/SUM(revenue)*100,2) ELSE 0 END margin_percent,COUNT(*)::int closed_workorders
    FROM x`,[scope.tenantId,from,to,scope.locationId]);
  const byLocation=await pool.query(`
    WITH base AS (
      SELECT w.id,w.location_id,COALESCE(NULLIF(to_jsonb(w)->>'total_amount','')::numeric,NULLIF(to_jsonb(w)->>'grand_total','')::numeric,NULLIF(to_jsonb(w)->>'total','')::numeric,(SELECT COALESCE(SUM(COALESCE(NULLIF(to_jsonb(i)->>'line_total','')::numeric,0)),0) FROM work_order_items i WHERE i.work_order_id=w.id),0)::numeric revenue
      FROM work_orders w WHERE w.tenant_id=$1::uuid AND w.created_at::date BETWEEN $2::date AND $3::date AND ($4::uuid IS NULL OR w.location_id=$4::uuid) AND lower(COALESCE(w.status,'')) NOT IN('waiting','arrived','in_progress','cancelled','no_show')
    ), x AS (
      SELECT b.*,COALESCE((SELECT SUM(CASE WHEN lower(COALESCE(i.item_type,''))='product' THEN COALESCE(NULLIF(to_jsonb(i)->>'cost_total','')::numeric,NULLIF(to_jsonb(i)->>'cost_price','')::numeric*COALESCE(NULLIF(to_jsonb(i)->>'quantity','')::numeric,1),0) ELSE 0 END) FROM work_order_items i WHERE i.work_order_id=b.id),0)::numeric material_cost,
      COALESCE((SELECT SUM(COALESCE(NULLIF(to_jsonb(c)->>'amount','')::numeric,NULLIF(to_jsonb(c)->>'commission_amount','')::numeric,0)) FROM work_order_commission_events c WHERE c.work_order_id=b.id),0)::numeric commission_cost FROM base b)
    SELECT x.location_id,l.name location_name,COALESCE(SUM(revenue),0)::numeric revenue,COALESCE(SUM(material_cost),0)::numeric material_cost,COALESCE(SUM(commission_cost),0)::numeric commission_cost,
      COALESCE(SUM(revenue-material_cost-commission_cost),0)::numeric contribution_margin,CASE WHEN COALESCE(SUM(revenue),0)>0 THEN ROUND(SUM(revenue-material_cost-commission_cost)/SUM(revenue)*100,2) ELSE 0 END margin_percent,COUNT(*)::int closed_workorders
    FROM x LEFT JOIN locations l ON l.id=x.location_id GROUP BY x.location_id,l.name ORDER BY contribution_margin DESC`,[scope.tenantId,from,to,scope.locationId]);
  return res.json({ok:true,from,to,summary:rows[0]||{},by_location:byLocation.rows,cost_model:{includes_material_cost:true,includes_commission_cost:true,wage_allocation:"next_phase"}});
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
