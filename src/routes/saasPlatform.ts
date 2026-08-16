import { NextFunction, Response, Router } from "express";
import db from "../db";
import { TenantAuthRequest } from "../middleware/tenantContext";

const router = Router();

const SYSTEM_ADMIN_ROLES = new Set(["admin","administrator","rendszergazda","superadmin","super_admin","platform_admin"]);
const parseRoles = (raw:any):string[] => {
  if(Array.isArray(raw)) return raw.map(String).map(x=>x.toLowerCase());
  try { const parsed=JSON.parse(String(raw||"")); if(Array.isArray(parsed)) return parsed.map(String).map(x=>x.toLowerCase()); } catch {}
  return String(raw||"").replace(/[\[\]"]/g,"").split(",").map(x=>x.trim().toLowerCase()).filter(Boolean);
};

function requirePlatformAdmin(req:TenantAuthRequest,res:Response,next:NextFunction){
  const roles=parseRoles(req.user?.role);
  const isSystemAdmin=roles.some(role=>SYSTEM_ADMIN_ROLES.has(role));
  const isRootTenant=String(req.tenant?.slug||"").toLowerCase()==="kleopatra";
  if(!isSystemAdmin||!isRootTenant){
    return res.status(403).json({ok:false,code:"PLATFORM_ADMIN_FORBIDDEN",error:"A platformszintű tenant-kezelés csak a központi rendszergazda számára érhető el."});
  }
  return next();
}
router.use(requirePlatformAdmin);

router.get("/tenants",async(_req:TenantAuthRequest,res:Response)=>{
  try{
    const {rows}=await db.query(`
      SELECT t.id::text,t.slug,t.name,t.legal_name,t.tax_number,t.billing_email,t.status,t.default_locale,t.default_currency,t.timezone,t.created_at,t.updated_at,
             s.id::text subscription_id,s.status subscription_status,s.current_period_end,s.cancel_at_period_end,
             sp.code plan_code,sp.name plan_name,sp.monthly_price,sp.currency plan_currency,
             COALESCE(lc.location_count,0)::int location_count,
             COALESCE(uc.user_count,0)::int user_count,
             COALESCE(fc.franchise_location_count,0)::int franchise_location_count
        FROM tenants t
        LEFT JOIN LATERAL (
          SELECT s1.* FROM subscriptions s1
           WHERE s1.tenant_id=t.id
           ORDER BY CASE WHEN s1.status IN ('trial','active','past_due','suspended') THEN 0 ELSE 1 END,s1.created_at DESC
           LIMIT 1
        ) s ON true
        LEFT JOIN subscription_plans sp ON sp.id=s.plan_id
        LEFT JOIN LATERAL (SELECT count(*) location_count FROM locations l WHERE l.tenant_id=t.id) lc ON true
        LEFT JOIN LATERAL (SELECT count(*) user_count FROM tenant_users tu WHERE tu.tenant_id=t.id AND tu.active=true) uc ON true
        LEFT JOIN LATERAL (SELECT count(*) franchise_location_count FROM franchise_members fm WHERE fm.tenant_id=t.id AND fm.active=true AND fm.member_type='franchise') fc ON true
       ORDER BY CASE WHEN t.slug='kleopatra' THEN 0 ELSE 1 END,t.name`);
    return res.json({ok:true,rows});
  }catch(error){console.error("[SAAS PLATFORM] tenant list:",error);return res.status(500).json({ok:false,error:"A tenant lista nem tölthető be."});}
});

router.post("/tenants",async(req:TenantAuthRequest,res:Response)=>{
  const slug=String(req.body?.slug||"").trim().toLowerCase();
  const name=String(req.body?.name||"").trim();
  const legalName=String(req.body?.legal_name||"").trim()||null;
  const taxNumber=String(req.body?.tax_number||"").trim()||null;
  const billingEmail=String(req.body?.billing_email||"").trim().toLowerCase()||null;
  const planCode=String(req.body?.plan_code||"start").trim().toLowerCase();
  const status=req.body?.status==="trial"?"trial":"active";
  if(!/^[a-z0-9][a-z0-9-]{2,62}$/.test(slug))return res.status(400).json({ok:false,error:"A tenant slug 3–63 karakteres, kisbetűs betű/szám/kötőjel formátumú legyen."});
  if(name.length<2||name.length>160)return res.status(400).json({ok:false,error:"A tenant neve 2–160 karakter lehet."});
  if(billingEmail&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(billingEmail))return res.status(400).json({ok:false,error:"Érvénytelen számlázási e-mail cím."});
  const client=await db.connect();
  try{
    await client.query("BEGIN");
    const plan=await client.query(`SELECT id,code,name,features FROM subscription_plans WHERE code=$1 AND active=true LIMIT 1`,[planCode]);
    if(!plan.rowCount){await client.query("ROLLBACK");return res.status(404).json({ok:false,error:"Az előfizetési csomag nem található."});}
    const tenant=await client.query(`INSERT INTO tenants(slug,name,legal_name,tax_number,billing_email,status) VALUES($1,$2,$3,$4,$5,$6) RETURNING id::text,slug,name,legal_name,status`,[slug,name,legalName,taxNumber,billingEmail,status]);
    const tenantId=tenant.rows[0].id;
    await client.query(`INSERT INTO tenant_settings(tenant_id,settings) VALUES($1::bigint,'{}'::jsonb) ON CONFLICT(tenant_id) DO NOTHING`,[tenantId]);
    await client.query(`INSERT INTO subscriptions(tenant_id,plan_id,status,trial_ends_at) VALUES($1::bigint,$2,$3,CASE WHEN $3='trial' THEN now()+interval '14 days' ELSE NULL END)`,[tenantId,plan.rows[0].id,status]);
    await client.query(`INSERT INTO subscription_events(tenant_id,subscription_id,event_type,source,payload)
      SELECT $1::bigint,s.id,'tenant_created','platform_admin',$2::jsonb FROM subscriptions s WHERE s.tenant_id=$1::bigint ORDER BY s.created_at DESC LIMIT 1`,[tenantId,JSON.stringify({plan_code:plan.rows[0].code,created_by:String(req.user?.id||"")})]);
    await client.query("COMMIT");
    return res.status(201).json({ok:true,tenant:tenant.rows[0],plan:plan.rows[0]});
  }catch(error:any){await client.query("ROLLBACK").catch(()=>{});if(error?.code==="23505")return res.status(409).json({ok:false,error:"Ez a tenant slug már foglalt."});console.error("[SAAS PLATFORM] tenant create:",error);return res.status(500).json({ok:false,error:"A tenant nem hozható létre."});}finally{client.release();}
});

router.patch("/tenants/:tenantId/status",async(req:TenantAuthRequest,res:Response)=>{
  const tenantId=String(req.params.tenantId||"").trim();
  const status=String(req.body?.status||"").trim().toLowerCase();
  if(!/^\d+$/.test(tenantId))return res.status(400).json({ok:false,error:"Érvénytelen tenant azonosító."});
  if(!["active","trial","suspended","cancelled"].includes(status))return res.status(400).json({ok:false,error:"Érvénytelen tenant státusz."});
  try{
    const current=await db.query(`SELECT id,slug,status FROM tenants WHERE id=$1::bigint LIMIT 1`,[tenantId]);
    if(!current.rowCount)return res.status(404).json({ok:false,error:"A tenant nem található."});
    if(current.rows[0].slug==="kleopatra"&&status!=="active")return res.status(409).json({ok:false,code:"ROOT_TENANT_PROTECTED",error:"A központi Kleopátra tenant nem függeszthető fel vagy törölhető ezen a felületen."});
    const {rows}=await db.query(`UPDATE tenants SET status=$2,updated_at=now() WHERE id=$1::bigint RETURNING id::text,slug,name,status,updated_at`,[tenantId,status]);
    return res.json({ok:true,tenant:rows[0]});
  }catch(error){console.error("[SAAS PLATFORM] tenant status:",error);return res.status(500).json({ok:false,error:"A tenant státusza nem módosítható."});}
});

router.post("/tenants/:tenantId/users",async(req:TenantAuthRequest,res:Response)=>{
  const tenantId=String(req.params.tenantId||"").trim();
  const userId=String(req.body?.user_id||"").trim();
  const role=String(req.body?.tenant_role||"member").trim().toLowerCase();
  if(!/^\d+$/.test(tenantId)||!userId)return res.status(400).json({ok:false,error:"A tenant_id és user_id kötelező."});
  if(!["owner","admin","manager","member"].includes(role))return res.status(400).json({ok:false,error:"Érvénytelen tenant szerepkör."});
  try{
    const tenant=await db.query(`SELECT id FROM tenants WHERE id=$1::bigint LIMIT 1`,[tenantId]);if(!tenant.rowCount)return res.status(404).json({ok:false,error:"A tenant nem található."});
    const userTable=await db.query(`SELECT to_regclass('public.users') IS NOT NULL ok`);
    if(userTable.rows[0]?.ok){const user=await db.query(`SELECT id::text FROM users WHERE id::text=$1 LIMIT 1`,[userId]);if(!user.rowCount)return res.status(404).json({ok:false,error:"A felhasználó nem található."});}
    const {rows}=await db.query(`INSERT INTO tenant_users(tenant_id,user_id,tenant_role,active) VALUES($1::bigint,$2,$3,true) ON CONFLICT(tenant_id,user_id) DO UPDATE SET tenant_role=EXCLUDED.tenant_role,active=true RETURNING tenant_id::text,user_id,tenant_role,active`,[tenantId,userId,role]);
    return res.status(201).json({ok:true,membership:rows[0]});
  }catch(error){console.error("[SAAS PLATFORM] tenant user:",error);return res.status(500).json({ok:false,error:"A tenant felhasználó-hozzárendelés nem menthető."});}
});

export default router;
