import { Router, Response } from "express";
import pool from "../db";
import type { AuthRequest } from "../middleware/auth";
import { requireManagement } from "../middleware/requireRoles";
import { findCalendarGaps, matchWaitlist, upcomingRiskCandidates } from "../booking/virWave1Engine";
import { profitEngine } from "../services/virWave2Engine";
import virP23Router from "./virP23";
import virP24Router from "./virP24";
import virP25Router from "./virP25";

const router=Router();
router.use(requireManagement);
router.use('/p23',virP23Router);
router.use('/p24',virP24Router);
router.use('/p25',virP25Router);

type Scope={tenantId:string;locationId:string|null};
function businessDate(){const parts=new Intl.DateTimeFormat("en-GB",{timeZone:process.env.BUSINESS_TIMEZONE||"Europe/Budapest",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date());const p=Object.fromEntries(parts.map(x=>[x.type,x.value]));return `${p.year}-${p.month}-${p.day}`}
function dateValue(v:unknown,fallback:string){const s=String(v||"");return /^\d{4}-\d{2}-\d{2}$/.test(s)?s:fallback}
async function resolveScope(req:AuthRequest,res:Response):Promise<Scope|undefined>{const tenantId=String(req.user?.tenant_id||"").trim();if(!/^\d+$/.test(tenantId)||Number(tenantId)<=0){res.status(403).json({ok:false,error:"tenant_context_required"});return}const requested=String(req.query.locationId||req.query.location_id||"").trim();if(!requested)return{tenantId,locationId:null};const {rows}=await pool.query(`SELECT id::text FROM locations WHERE id=$1::uuid AND tenant_id=$2::bigint LIMIT 1`,[requested,tenantId]);if(!rows[0]){res.status(403).json({ok:false,error:"A telephely nem tartozik a felhasználó tenantjához."});return}return{tenantId,locationId:requested}}
async function tenantLocations(scope:Scope){if(scope.locationId)return[scope.locationId];const {rows}=await pool.query(`SELECT id::text FROM locations WHERE tenant_id=$1::bigint ORDER BY name`,[scope.tenantId]);return rows.map((r:any)=>String(r.id))}

router.get("/profitability",async(req:AuthRequest,res:Response)=>{try{
  const scope=await resolveScope(req,res);if(!scope)return;const today=businessDate(),from=dateValue(req.query.from,today),to=dateValue(req.query.to,today),targetMargin=Math.max(0,Math.min(100,Number(req.query.targetMargin||35)||35));
  const ids=await tenantLocations(scope);const locationNames=new Map<string,string>();
  if(ids.length){const {rows}=await pool.query(`SELECT id::text,name FROM locations WHERE tenant_id=$1::bigint AND id=ANY($2::uuid[])`,[scope.tenantId,ids]);for(const row of rows)locationNames.set(String(row.id),String(row.name||"Telephely"));}
  const runs=await Promise.all(ids.map(async locationId=>({locationId,result:await profitEngine({locationId,from,to,targetMargin})})));
  const summary={revenue:0,material_cost:0,labor_cost:0,commission_cost:0,gross_profit:0,margin_percent:0,below_target:0,missing_recipe:0};const serviceMap=new Map<string,any>();
  const by_location=runs.map(({locationId,result})=>{const s=result.summary as any;summary.revenue+=Number(s.revenue||0);summary.material_cost+=Number(s.material_cost||0);summary.labor_cost+=Number(s.labor_cost||0);summary.commission_cost+=Number(s.commission_cost||0);summary.gross_profit+=Number(s.gross_profit||0);summary.below_target+=Number(s.below_target||0);summary.missing_recipe+=Number(s.missing_recipe||0);for(const row of result.services as any[]){const key=String(row.service_id),cur=serviceMap.get(key)||{service_id:key,service_name:row.service_name,revenue:0,material_cost:0,labor_cost:0,commission_cost:0,gross_profit:0,completed_lines:0,service_quantity:0,recipe_complete:true};for(const k of["revenue","material_cost","labor_cost","commission_cost","gross_profit","completed_lines","service_quantity"])cur[k]+=Number(row[k]||0);cur.recipe_complete=cur.recipe_complete&&Boolean(row.recipe_complete);serviceMap.set(key,cur);}return{location_id:locationId,location_name:locationNames.get(locationId)||"Telephely",...s};});
  summary.margin_percent=summary.revenue>0?Math.round(summary.gross_profit/summary.revenue*10000)/100:0;const services=Array.from(serviceMap.values()).map((r:any)=>({...r,margin_percent:r.revenue>0?Math.round(r.gross_profit/r.revenue*10000)/100:0,profit_per_minute:null,below_target:r.revenue>0?r.gross_profit/r.revenue*100<targetMargin:false})).sort((a:any,b:any)=>b.gross_profit-a.gross_profit);
  return res.json({ok:true,from,to,target_margin_percent:targetMargin,summary,by_location,services,cost_model:{canonical_engine:"VIR Wave II profitEngine",includes_material_cost:true,includes_direct_labor:true,includes_commission_cost:true,cost_basis:"current_recipe_and_stock_unit_cost",excludes_employer_contributions_and_overhead:true}});
}catch(error:any){return res.status(500).json({ok:false,error:error?.message||"vir_profitability_failed"})}});

router.get("/capacity",async(req:AuthRequest,res:Response)=>{try{const scope=await resolveScope(req,res);if(!scope)return;const horizon=Math.max(1,Math.min(31,Number(req.query.horizonDays||7)||7));const ids=await tenantLocations(scope);const gaps:any[]=[];for(const locationId of ids){const localGaps=await findCalendarGaps(locationId,horizon);const matches=await matchWaitlist(locationId,localGaps);for(const gap of localGaps){const match=matches.find((m:any)=>m.employee_id===gap.employee_id&&m.gap_start===gap.start);gaps.push({...gap,waitlist_match:match||null});}}gaps.sort((a,b)=>Number(b.estimated_value||0)-Number(a.estimated_value||0));const summary={gaps:gaps.length,gap_minutes:gaps.reduce((s,x)=>s+Number(x.minutes||0),0),estimated_open_capacity_value:gaps.reduce((s,x)=>s+Number(x.estimated_value||0),0),matched_gaps:gaps.filter(x=>x.waitlist_match).length};return res.json({ok:true,horizon_days:horizon,summary,gaps:gaps.slice(0,160)});}catch(error:any){return res.status(500).json({ok:false,error:error?.message||"vir_capacity_failed"})}});

router.get("/no-show",async(req:AuthRequest,res:Response)=>{try{const scope=await resolveScope(req,res);if(!scope)return;const days=Math.max(1,Math.min(60,Number(req.query.days||14)||14));const ids=await tenantLocations(scope);const candidates:any[]=[];for(const locationId of ids){for(const row of await upcomingRiskCandidates(locationId,days))candidates.push({...row,location_id:locationId});}candidates.sort((a,b)=>Number(b.score||0)-Number(a.score||0));return res.json({ok:true,days,summary:{elevated:candidates.length,high:candidates.filter(x=>Number(x.score||0)>=70).length,medium:candidates.filter(x=>Number(x.score||0)>=40&&Number(x.score||0)<70).length},candidates:candidates.slice(0,160)});}catch(error:any){return res.status(500).json({ok:false,error:error?.message||"vir_no_show_failed"})}});

export default router;