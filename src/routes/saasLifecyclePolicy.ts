import { NextFunction, Response, Router } from "express";
import db from "../db";
import { TenantAuthRequest } from "../middleware/tenantContext";

const router=Router({mergeParams:true});
const TRIAL_WARNING_DAYS=3;
const TRIAL_GRACE_DAYS=3;
const SYSTEM_ADMIN_ROLES=new Set(["admin","administrator","rendszergazda","superadmin","super_admin","platform_admin"]);

function parseRoles(raw:any):string[]{
  if(Array.isArray(raw))return raw.map(String).map(x=>x.toLowerCase());
  try{const parsed=JSON.parse(String(raw||""));if(Array.isArray(parsed))return parsed.map(String).map(x=>x.toLowerCase());}catch{}
  return String(raw||"").replace(/[\[\]\"]/g,"").split(",").map(x=>x.trim().toLowerCase()).filter(Boolean);
}

function requirePlatformAdmin(req:TenantAuthRequest,res:Response,next:NextFunction){
  const roles=parseRoles(req.user?.role);
  const isSystemAdmin=roles.some(role=>SYSTEM_ADMIN_ROLES.has(role));
  const isRootTenant=String(req.tenant?.slug||"").toLowerCase()==="kleopatra";
  if(!isSystemAdmin||!isRootTenant)return res.status(403).json({ok:false,code:"PLATFORM_ADMIN_FORBIDDEN",error:"A lifecycle policy csak a központi platform admin számára érhető el."});
  return next();
}

router.use(requirePlatformAdmin);

async function policyRows(){
  const {rows}=await db.query(`
    WITH current_sub AS (
      SELECT DISTINCT ON (s.tenant_id)
             s.id::text subscription_id,s.tenant_id::text tenant_id,s.status subscription_status,
             s.trial_ends_at,s.grace_period_end,s.last_payment_status,
             t.slug,t.name,t.status tenant_status
        FROM subscriptions s
        JOIN tenants t ON t.id=s.tenant_id
       WHERE t.slug<>'kleopatra' AND s.status IN ('trial','active','past_due','suspended')
       ORDER BY s.tenant_id,s.created_at DESC
    )
    SELECT *,
      CASE
        WHEN tenant_status='suspended' OR subscription_status='suspended' THEN 'none'
        WHEN subscription_status='past_due' AND grace_period_end IS NOT NULL AND grace_period_end<=now() THEN 'suspend'
        WHEN subscription_status='trial' AND trial_ends_at IS NOT NULL AND trial_ends_at<=now()-($1::int*interval '1 day') THEN 'suspend'
        WHEN subscription_status='trial' AND trial_ends_at IS NOT NULL AND trial_ends_at<=now() THEN 'grace'
        WHEN subscription_status='trial' AND trial_ends_at IS NOT NULL AND trial_ends_at<=now()+($2::int*interval '1 day') THEN 'warn'
        ELSE 'none'
      END policy_action,
      CASE
        WHEN subscription_status='past_due' AND grace_period_end IS NOT NULL AND grace_period_end<=now() THEN 'A fizetési türelmi idő lejárt.'
        WHEN subscription_status='trial' AND trial_ends_at IS NOT NULL AND trial_ends_at<=now()-($1::int*interval '1 day') THEN 'A próbaidő és a türelmi idő is lejárt.'
        WHEN subscription_status='trial' AND trial_ends_at IS NOT NULL AND trial_ends_at<=now() THEN 'A próbaidő lejárt; türelmi idő aktív.'
        WHEN subscription_status='trial' AND trial_ends_at IS NOT NULL AND trial_ends_at<=now()+($2::int*interval '1 day') THEN 'A próbaidő 3 napon belül lejár.'
        ELSE 'Nincs automatikus lifecycle teendő.'
      END policy_reason
      FROM current_sub
     ORDER BY CASE
       WHEN subscription_status='past_due' AND grace_period_end IS NOT NULL AND grace_period_end<=now() THEN 0
       WHEN subscription_status='trial' AND trial_ends_at IS NOT NULL AND trial_ends_at<=now()-($1::int*interval '1 day') THEN 0
       WHEN subscription_status='trial' AND trial_ends_at IS NOT NULL AND trial_ends_at<=now() THEN 1
       WHEN subscription_status='trial' AND trial_ends_at IS NOT NULL AND trial_ends_at<=now()+($2::int*interval '1 day') THEN 2
       ELSE 3 END,name`,[TRIAL_GRACE_DAYS,TRIAL_WARNING_DAYS]);
  return rows;
}

router.get("/lifecycle-policy",async(_req:TenantAuthRequest,res:Response)=>{
  try{
    const rows=await policyRows();
    return res.json({ok:true,policy:{trial_warning_days:TRIAL_WARNING_DAYS,trial_grace_days:TRIAL_GRACE_DAYS},summary:{suspend:rows.filter(r=>r.policy_action==='suspend').length,grace:rows.filter(r=>r.policy_action==='grace').length,warn:rows.filter(r=>r.policy_action==='warn').length},rows});
  }catch(error){console.error('[SAAS LIFECYCLE POLICY] preview:',error);return res.status(500).json({ok:false,error:'A lifecycle policy előnézet nem tölthető be.'});}
});

router.post("/lifecycle-policy/apply",async(req:TenantAuthRequest,res:Response)=>{
  const actor=String(req.user?.id||req.user?.email||'')||null;
  const client=await db.connect();
  try{
    const preview=await policyRows();
    const candidates=preview.filter(r=>r.policy_action==='suspend');
    await client.query('BEGIN');
    const applied:any[]=[];
    for(const row of candidates){
      const locked=await client.query(`SELECT t.id::text tenant_id,t.status tenant_status,s.id::text subscription_id,s.status subscription_status,s.trial_ends_at,s.grace_period_end
        FROM tenants t JOIN subscriptions s ON s.tenant_id=t.id
       WHERE t.id=$1::bigint AND s.id=$2::bigint FOR UPDATE`,[row.tenant_id,row.subscription_id]);
      if(!locked.rowCount)continue;
      const current=locked.rows[0];
      if(current.tenant_status==='suspended'||current.subscription_status==='suspended')continue;
      const eligible=(current.subscription_status==='past_due'&&current.grace_period_end&&new Date(current.grace_period_end).getTime()<=Date.now())||(current.subscription_status==='trial'&&current.trial_ends_at&&new Date(current.trial_ends_at).getTime()<=Date.now()-TRIAL_GRACE_DAYS*86400000);
      if(!eligible)continue;
      await client.query(`UPDATE tenants SET status='suspended',updated_at=now() WHERE id=$1::bigint`,[row.tenant_id]);
      await client.query(`UPDATE subscriptions SET status='suspended',updated_at=now() WHERE id=$1::bigint`,[row.subscription_id]);
      await client.query(`INSERT INTO subscription_events(tenant_id,subscription_id,event_type,source,payload) VALUES($1::bigint,$2::bigint,'lifecycle_auto_suspended','platform_policy',$3::jsonb)`,[row.tenant_id,row.subscription_id,JSON.stringify({reason:row.policy_reason,actor,trial_grace_days:TRIAL_GRACE_DAYS})]);
      applied.push({tenant_id:row.tenant_id,subscription_id:row.subscription_id,name:row.name,action:'suspended',reason:row.policy_reason});
    }
    await client.query('COMMIT');
    return res.json({ok:true,applied_count:applied.length,applied});
  }catch(error){await client.query('ROLLBACK').catch(()=>{});console.error('[SAAS LIFECYCLE POLICY] apply:',error);return res.status(500).json({ok:false,error:'A lifecycle policy nem alkalmazható.'});}finally{client.release();}
});

export default router;
