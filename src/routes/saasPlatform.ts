import { NextFunction, Response, Router } from "express";
import db from "../db";
import { TenantAuthRequest } from "../middleware/tenantContext";
import saasOnboardingRouter from "./saasOnboarding";
import { issueTenantAdminInvitation, latestTenantAdminInvitation } from "../services/tenantAdminInvitations";

const router = Router();

const SYSTEM_ADMIN_ROLES = new Set(["admin","administrator","rendszergazda","superadmin","super_admin","platform_admin"]);
const parseRoles = (raw:any):string[] => {
  if(Array.isArray(raw)) return raw.map(String).map(x=>x.toLowerCase());
  try { const parsed=JSON.parse(String(raw||"")); if(Array.isArray(parsed)) return parsed.map(String).map(x=>x.toLowerCase()); } catch {}
  return String(raw||"").replace(/[\[\]\"]/g,"").split(",").map(x=>x.trim().toLowerCase()).filter(Boolean);
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
router.use("/tenants/:tenantId/onboarding", saasOnboardingRouter);

router.get("/tenants",async(_req:TenantAuthRequest,res:Response)=>{
  try{
    const {rows}=await db.query(`
      WITH tenant_base AS (
        SELECT t.id::text,t.slug,t.name,t.legal_name,t.tax_number,t.billing_email,t.status,t.default_locale,t.default_currency,t.timezone,t.created_at,t.updated_at,
               s.id::text subscription_id,s.status subscription_status,s.current_period_end,s.cancel_at_period_end,
               sp.code plan_code,sp.name plan_name,sp.monthly_price,sp.currency plan_currency,
               COALESCE(lc.location_count,0)::int location_count,
               COALESCE(uc.user_count,0)::int user_count,
               COALESCE(fc.franchise_location_count,0)::int franchise_location_count,
               COALESCE(ob.status,'in_progress') onboarding_status,
               ob.current_step onboarding_saved_step,
               ob.started_at onboarding_started_at,
               ob.completed_at onboarding_completed_at,
               (t.name IS NOT NULL AND btrim(t.name)<>'' AND t.legal_name IS NOT NULL AND btrim(t.legal_name)<>'' AND t.billing_email IS NOT NULL AND btrim(t.billing_email)<>'') company_complete,
               COALESCE(ac.admin_count,0)>0 admin_complete,
               COALESCE(lc.location_count,0)>0 location_complete,
               COALESCE(bc.branding_count,0)>0 branding_complete,
               (sp.features IS NOT NULL OR COALESCE(mc.module_count,0)>0) modules_complete,
               COALESCE(s.status IN ('trial','active'),false) subscription_complete,
               CASE WHEN ai.status='pending' AND ai.expires_at<=now() THEN 'expired' ELSE ai.status END admin_invitation_status,
               ai.email admin_invitation_email,
               ai.expires_at admin_invitation_expires_at,
               ai.created_at admin_invitation_created_at
          FROM tenants t
          LEFT JOIN LATERAL (
            SELECT s1.* FROM subscriptions s1
             WHERE s1.tenant_id=t.id
             ORDER BY CASE WHEN s1.status IN ('trial','active','past_due','suspended') THEN 0 ELSE 1 END,s1.created_at DESC
             LIMIT 1
          ) s ON true
          LEFT JOIN subscription_plans sp ON sp.id=s.plan_id
          LEFT JOIN tenant_onboarding ob ON ob.tenant_id=t.id
          LEFT JOIN LATERAL (SELECT count(*) location_count FROM locations l WHERE l.tenant_id=t.id) lc ON true
          LEFT JOIN LATERAL (SELECT count(*) user_count FROM tenant_users tu WHERE tu.tenant_id=t.id AND tu.active=true) uc ON true
          LEFT JOIN LATERAL (SELECT count(*) admin_count FROM tenant_users tu WHERE tu.tenant_id=t.id AND tu.active=true AND tu.tenant_role IN ('owner','admin')) ac ON true
          LEFT JOIN LATERAL (SELECT count(*) branding_count FROM tenant_branding tb WHERE tb.tenant_id=t.id AND (NULLIF(btrim(COALESCE(tb.app_name,'')),'') IS NOT NULL OR NULLIF(btrim(COALESCE(tb.logo_url,'')),'') IS NOT NULL OR NULLIF(btrim(COALESCE(tb.primary_color,'')),'') IS NOT NULL)) bc ON true
          LEFT JOIN LATERAL (SELECT count(*) module_count FROM tenant_features tf WHERE tf.tenant_id=t.id) mc ON true
          LEFT JOIN LATERAL (SELECT count(*) franchise_location_count FROM franchise_members fm WHERE fm.tenant_id=t.id AND fm.active=true AND fm.member_type='franchise') fc ON true
          LEFT JOIN LATERAL (
            SELECT status,email,expires_at,created_at FROM tenant_admin_invitations i
             WHERE i.tenant_id=t.id ORDER BY i.created_at DESC LIMIT 1
          ) ai ON true
      )
      SELECT tenant_base.*,
             round(((company_complete::int+admin_complete::int+location_complete::int+branding_complete::int+modules_complete::int+subscription_complete::int)*100.0)/6)::int onboarding_progress,
             (company_complete AND admin_complete AND location_complete AND branding_complete AND modules_complete AND subscription_complete) onboarding_ready,
             CASE
               WHEN NOT company_complete THEN 'company'
               WHEN NOT admin_complete THEN 'admin'
               WHEN NOT location_complete THEN 'location'
               WHEN NOT branding_complete THEN 'branding'
               WHEN NOT modules_complete THEN 'modules'
               WHEN NOT subscription_complete THEN 'subscription'
               ELSE 'ready'
             END onboarding_next_step
        FROM tenant_base
       ORDER BY CASE WHEN slug='kleopatra' THEN 0 ELSE 1 END,name`);
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
    await client.query(`INSERT INTO tenant_onboarding(tenant_id,status,current_step,created_by) VALUES($1::bigint,'in_progress','company',$2) ON CONFLICT(tenant_id) DO NOTHING`,[tenantId,String(req.user?.id||req.user?.email||"")||null]);
    await client.query(`INSERT INTO tenant_onboarding_events(tenant_id,step_key,event_type,actor_user_id,payload) VALUES($1::bigint,'company','onboarding_started',$2,$3::jsonb)`,[tenantId,String(req.user?.id||"")||null,JSON.stringify({source:'platform_tenant_create',plan_code:plan.rows[0].code,status})]);
    await client.query(`INSERT INTO subscription_events(tenant_id,subscription_id,event_type,source,payload)
      SELECT $1::bigint,s.id,'tenant_created','platform_admin',$2::jsonb FROM subscriptions s WHERE s.tenant_id=$1::bigint ORDER BY s.created_at DESC LIMIT 1`,[tenantId,JSON.stringify({plan_code:plan.rows[0].code,created_by:String(req.user?.id||"")})]);
    await client.query("COMMIT");
    return res.status(201).json({ok:true,tenant:tenant.rows[0],plan:plan.rows[0],onboarding:{status:'in_progress',current_step:'company',started:true}});
  }catch(error:any){await client.query("ROLLBACK").catch(()=>{});if(error?.code==="23505")return res.status(409).json({ok:false,error:"Ez a tenant slug már foglalt."});console.error("[SAAS PLATFORM] tenant create:",error);return res.status(500).json({ok:false,error:"A tenant nem hozható létre."});}finally{client.release();}
});

router.get("/tenants/:tenantId/admin-invitation",async(req:TenantAuthRequest,res:Response)=>{
  const tenantId=String(req.params.tenantId||"").trim();
  if(!/^\d+$/.test(tenantId))return res.status(400).json({ok:false,error:"Érvénytelen tenant azonosító."});
  try{
    const tenant=await db.query(`SELECT id FROM tenants WHERE id=$1::bigint LIMIT 1`,[tenantId]);
    if(!tenant.rowCount)return res.status(404).json({ok:false,error:"A tenant nem található."});
    return res.json({ok:true,invitation:await latestTenantAdminInvitation(tenantId)});
  }catch(error){console.error("[SAAS PLATFORM] admin invitation status:",error);return res.status(500).json({ok:false,error:"Az admin meghívó állapota nem tölthető be."});}
});

router.post("/tenants/:tenantId/admin-invitation",async(req:TenantAuthRequest,res:Response)=>{
  const tenantId=String(req.params.tenantId||"").trim();
  const email=String(req.body?.email||"").trim().toLowerCase();
  if(!/^\d+$/.test(tenantId))return res.status(400).json({ok:false,error:"Érvénytelen tenant azonosító."});
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return res.status(400).json({ok:false,error:"Érvénytelen admin e-mail cím."});
  try{
    const tenant=await db.query(`SELECT id::text,name FROM tenants WHERE id=$1::bigint LIMIT 1`,[tenantId]);
    if(!tenant.rowCount)return res.status(404).json({ok:false,error:"A tenant nem található."});
    const result=await issueTenantAdminInvitation({tenantId,email,tenantName:tenant.rows[0].name,invitedBy:String(req.user?.id||req.user?.email||"")||null});
    await db.query(`INSERT INTO tenant_onboarding_events(tenant_id,step_key,event_type,actor_user_id,payload) VALUES($1::bigint,'admin',$2,$3,$4::jsonb)`,[tenantId,result.existing_user?'existing_admin_assigned':'invitation_sent',String(req.user?.id||"")||null,JSON.stringify({email,invitation_id:result.invitation?.id||null,delivery:result.delivery||null})]);
    return res.status(result.existing_user?200:201).json({ok:true,...result,message:result.existing_user?'A meglévő felhasználó tenant owner jogosultságot kapott.':'Az adminisztrátori meghívó elküldve.'});
  }catch(error:any){
    if(error?.code==="ADMIN_INVITE_EMAIL_FAILED")return res.status(503).json({ok:false,code:error.code,error:error.message});
    if(error?.code==="INVALID_ADMIN_EMAIL")return res.status(400).json({ok:false,code:error.code,error:error.message});
    console.error("[SAAS PLATFORM] admin invitation:",error);return res.status(500).json({ok:false,error:"Az admin meghívó nem hozható létre."});
  }
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
