import {Router,Response,NextFunction} from "express";
import pool from "../db";
import {requireAuth} from "../middleware/auth";
import {requireTenantContext,TenantAuthRequest} from "../middleware/tenantContext";
import {attributionSummary,ensureNbaRevenueAttribution} from "../services/nbaRevenueAttribution";

const router=Router();
const MANAGEMENT_ROLES=new Set(["admin","administrator","rendszergazda","superadmin","super_admin","manager","vezető","vezeto","location_manager","salon_manager","szalonvezető","szalonvezeto","üzletvezető","uzletvezeto"]);
const LOCATION_ROLES=new Set(["location_manager","salon_manager","szalonvezető","szalonvezeto","üzletvezető","uzletvezeto"]);
function roles(raw:unknown){if(Array.isArray(raw))return raw.map(String).map(x=>x.toLowerCase());const text=String(raw??"");try{const parsed=JSON.parse(text);if(Array.isArray(parsed))return parsed.map(String).map(x=>x.toLowerCase())}catch{}return text.split(",").map(x=>x.replace(/[\[\]"]/g,"").trim().toLowerCase()).filter(Boolean)}
function requireManagement(req:TenantAuthRequest,res:Response,next:NextFunction){if(!roles(req.user?.role).some(r=>MANAGEMENT_ROLES.has(r)))return res.status(403).json({ok:false,code:"NBA_ATTRIBUTION_FORBIDDEN",error:"Ehhez a kimutatáshoz vezetői jogosultság szükséges."});next()}
function locationScope(req:TenantAuthRequest){const rs=roles(req.user?.role);if(rs.some(r=>LOCATION_ROLES.has(r)))return String(req.user?.location_id||"").trim()||"__missing__";return String(req.query.location_id||"").trim()||null}

async function applyLocationDenominator(summary:any,tenantId:string,days:number,locationId:string|null){
  if(!locationId)return summary;
  const scoped=(await pool.query(`
    WITH scoped_jobs AS (
      SELECT j.id,j.action_code,j.channel
      FROM crm_nba_marketing_jobs j
      JOIN clients c ON c.id::text=j.client_id
      WHERE j.tenant_id=$1::bigint
        AND j.sent_at>=now()-($2::int||' days')::interval
        AND (to_jsonb(c)->>'location_id')=$3::text
    ), landed AS (
      SELECT DISTINCT t.job_id FROM crm_nba_marketing_touches t JOIN scoped_jobs j ON j.id=t.job_id
    )
    SELECT (SELECT COUNT(*) FROM scoped_jobs)::int sent_jobs,(SELECT COUNT(*) FROM landed)::int landed_jobs`,[tenantId,days,locationId])).rows[0]||{};
  const actionCounts=(await pool.query(`
    SELECT j.action_code,j.channel,COUNT(*)::int sent
    FROM crm_nba_marketing_jobs j
    JOIN clients c ON c.id::text=j.client_id
    WHERE j.tenant_id=$1::bigint
      AND j.sent_at>=now()-($2::int||' days')::interval
      AND (to_jsonb(c)->>'location_id')=$3::text
    GROUP BY j.action_code,j.channel`,[tenantId,days,locationId])).rows;
  const countMap=new Map(actionCounts.map((r:any)=>[`${r.action_code}:${r.channel}`,Number(r.sent||0)]));
  const sent=Number(scoped.sent_jobs||0),bookings=Number(summary.attributed_bookings||0),revenue=Number(summary.paid_revenue||0);
  summary.sent_jobs=sent;
  summary.landed_jobs=Number(scoped.landed_jobs||0);
  summary.conversion_rate_percent=sent?Number((bookings/sent*100).toFixed(2)):0;
  summary.revenue_per_send=sent?Number((revenue/sent).toFixed(2)):0;
  summary.action_rows=(summary.action_rows||[]).map((row:any)=>{
    const scopedSent=Number(countMap.get(`${row.action_code}:${row.channel}`)||0);
    return {...row,sent:scopedSent,conversion_rate_percent:scopedSent?Number((Number(row.conversions||0)/scopedSent*100).toFixed(2)):0};
  });
  return summary;
}

router.use(requireAuth,requireTenantContext,requireManagement);
router.get("/summary",async(req:TenantAuthRequest,res:Response,next)=>{
  try{
    await ensureNbaRevenueAttribution();
    const locationId=locationScope(req);if(locationId==="__missing__")return res.status(403).json({ok:false,code:"LOCATION_SCOPE_REQUIRED",error:"A felhasználóhoz nincs telephely rendelve."});
    const days=Math.max(1,Math.min(365,Number(req.query.days||30)||30));
    let summary=await attributionSummary(String(req.tenant!.id),days,locationId);
    summary=await applyLocationDenominator(summary,String(req.tenant!.id),days,locationId);
    return res.json({ok:true,scope:{tenant_id:String(req.tenant!.id),location_id:locationId},summary});
  }catch(error){next(error)}
});

export default router;
