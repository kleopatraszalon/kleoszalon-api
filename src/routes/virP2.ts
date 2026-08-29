import {Router,Response} from "express";
import pool from "../db";
import type {AuthRequest} from "../middleware/auth";
import {requireManagement} from "../middleware/requireRoles";
import {askExecutiveAssistant,collectExecutiveSignals,currentBudapestDate,runExecutiveBrief} from "../services/executiveAiAssistant";

const router=Router();
router.use(requireManagement);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const num=(v:unknown)=>Number.isFinite(Number(v))?Number(v):0;
type Scope={tenantId:string;locationId:string|null};
async function scope(req:AuthRequest,res:Response):Promise<Scope|undefined>{
  const tenantId=String(req.user?.tenant_id||"").trim();if(!tenantId){res.status(403).json({ok:false,error:"A felhasználóhoz nincs tenant rendelve."});return}
  const requested=String(req.query.locationId||req.body?.locationId||req.query.location_id||req.body?.location_id||"").trim();
  if(!requested)return{tenantId,locationId:null};if(!UUID.test(requested)){res.status(400).json({ok:false,error:"Érvénytelen telephelyazonosító."});return}
  const row=(await pool.query(`SELECT id::text FROM locations WHERE id=$1::uuid AND tenant_id=$2::uuid`,[requested,tenantId])).rows[0];if(!row){res.status(403).json({ok:false,error:"A telephely nem tartozik a tenantjához."});return}
  return{tenantId,locationId:requested};
}
async function tenantLocations(s:Scope){if(s.locationId)return(await pool.query(`SELECT id::text,name FROM locations WHERE id=$1::uuid AND tenant_id=$2::uuid`,[s.locationId,s.tenantId])).rows;return(await pool.query(`SELECT id::text,name FROM locations WHERE tenant_id=$1::uuid ORDER BY name`,[s.tenantId])).rows;}

router.post("/copilot/ask",async(req:AuthRequest,res:Response)=>{try{
  const s=await scope(req,res);if(!s)return;const question=String(req.body?.question||"").trim();if(!question)return res.status(400).json({ok:false,error:"A kérdés nem lehet üres."});
  const date=String(req.body?.date||currentBudapestDate());if(s.locationId){const answer=await askExecutiveAssistant(question,date,s.locationId);return res.json({ok:true,...answer,mode:"canonical_executive_ai"});}
  const locations=await tenantLocations(s);const briefs=[] as any[];for(const loc of locations.slice(0,12)){const brief=await runExecutiveBrief(date,String(loc.id),{runType:"p2-copilot",persist:false,notify:false,useAi:false});briefs.push({location_id:loc.id,location_name:loc.name,status:brief.status,signals:brief.signals.filter(x=>x.severity==='critical'||x.severity==='warning').slice(0,4)});}
  const critical=briefs.flatMap(x=>x.signals.filter((y:any)=>y.severity==='critical').map((y:any)=>`${x.location_name}: ${y.headline}`));const warnings=briefs.flatMap(x=>x.signals.filter((y:any)=>y.severity==='warning').map((y:any)=>`${x.location_name}: ${y.headline}`));
  return res.json({ok:true,business_date:date,location_id:null,question,ai_used:false,mode:"tenant_safe_deterministic_rollup",answer:`Hálózati összkép: ${critical.length} kritikus és ${warnings.length} figyelmeztető jelzés. ${critical.slice(0,3).join(' · ')||warnings.slice(0,3).join(' · ')||'Nincs kiemelt eltérés.'}`,briefs});
}catch(e:any){return res.status(e?.status||500).json({ok:false,error:e?.message||"copilot_failed"})}});

router.get("/anomalies",async(req:AuthRequest,res:Response)=>{try{
  const s=await scope(req,res);if(!s)return;const date=String(req.query.date||currentBudapestDate());const locations=await tenantLocations(s);const items=[] as any[];
  for(const loc of locations){const signals=await collectExecutiveSignals(date,String(loc.id));for(const signal of signals.filter(x=>x.severity==='critical'||x.severity==='warning'))items.push({location_id:String(loc.id),location_name:loc.name,key:signal.key,label:signal.label,severity:signal.severity,headline:signal.headline,value:signal.value??null,baseline:signal.baseline??null,delta_pct:signal.delta_pct??null,recommendation:signal.recommendation,evidence:signal.evidence});}
  const rank:any={critical:0,warning:1};items.sort((a,b)=>rank[a.severity]-rank[b.severity]||Math.abs(num(b.delta_pct))-Math.abs(num(a.delta_pct)));
  return res.json({ok:true,business_date:date,summary:{critical:items.filter(x=>x.severity==='critical').length,warning:items.filter(x=>x.severity==='warning').length,affected_locations:new Set(items.map(x=>x.location_id)).size},items:items.slice(0,250),canonical_engine:"executiveAiAssistant.collectExecutiveSignals"});
}catch(e:any){return res.status(500).json({ok:false,error:e?.message||"anomaly_failed"})}});

router.get("/summaries",async(req:AuthRequest,res:Response)=>{try{
  const s=await scope(req,res);if(!s)return;const date=String(req.query.date||currentBudapestDate());const locations=await tenantLocations(s);const summaries=[] as any[];
  for(const loc of locations){const brief=await runExecutiveBrief(date,String(loc.id),{runType:"p2-live",persist:false,notify:false,useAi:false});summaries.push({location_id:String(loc.id),location_name:loc.name,status:brief.status,narrative:brief.narrative,recommendations:brief.recommendations,signals:brief.signals.filter(x=>x.severity!=='ok').slice(0,8)});}
  return res.json({ok:true,business_date:date,automation:{timezone:"Europe/Budapest",runs:["08:10","13:10","20:10"],autonomous_actions:false},summaries});
}catch(e:any){return res.status(500).json({ok:false,error:e?.message||"summary_failed"})}});

router.get("/benchmark",async(req:AuthRequest,res:Response)=>{try{
  const s=await scope(req,res);if(!s)return;const days=Math.max(7,Math.min(90,Number(req.query.days||30)));const rows=(await pool.query(`
    WITH base AS (
      SELECT l.id,l.name,
        COUNT(DISTINCT a.id)::int appointments,
        COUNT(DISTINCT a.id) FILTER(WHERE lower(COALESCE(a.status,'')) IN('completed','done'))::int completed,
        COUNT(DISTINCT a.id) FILTER(WHERE lower(COALESCE(a.status,'')) IN('no_show','no-show','noshow'))::int no_shows,
        COALESCE(SUM(COALESCE(aps.price,0)),0)::numeric revenue
      FROM locations l LEFT JOIN appointments a ON a.location_id=l.id AND a.start_time>=now()-($2::text||' days')::interval
      LEFT JOIN appointment_services aps ON aps.appointment_id=a.id
      WHERE l.tenant_id=$1::uuid GROUP BY l.id,l.name
    ) SELECT * FROM base ORDER BY revenue DESC,name`,[s.tenantId,days])).rows;
  const data=rows.map((r:any)=>({location_id:String(r.id),location_name:r.name,appointments:num(r.appointments),completed:num(r.completed),no_shows:num(r.no_shows),revenue:num(r.revenue),avg_booking:num(r.appointments)?Math.round(num(r.revenue)/num(r.appointments)):0,completion_rate:num(r.appointments)?Math.round(num(r.completed)/num(r.appointments)*1000)/10:0,no_show_rate:num(r.appointments)?Math.round(num(r.no_shows)/num(r.appointments)*1000)/10:0}));
  const avg=(key:string)=>data.length?data.reduce((a:number,x:any)=>a+num(x[key]),0)/data.length:0;const netAvg={revenue:avg('revenue'),avg_booking:avg('avg_booking'),completion_rate:avg('completion_rate'),no_show_rate:avg('no_show_rate')};
  const scored=data.map((x:any)=>{const score=Math.round(Math.max(0,Math.min(100,50+(netAvg.revenue?((x.revenue-netAvg.revenue)/netAvg.revenue)*20:0)+(netAvg.avg_booking?((x.avg_booking-netAvg.avg_booking)/netAvg.avg_booking)*15:0)+(x.completion_rate-netAvg.completion_rate)*.8-(x.no_show_rate-netAvg.no_show_rate)*1.2)));return{...x,benchmark_score:score,revenue_vs_network_pct:netAvg.revenue?Math.round((x.revenue-netAvg.revenue)/netAvg.revenue*1000)/10:0,rank:0}}).sort((a,b)=>b.benchmark_score-a.benchmark_score).map((x,i)=>({...x,rank:i+1}));
  return res.json({ok:true,days,network_average:netAvg,locations:scored});
}catch(e:any){return res.status(500).json({ok:false,error:e?.message||"benchmark_failed"})}});

export default router;
