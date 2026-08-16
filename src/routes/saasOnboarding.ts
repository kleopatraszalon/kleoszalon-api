import { Response, Router } from "express";
import db from "../db";
import { TenantAuthRequest } from "../middleware/tenantContext";

const router = Router({ mergeParams: true });
let schemaReady: Promise<void> | null = null;

const FEATURE_KEYS = new Set(["booking","crm","hr","inventory","finance","marketing","franchise","mobile_app","white_label","api","payroll","ai"]);
const STEP_ORDER = ["company","admin","location","branding","modules","subscription","checklist","ready"] as const;

type StepKey = typeof STEP_ORDER[number];

async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS tenant_onboarding (
          tenant_id bigint PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
          status text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','blocked','ready')),
          current_step text NOT NULL DEFAULT 'company',
          started_at timestamptz NOT NULL DEFAULT now(),
          completed_at timestamptz,
          created_by text,
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS tenant_onboarding_events (
          id bigserial PRIMARY KEY,
          tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          step_key text NOT NULL,
          event_type text NOT NULL,
          actor_user_id text,
          payload jsonb NOT NULL DEFAULT '{}'::jsonb,
          created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS tenant_onboarding_events_tenant_idx
          ON tenant_onboarding_events(tenant_id, created_at DESC);
      `);
    })().catch(error => { schemaReady = null; throw error; });
  }
  await schemaReady;
}

function tenantIdFrom(req: TenantAuthRequest) {
  const value = String(req.params.tenantId || "").trim();
  return /^\d+$/.test(value) ? value : null;
}

async function getTenant(tenantId: string) {
  const { rows } = await db.query(`SELECT id::text,slug,name,legal_name,tax_number,billing_email,status,default_locale,default_currency,timezone FROM tenants WHERE id=$1::bigint LIMIT 1`, [tenantId]);
  return rows[0] || null;
}

async function recordEvent(tenantId: string, step: StepKey, eventType: string, req: TenantAuthRequest, payload: any = {}, client: any = db) {
  await client.query(`INSERT INTO tenant_onboarding_events(tenant_id,step_key,event_type,actor_user_id,payload) VALUES($1::bigint,$2,$3,$4,$5::jsonb)`, [tenantId, step, eventType, String(req.user?.id || "") || null, JSON.stringify(payload || {})]);
}

async function computeState(tenantId: string) {
  await ensureSchema();
  const tenant = await getTenant(tenantId);
  if (!tenant) return null;
  await db.query(`INSERT INTO tenant_onboarding(tenant_id) VALUES($1::bigint) ON CONFLICT(tenant_id) DO NOTHING`, [tenantId]);

  const [admin, location, branding, features, subscription, onboarding, events] = await Promise.all([
    db.query(`SELECT user_id,tenant_role FROM tenant_users WHERE tenant_id=$1::bigint AND active=true AND tenant_role IN ('owner','admin') ORDER BY CASE tenant_role WHEN 'owner' THEN 0 ELSE 1 END,created_at LIMIT 1`, [tenantId]),
    db.query(`SELECT id::text,name,city,address,email FROM locations WHERE tenant_id=$1::bigint ORDER BY id LIMIT 1`, [tenantId]),
    db.query(`SELECT app_name,logo_url,favicon_url,primary_color,secondary_color,custom_domain,email_sender_name FROM tenant_branding WHERE tenant_id=$1::bigint LIMIT 1`, [tenantId]),
    db.query(`SELECT feature_key,enabled,config FROM tenant_features WHERE tenant_id=$1::bigint ORDER BY feature_key`, [tenantId]),
    db.query(`SELECT s.id::text,s.status,s.trial_ends_at,s.current_period_end,s.external_subscription_id,sp.code plan_code,sp.name plan_name,sp.features plan_features FROM subscriptions s JOIN subscription_plans sp ON sp.id=s.plan_id WHERE s.tenant_id=$1::bigint ORDER BY CASE WHEN s.status IN ('trial','active','past_due','suspended') THEN 0 ELSE 1 END,s.created_at DESC LIMIT 1`, [tenantId]),
    db.query(`SELECT status,current_step,started_at,completed_at,updated_at FROM tenant_onboarding WHERE tenant_id=$1::bigint`, [tenantId]),
    db.query(`SELECT step_key,event_type,actor_user_id,payload,created_at FROM tenant_onboarding_events WHERE tenant_id=$1::bigint ORDER BY created_at DESC LIMIT 50`, [tenantId]),
  ]);

  const companyOk = Boolean(tenant.name && tenant.legal_name && tenant.billing_email);
  const adminOk = admin.rowCount > 0;
  const locationOk = location.rowCount > 0;
  const brandingRow = branding.rows[0] || null;
  const brandingOk = Boolean(brandingRow && (brandingRow.app_name || brandingRow.logo_url || brandingRow.primary_color));
  const sub = subscription.rows[0] || null;
  const modulesOk = Boolean(sub?.plan_features) || features.rowCount > 0;
  const subscriptionOk = Boolean(sub && ["trial","active"].includes(sub.status));
  const baseChecklist = [
    { key: "company", label: "Cégadatok", complete: companyOk },
    { key: "admin", label: "Első adminisztrátor", complete: adminOk },
    { key: "location", label: "Első telephely", complete: locationOk },
    { key: "branding", label: "Arculat", complete: brandingOk },
    { key: "modules", label: "Modulok", complete: modulesOk },
    { key: "subscription", label: "Előfizetés", complete: subscriptionOk },
  ];
  const checklistOk = baseChecklist.every(item => item.complete);
  const checklist = [...baseChecklist, { key: "checklist", label: "Onboarding ellenőrzőlista", complete: checklistOk }];
  const firstMissing = checklist.find(item => !item.complete)?.key || "ready";
  const progress = Math.round((baseChecklist.filter(item => item.complete).length / baseChecklist.length) * 100);

  return {
    tenant,
    onboarding: onboarding.rows[0],
    progress,
    ready: checklistOk,
    next_step: firstMissing,
    checklist,
    admin: admin.rows[0] || null,
    location: location.rows[0] || null,
    branding: brandingRow,
    features: features.rows,
    subscription: sub,
    events: events.rows,
  };
}

async function syncProgress(tenantId: string, req: TenantAuthRequest) {
  const state = await computeState(tenantId);
  if (!state) return null;
  const next = state.ready ? "ready" : state.next_step;
  await db.query(`UPDATE tenant_onboarding SET current_step=$2,updated_at=now() WHERE tenant_id=$1::bigint`, [tenantId, next]);
  return { ...state, onboarding: { ...state.onboarding, current_step: next } };
}

router.get("/", async (req: TenantAuthRequest, res: Response) => {
  const tenantId = tenantIdFrom(req);
  if (!tenantId) return res.status(400).json({ ok:false, error:"Érvénytelen tenant azonosító." });
  try {
    const state = await syncProgress(tenantId, req);
    if (!state) return res.status(404).json({ ok:false, error:"A tenant nem található." });
    return res.json({ ok:true, ...state });
  } catch (error) {
    console.error("[SAAS ONBOARDING] status:", error);
    return res.status(500).json({ ok:false, error:"Az onboarding állapota nem tölthető be." });
  }
});

router.put("/company", async (req: TenantAuthRequest, res: Response) => {
  const tenantId = tenantIdFrom(req);
  if (!tenantId) return res.status(400).json({ ok:false, error:"Érvénytelen tenant azonosító." });
  const legalName = String(req.body?.legal_name || "").trim();
  const billingEmail = String(req.body?.billing_email || "").trim().toLowerCase();
  if (legalName.length < 2) return res.status(400).json({ ok:false, error:"A hivatalos cégnév kötelező." });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(billingEmail)) return res.status(400).json({ ok:false, error:"Érvénytelen számlázási e-mail cím." });
  try {
    await ensureSchema();
    const result = await db.query(`UPDATE tenants SET legal_name=$2,tax_number=$3,billing_email=$4,default_locale=COALESCE(NULLIF($5,''),default_locale),default_currency=COALESCE(NULLIF($6,''),default_currency),timezone=COALESCE(NULLIF($7,''),timezone),updated_at=now() WHERE id=$1::bigint RETURNING id`, [tenantId,legalName,String(req.body?.tax_number||"").trim()||null,billingEmail,String(req.body?.default_locale||"").trim(),String(req.body?.default_currency||"").trim().toUpperCase(),String(req.body?.timezone||"").trim()]);
    if (!result.rowCount) return res.status(404).json({ ok:false,error:"A tenant nem található." });
    await db.query(`INSERT INTO tenant_onboarding(tenant_id,created_by) VALUES($1::bigint,$2) ON CONFLICT(tenant_id) DO NOTHING`, [tenantId,String(req.user?.id||"")||null]);
    await recordEvent(tenantId,"company","completed",req,{ legal_name:legalName });
    return res.json({ ok:true, ...(await syncProgress(tenantId, req)) });
  } catch (error) { console.error("[SAAS ONBOARDING] company:",error); return res.status(500).json({ok:false,error:"A cégadatok nem menthetők."}); }
});

router.put("/admin", async (req: TenantAuthRequest, res: Response) => {
  const tenantId = tenantIdFrom(req);
  if (!tenantId) return res.status(400).json({ok:false,error:"Érvénytelen tenant azonosító."});
  const userIdInput=String(req.body?.user_id||"").trim();
  const email=String(req.body?.email||"").trim().toLowerCase();
  if(!userIdInput&&!email)return res.status(400).json({ok:false,error:"A user_id vagy admin e-mail cím kötelező."});
  try{
    await ensureSchema();
    let userId=userIdInput;
    const userTable=await db.query(`SELECT to_regclass('public.users') IS NOT NULL ok`);
    if(userTable.rows[0]?.ok){
      const user=userId
        ? await db.query(`SELECT id::text,email FROM users WHERE id::text=$1 LIMIT 1`,[userId])
        : await db.query(`SELECT id::text,email FROM users WHERE lower(email)=lower($1) LIMIT 1`,[email]);
      if(!user.rowCount)return res.status(404).json({ok:false,code:"ONBOARDING_ADMIN_USER_NOT_FOUND",error:"Az admin felhasználó még nem létezik a VIR-ben."});
      userId=user.rows[0].id;
    }
    await db.query(`INSERT INTO tenant_users(tenant_id,user_id,tenant_role,active) VALUES($1::bigint,$2,'owner',true) ON CONFLICT(tenant_id,user_id) DO UPDATE SET tenant_role='owner',active=true`,[tenantId,userId]);
    await recordEvent(tenantId,"admin","completed",req,{user_id:userId,email:email||undefined});
    return res.json({ok:true,...(await syncProgress(tenantId,req))});
  }catch(error){console.error("[SAAS ONBOARDING] admin:",error);return res.status(500).json({ok:false,error:"Az első admin nem rendelhető a tenanthoz."});}
});

router.put("/location", async (req: TenantAuthRequest, res: Response) => {
  const tenantId=tenantIdFrom(req); if(!tenantId)return res.status(400).json({ok:false,error:"Érvénytelen tenant azonosító."});
  const name=String(req.body?.name||"").trim(); const city=String(req.body?.city||"").trim();
  if(name.length<2||city.length<2)return res.status(400).json({ok:false,error:"A telephely neve és települése kötelező."});
  const client=await db.connect();
  try{
    await ensureSchema(); await client.query("BEGIN");
    const existing=await client.query(`SELECT id::text FROM locations WHERE tenant_id=$1::bigint ORDER BY id LIMIT 1`,[tenantId]);
    let locationId=existing.rows[0]?.id;
    if(locationId){
      await client.query(`UPDATE locations SET name=$2,city=$3,address=$4,email=$5,is_active=true WHERE id::text=$1 AND tenant_id=$6::bigint`,[locationId,name,city,String(req.body?.address||"").trim()||null,String(req.body?.email||"").trim().toLowerCase()||null,tenantId]);
    }else{
      const inserted=await client.query(`INSERT INTO locations(name,city,address,email,is_active,tenant_id) VALUES($1,$2,$3,$4,true,$5::bigint) RETURNING id::text`,[name,city,String(req.body?.address||"").trim()||null,String(req.body?.email||"").trim().toLowerCase()||null,tenantId]);
      locationId=inserted.rows[0].id;
    }
    await recordEvent(tenantId,"location","completed",req,{location_id:locationId},client); await client.query("COMMIT");
    return res.json({ok:true,...(await syncProgress(tenantId,req))});
  }catch(error){await client.query("ROLLBACK").catch(()=>{});console.error("[SAAS ONBOARDING] location:",error);return res.status(500).json({ok:false,error:"Az első telephely nem menthető."});}finally{client.release();}
});

router.put("/branding", async(req:TenantAuthRequest,res:Response)=>{
  const tenantId=tenantIdFrom(req);if(!tenantId)return res.status(400).json({ok:false,error:"Érvénytelen tenant azonosító."});
  const appName=String(req.body?.app_name||"").trim();
  if(!appName&&!req.body?.logo_url&&!req.body?.primary_color)return res.status(400).json({ok:false,error:"Legalább az alkalmazás neve, logója vagy elsődleges színe szükséges."});
  try{
    await ensureSchema();
    await db.query(`INSERT INTO tenant_branding(tenant_id,app_name,logo_url,favicon_url,primary_color,secondary_color,custom_domain,email_sender_name) VALUES($1::bigint,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(tenant_id) DO UPDATE SET app_name=EXCLUDED.app_name,logo_url=EXCLUDED.logo_url,favicon_url=EXCLUDED.favicon_url,primary_color=EXCLUDED.primary_color,secondary_color=EXCLUDED.secondary_color,custom_domain=EXCLUDED.custom_domain,email_sender_name=EXCLUDED.email_sender_name,updated_at=now()`,[tenantId,appName||null,String(req.body?.logo_url||"").trim()||null,String(req.body?.favicon_url||"").trim()||null,String(req.body?.primary_color||"").trim()||null,String(req.body?.secondary_color||"").trim()||null,String(req.body?.custom_domain||"").trim().toLowerCase()||null,String(req.body?.email_sender_name||"").trim()||null]);
    await recordEvent(tenantId,"branding","completed",req,{app_name:appName});
    return res.json({ok:true,...(await syncProgress(tenantId,req))});
  }catch(error:any){if(error?.code==="23505")return res.status(409).json({ok:false,error:"Ez az egyedi domain már használatban van."});console.error("[SAAS ONBOARDING] branding:",error);return res.status(500).json({ok:false,error:"Az arculat nem menthető."});}
});

router.put("/modules", async(req:TenantAuthRequest,res:Response)=>{
  const tenantId=tenantIdFrom(req);if(!tenantId)return res.status(400).json({ok:false,error:"Érvénytelen tenant azonosító."});
  const features=req.body?.features;
  if(!features||typeof features!=="object"||Array.isArray(features))return res.status(400).json({ok:false,error:"A features objektum kötelező."});
  const entries=Object.entries(features).filter(([key])=>FEATURE_KEYS.has(key));
  if(!entries.length)return res.status(400).json({ok:false,error:"Nincs támogatott modul a kérésben."});
  const client=await db.connect();
  try{
    await ensureSchema();await client.query("BEGIN");
    for(const [key,value] of entries){const enabled=typeof value==="object"?Boolean((value as any)?.enabled):Boolean(value);const config=typeof value==="object"&&value!==null?(value as any)?.config||{}:{};await client.query(`INSERT INTO tenant_features(tenant_id,feature_key,enabled,config) VALUES($1::bigint,$2,$3,$4::jsonb) ON CONFLICT(tenant_id,feature_key) DO UPDATE SET enabled=EXCLUDED.enabled,config=EXCLUDED.config,updated_at=now()`,[tenantId,key,enabled,JSON.stringify(config)]);}
    await recordEvent(tenantId,"modules","completed",req,{features:Object.fromEntries(entries)},client);await client.query("COMMIT");
    return res.json({ok:true,...(await syncProgress(tenantId,req))});
  }catch(error){await client.query("ROLLBACK").catch(()=>{});console.error("[SAAS ONBOARDING] modules:",error);return res.status(500).json({ok:false,error:"A modulbeállítások nem menthetők."});}finally{client.release();}
});

router.put("/subscription", async(req:TenantAuthRequest,res:Response)=>{
  const tenantId=tenantIdFrom(req);if(!tenantId)return res.status(400).json({ok:false,error:"Érvénytelen tenant azonosító."});
  const planCode=String(req.body?.plan_code||"").trim().toLowerCase(); const status=req.body?.status==="active"?"active":"trial";
  if(!planCode)return res.status(400).json({ok:false,error:"A plan_code kötelező."});
  const client=await db.connect();
  try{
    await ensureSchema();await client.query("BEGIN");
    const plan=await client.query(`SELECT id,code,name,features FROM subscription_plans WHERE code=$1 AND active=true LIMIT 1`,[planCode]);if(!plan.rowCount){await client.query("ROLLBACK");return res.status(404).json({ok:false,error:"Az előfizetési csomag nem található."});}
    const current=await client.query(`SELECT id,external_subscription_id FROM subscriptions WHERE tenant_id=$1::bigint AND status IN ('trial','active','past_due','suspended') ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,[tenantId]);
    if(current.rows[0]?.external_subscription_id){await client.query("ROLLBACK");return res.status(409).json({ok:false,code:"BILLING_PROVIDER_MANAGED",error:"A külső fizetési szolgáltató által kezelt előfizetés onboardingból nem írható át."});}
    if(current.rowCount){await client.query(`UPDATE subscriptions SET plan_id=$2,status=$3,trial_ends_at=CASE WHEN $3='trial' THEN COALESCE(trial_ends_at,now()+interval '14 days') ELSE NULL END,updated_at=now() WHERE id=$1`,[current.rows[0].id,plan.rows[0].id,status]);}
    else{await client.query(`INSERT INTO subscriptions(tenant_id,plan_id,status,trial_ends_at) VALUES($1::bigint,$2,$3,CASE WHEN $3='trial' THEN now()+interval '14 days' ELSE NULL END)`,[tenantId,plan.rows[0].id,status]);}
    await recordEvent(tenantId,"subscription","completed",req,{plan_code:planCode,status},client);await client.query("COMMIT");
    return res.json({ok:true,...(await syncProgress(tenantId,req))});
  }catch(error){await client.query("ROLLBACK").catch(()=>{});console.error("[SAAS ONBOARDING] subscription:",error);return res.status(500).json({ok:false,error:"Az előfizetés nem állítható be."});}finally{client.release();}
});

router.post("/complete",async(req:TenantAuthRequest,res:Response)=>{
  const tenantId=tenantIdFrom(req);if(!tenantId)return res.status(400).json({ok:false,error:"Érvénytelen tenant azonosító."});
  try{
    await ensureSchema();const state=await computeState(tenantId);if(!state)return res.status(404).json({ok:false,error:"A tenant nem található."});
    if(!state.ready)return res.status(409).json({ok:false,code:"ONBOARDING_INCOMPLETE",error:"Az onboarding még nem teljes.",missing:state.checklist.filter((x:any)=>!x.complete).map((x:any)=>x.key),checklist:state.checklist});
    await db.query(`UPDATE tenant_onboarding SET status='ready',current_step='ready',completed_at=COALESCE(completed_at,now()),updated_at=now() WHERE tenant_id=$1::bigint`,[tenantId]);
    await recordEvent(tenantId,"ready","completed",req,{progress:100});
    return res.json({ok:true,...(await computeState(tenantId))});
  }catch(error){console.error("[SAAS ONBOARDING] complete:",error);return res.status(500).json({ok:false,error:"Az onboarding nem zárható le."});}
});

export default router;
