import { NextFunction, Response, Router } from "express";
import db from "../db";
import { TenantAuthRequest } from "../middleware/tenantContext";

const router=Router({mergeParams:true});
const TRIAL_WARNING_DAYS=3;
const TRIAL_GRACE_DAYS=3;
const SYSTEM_ADMIN_ROLES=new Set(["admin","administrator","rendszergazda","superadmin","super_admin","platform_admin"]);

type PolicyConfig={enabled:boolean;trial_warning_days:number;trial_grace_days:number;notify_on_warning:boolean;notify_on_grace:boolean;notify_on_suspend:boolean;auto_apply_suspend:boolean};

function parseRoles(raw:any):string[]{
  if(Array.isArray(raw))return raw.map(String).map(x=>x.toLowerCase());
  try{const parsed=JSON.parse(String(raw||""));if(Array.isArray(parsed))return parsed.map(String).map(x=>x.toLowerCase());}catch{}
  return String(raw||"").replace(/[\[\]\"]/g,"").split(",").map(x=>x.trim().toLowerCase()).filter(Boolean);
}
function requirePlatformAdmin(req:TenantAuthRequest,res:Response,next:NextFunction){
  const roles=parseRoles(req.user?.role);const isSystemAdmin=roles.some(role=>SYSTEM_ADMIN_ROLES.has(role));const isRootTenant=String(req.tenant?.slug||"").toLowerCase()==="kleopatra";
  if(!isSystemAdmin||!isRootTenant)return res.status(403).json({ok:false,code:"PLATFORM_ADMIN_FORBIDDEN",error:"A lifecycle policy csak a központi platform admin számára érhető el."});
  return next();
}
function actorId(req:TenantAuthRequest){return String(req.user?.id||req.user?.email||'')||null;}
router.use(requirePlatformAdmin);

async function getConfig(client:any=db):Promise<PolicyConfig>{
  const {rows}=await client.query(`SELECT enabled,trial_warning_days,trial_grace_days,notify_on_warning,notify_on_grace,notify_on_suspend,auto_apply_suspend FROM saas_lifecycle_policy_config WHERE id=1`);
  return rows[0]||{enabled:false,trial_warning_days:TRIAL_WARNING_DAYS,trial_grace_days:TRIAL_GRACE_DAYS,notify_on_warning:true,notify_on_grace:true,notify_on_suspend:true,auto_apply_suspend:false};
}

async function policyRows(config?:PolicyConfig){
  const cfg=config||await getConfig();
  const {rows}=await db.query(`WITH current_sub AS (
      SELECT DISTINCT ON (s.tenant_id) s.id::text subscription_id,s.tenant_id::text tenant_id,s.status subscription_status,s.trial_ends_at,s.grace_period_end,s.last_payment_status,t.slug,t.name,t.billing_email,t.status tenant_status
        FROM subscriptions s JOIN tenants t ON t.id=s.tenant_id
       WHERE t.slug<>'kleopatra' AND s.status IN ('trial','active','past_due','suspended')
       ORDER BY s.tenant_id,s.created_at DESC)
    SELECT *,CASE
      WHEN tenant_status='suspended' OR subscription_status='suspended' THEN 'none'
      WHEN subscription_status='past_due' AND grace_period_end IS NOT NULL AND grace_period_end<=now() THEN 'suspend'
      WHEN subscription_status='trial' AND trial_ends_at IS NOT NULL AND trial_ends_at<=now()-($1::int*interval '1 day') THEN 'suspend'
      WHEN subscription_status='trial' AND trial_ends_at IS NOT NULL AND trial_ends_at<=now() THEN 'grace'
      WHEN subscription_status='trial' AND trial_ends_at IS NOT NULL AND trial_ends_at<=now()+($2::int*interval '1 day') THEN 'warn'
      ELSE 'none' END policy_action,
      CASE
      WHEN subscription_status='past_due' AND grace_period_end IS NOT NULL AND grace_period_end<=now() THEN 'A fizetési türelmi idő lejárt.'
      WHEN subscription_status='trial' AND trial_ends_at IS NOT NULL AND trial_ends_at<=now()-($1::int*interval '1 day') THEN 'A próbaidő és a türelmi idő is lejárt.'
      WHEN subscription_status='trial' AND trial_ends_at IS NOT NULL AND trial_ends_at<=now() THEN 'A próbaidő lejárt; türelmi idő aktív.'
      WHEN subscription_status='trial' AND trial_ends_at IS NOT NULL AND trial_ends_at<=now()+($2::int*interval '1 day') THEN 'A próbaidő hamarosan lejár.'
      ELSE 'Nincs lifecycle teendő.' END policy_reason
    FROM current_sub ORDER BY CASE WHEN subscription_status='past_due' AND grace_period_end IS NOT NULL AND grace_period_end<=now() THEN 0 WHEN subscription_status='trial' AND trial_ends_at IS NOT NULL AND trial_ends_at<=now()-($1::int*interval '1 day') THEN 0 WHEN subscription_status='trial' AND trial_ends_at IS NOT NULL AND trial_ends_at<=now() THEN 1 WHEN subscription_status='trial' AND trial_ends_at IS NOT NULL AND trial_ends_at<=now()+($2::int*interval '1 day') THEN 2 ELSE 3 END,name`,[cfg.trial_grace_days,cfg.trial_warning_days]);
  return rows;
}

router.get("/lifecycle-policy",async(_req:TenantAuthRequest,res:Response)=>{try{const config=await getConfig();const rows=await policyRows(config);return res.json({ok:true,policy:config,summary:{suspend:rows.filter(r=>r.policy_action==='suspend').length,grace:rows.filter(r=>r.policy_action==='grace').length,warn:rows.filter(r=>r.policy_action==='warn').length},rows});}catch(error){console.error('[SAAS LIFECYCLE POLICY] preview:',error);return res.status(500).json({ok:false,error:'A lifecycle policy előnézet nem tölthető be.'});}});

router.patch("/lifecycle-policy/config",async(req:TenantAuthRequest,res:Response)=>{
  const warning=Number(req.body?.trial_warning_days),grace=Number(req.body?.trial_grace_days);
  if(!Number.isInteger(warning)||warning<1||warning>30||!Number.isInteger(grace)||grace<0||grace>30)return res.status(400).json({ok:false,error:'A warning 1–30 nap, a grace 0–30 nap lehet.'});
  try{const {rows}=await db.query(`UPDATE saas_lifecycle_policy_config SET enabled=$1,trial_warning_days=$2,trial_grace_days=$3,notify_on_warning=$4,notify_on_grace=$5,notify_on_suspend=$6,auto_apply_suspend=$7,updated_by=$8,updated_at=now() WHERE id=1 RETURNING *`,[req.body?.enabled===true,warning,grace,req.body?.notify_on_warning!==false,req.body?.notify_on_grace!==false,req.body?.notify_on_suspend!==false,req.body?.auto_apply_suspend===true,actorId(req)]);return res.json({ok:true,policy:rows[0]});}catch(error){console.error('[SAAS LIFECYCLE POLICY] config:',error);return res.status(500).json({ok:false,error:'A lifecycle policy beállítása nem menthető.'});}
});

router.get("/lifecycle-policy/notifications",async(_req:TenantAuthRequest,res:Response)=>{try{const {rows}=await db.query(`SELECT q.id::text,q.tenant_id::text,q.subscription_id::text,q.notification_type,q.channel,q.recipient_email,q.subject,q.status,q.attempts,q.next_attempt_at,q.sent_at,q.last_error,q.created_at,t.name tenant_name FROM saas_lifecycle_notification_queue q JOIN tenants t ON t.id=q.tenant_id ORDER BY CASE q.status WHEN 'pending' THEN 0 WHEN 'failed' THEN 1 ELSE 2 END,q.created_at DESC LIMIT 200`);return res.json({ok:true,rows});}catch(error){console.error('[SAAS LIFECYCLE POLICY] notifications:',error);return res.status(500).json({ok:false,error:'A lifecycle értesítési sor nem tölthető be.'});}});

router.post("/lifecycle-policy/prepare-notifications",async(req:TenantAuthRequest,res:Response)=>{
  try{const config=await getConfig();const rows=await policyRows(config);let prepared=0;
    for(const row of rows){let type:string|null=null;if(row.policy_action==='warn'&&config.notify_on_warning)type='trial_warning';if(row.policy_action==='grace'&&config.notify_on_grace)type='trial_grace';if(row.policy_action==='suspend'&&config.notify_on_suspend)type='subscription_suspend';if(!type)continue;
      const period=String(row.trial_ends_at||row.grace_period_end||'none').slice(0,10);const dedupe=`${type}:${row.tenant_id}:${row.subscription_id}:${period}`;const subject=type==='trial_warning'?'A KleoSaaS próbaidő hamarosan lejár':type==='trial_grace'?'A KleoSaaS próbaidő lejárt':'KleoSaaS előfizetési beavatkozás szükséges';
      const result=await db.query(`INSERT INTO saas_lifecycle_notification_queue(tenant_id,subscription_id,notification_type,recipient_email,subject,payload,dedupe_key) VALUES($1::bigint,$2::bigint,$3,$4,$5,$6::jsonb,$7) ON CONFLICT(dedupe_key) DO NOTHING RETURNING id`,[row.tenant_id,row.subscription_id,type,row.billing_email||null,subject,JSON.stringify({tenant_name:row.name,reason:row.policy_reason,action:row.policy_action,prepared_by:actorId(req)}),dedupe]);prepared+=result.rowCount||0;
    }
    return res.json({ok:true,prepared_count:prepared});
  }catch(error){console.error('[SAAS LIFECYCLE POLICY] prepare notifications:',error);return res.status(500).json({ok:false,error:'A lifecycle értesítések nem készíthetők elő.'});}
});

router.post("/lifecycle-policy/apply",async(req:TenantAuthRequest,res:Response)=>{
  const actor=actorId(req);const client=await db.connect();
  try{const config=await getConfig();const preview=await policyRows(config);const candidates=preview.filter(r=>r.policy_action==='suspend');await client.query('BEGIN');const applied:any[]=[];
    for(const row of candidates){const locked=await client.query(`SELECT t.id::text tenant_id,t.status tenant_status,s.id::text subscription_id,s.status subscription_status,s.trial_ends_at,s.grace_period_end FROM tenants t JOIN subscriptions s ON s.tenant_id=t.id WHERE t.id=$1::bigint AND s.id=$2::bigint FOR UPDATE`,[row.tenant_id,row.subscription_id]);if(!locked.rowCount)continue;const current=locked.rows[0];if(current.tenant_status==='suspended'||current.subscription_status==='suspended')continue;const eligible=(current.subscription_status==='past_due'&&current.grace_period_end&&new Date(current.grace_period_end).getTime()<=Date.now())||(current.subscription_status==='trial'&&current.trial_ends_at&&new Date(current.trial_ends_at).getTime()<=Date.now()-config.trial_grace_days*86400000);if(!eligible)continue;
      await client.query(`UPDATE tenants SET status='suspended',updated_at=now() WHERE id=$1::bigint`,[row.tenant_id]);await client.query(`UPDATE subscriptions SET status='suspended',updated_at=now() WHERE id=$1::bigint`,[row.subscription_id]);await client.query(`INSERT INTO subscription_events(tenant_id,subscription_id,event_type,source,payload) VALUES($1::bigint,$2::bigint,'lifecycle_auto_suspended','platform_policy',$3::jsonb)`,[row.tenant_id,row.subscription_id,JSON.stringify({reason:row.policy_reason,actor,trial_grace_days:config.trial_grace_days})]);applied.push({tenant_id:row.tenant_id,subscription_id:row.subscription_id,name:row.name,action:'suspended',reason:row.policy_reason});}
    await client.query('COMMIT');return res.json({ok:true,applied_count:applied.length,applied});
  }catch(error){await client.query('ROLLBACK').catch(()=>{});console.error('[SAAS LIFECYCLE POLICY] apply:',error);return res.status(500).json({ok:false,error:'A lifecycle policy nem alkalmazható.'});}finally{client.release();}
});

export default router;
