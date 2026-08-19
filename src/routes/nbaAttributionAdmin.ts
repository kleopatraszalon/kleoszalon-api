import {Router,Response,NextFunction} from "express";
import {requireAuth} from "../middleware/auth";
import {requireTenantContext,TenantAuthRequest} from "../middleware/tenantContext";
import {attributionSummary,ensureNbaRevenueAttribution} from "../services/nbaRevenueAttribution";

const router=Router();
const MANAGEMENT_ROLES=new Set(["admin","administrator","rendszergazda","superadmin","super_admin","manager","vezető","vezeto","location_manager","salon_manager","szalonvezető","szalonvezeto","üzletvezető","uzletvezeto"]);
const LOCATION_ROLES=new Set(["location_manager","salon_manager","szalonvezető","szalonvezeto","üzletvezető","uzletvezeto"]);
function roles(raw:unknown){if(Array.isArray(raw))return raw.map(String).map(x=>x.toLowerCase());const text=String(raw??"");try{const parsed=JSON.parse(text);if(Array.isArray(parsed))return parsed.map(String).map(x=>x.toLowerCase())}catch{}return text.split(",").map(x=>x.replace(/[\[\]"]/g,"").trim().toLowerCase()).filter(Boolean)}
function requireManagement(req:TenantAuthRequest,res:Response,next:NextFunction){if(!roles(req.user?.role).some(r=>MANAGEMENT_ROLES.has(r)))return res.status(403).json({ok:false,code:"NBA_ATTRIBUTION_FORBIDDEN",error:"Ehhez a kimutatáshoz vezetői jogosultság szükséges."});next()}
function locationScope(req:TenantAuthRequest){const rs=roles(req.user?.role);if(rs.some(r=>LOCATION_ROLES.has(r)))return String(req.user?.location_id||"").trim()||"__missing__";return String(req.query.location_id||"").trim()||null}

router.use(requireAuth,requireTenantContext,requireManagement);
router.get("/summary",async(req:TenantAuthRequest,res:Response,next)=>{
  try{
    await ensureNbaRevenueAttribution();
    const locationId=locationScope(req);if(locationId==="__missing__")return res.status(403).json({ok:false,code:"LOCATION_SCOPE_REQUIRED",error:"A felhasználóhoz nincs telephely rendelve."});
    const days=Math.max(1,Math.min(365,Number(req.query.days||30)||30));
    const summary=await attributionSummary(String(req.tenant!.id),days,locationId);
    return res.json({ok:true,scope:{tenant_id:String(req.tenant!.id),location_id:locationId},summary});
  }catch(error){next(error)}
});

export default router;
