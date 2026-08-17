import cron from "node-cron";
import db from "../db";
import { sendEmail } from "../mailer";

const MAX_ATTEMPTS=5;
const BACKOFF_MINUTES=[5,15,60,240,720];
const DEFAULT_SCHEDULER_CRON="7 * * * *";
const DEFAULT_SCHEDULER_TIMEZONE="Europe/Budapest";
const SCHEDULER_LOCK_KEY="kleoszalon_saas_lifecycle_scheduler_v1";

type QueueRow={id:string;tenant_id:string;subscription_id:string|null;notification_type:string;recipient_email:string|null;subject:string;payload:any;attempts:number;};
type PolicyConfig={enabled:boolean;trial_warning_days:number;trial_grace_days:number;notify_on_warning:boolean;notify_on_grace:boolean;notify_on_suspend:boolean;auto_apply_suspend:boolean};

function bodyFor(row:QueueRow){
  const payload=row.payload&&typeof row.payload==="object"?row.payload:{};
  const tenantName=String(payload.tenant_name||"KleoSaaS ügyfél");
  const reason=String(payload.reason||"Előfizetési életciklus esemény történt.");
  if(row.notification_type==="trial_warning")return `${tenantName}\n\n${reason}\n\nKérjük, ellenőrizze az előfizetését a KleoSaaS felületén.`;
  if(row.notification_type==="trial_grace")return `${tenantName}\n\n${reason}\n\nA szolgáltatás türelmi időszakban van. Kérjük, rendezze vagy aktiválja az előfizetést.`;
  return `${tenantName}\n\n${reason}\n\nA szolgáltatás felfüggesztést igényelhet. Kérjük, ellenőrizze az előfizetés állapotát.`;
}

async function processOne(){
  const client=await db.connect();
  try{
    await client.query("BEGIN");
    const locked=await client.query(`SELECT id::text,tenant_id::text,subscription_id::text,notification_type,recipient_email,subject,payload,attempts
      FROM saas_lifecycle_notification_queue
      WHERE status='pending' AND next_attempt_at<=now()
      ORDER BY created_at,id
      FOR UPDATE SKIP LOCKED LIMIT 1`);
    const row=locked.rows[0] as QueueRow|undefined;
    if(!row){await client.query("COMMIT");return null;}
    const nextAttempt=Number(row.attempts||0)+1;
    if(!row.recipient_email){
      await client.query(`UPDATE saas_lifecycle_notification_queue SET status='failed',attempts=$2,last_error='MISSING_RECIPIENT',updated_at=now() WHERE id=$1::bigint`,[row.id,nextAttempt]);
      await client.query("COMMIT");
      return{queue_id:row.id,status:"failed",error:"MISSING_RECIPIENT"};
    }
    try{
      const text=bodyFor(row);
      const result=await sendEmail({to:row.recipient_email,subject:row.subject,text,html:`<p>${text.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\n/g,"<br/>")}</p>`});
      if(!result?.sent){
        const terminal=nextAttempt>=MAX_ATTEMPTS;
        const backoff=BACKOFF_MINUTES[Math.min(nextAttempt-1,BACKOFF_MINUTES.length-1)];
        await client.query(`UPDATE saas_lifecycle_notification_queue SET status=$2,attempts=$3,next_attempt_at=now()+($4::int*interval '1 minute'),last_error='SMTP_NOT_SENT',updated_at=now() WHERE id=$1::bigint`,[row.id,terminal?'failed':'pending',nextAttempt,backoff]);
        await client.query("COMMIT");
        return{queue_id:row.id,status:terminal?'failed':'retry',error:'SMTP_NOT_SENT'};
      }
      await client.query(`UPDATE saas_lifecycle_notification_queue SET status='sent',attempts=$2,sent_at=now(),last_error=NULL,updated_at=now() WHERE id=$1::bigint`,[row.id,nextAttempt]);
      await client.query("COMMIT");
      return{queue_id:row.id,status:"sent",message_id:(result as any)?.messageId||null};
    }catch(error:any){
      const terminal=nextAttempt>=MAX_ATTEMPTS;
      const backoff=BACKOFF_MINUTES[Math.min(nextAttempt-1,BACKOFF_MINUTES.length-1)];
      await client.query(`UPDATE saas_lifecycle_notification_queue SET status=$2,attempts=$3,next_attempt_at=now()+($4::int*interval '1 minute'),last_error=$5,updated_at=now() WHERE id=$1::bigint`,[row.id,terminal?'failed':'pending',nextAttempt,backoff,String(error?.message||error||'MAIL_SEND_FAILED').slice(0,1000)]);
      await client.query("COMMIT");
      return{queue_id:row.id,status:terminal?'failed':'retry',error:String(error?.message||'MAIL_SEND_FAILED')};
    }
  }catch(error){await client.query("ROLLBACK").catch(()=>{});throw error;}finally{client.release();}
}

export async function processLifecycleNotificationQueue(limit=10){
  const bounded=Math.max(1,Math.min(25,Number(limit)||10));
  const results:any[]=[];
  for(let i=0;i<bounded;i++){const result=await processOne();if(!result)break;results.push(result);}
  return{processed_count:results.length,sent_count:results.filter(x=>x.status==='sent').length,retry_count:results.filter(x=>x.status==='retry').length,failed_count:results.filter(x=>x.status==='failed').length,results};
}

async function schedulerPolicyRows(client:any,config:PolicyConfig){
  const {rows}=await client.query(`WITH current_sub AS (
      SELECT DISTINCT ON (s.tenant_id) s.id::text subscription_id,s.tenant_id::text tenant_id,s.status subscription_status,s.trial_ends_at,s.grace_period_end,t.slug,t.name,t.billing_email,t.status tenant_status
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
    FROM current_sub`,[config.trial_grace_days,config.trial_warning_days]);
  return rows;
}

async function prepareScheduledNotifications(client:any,rows:any[],config:PolicyConfig){
  let prepared=0;
  for(const row of rows){
    let type:string|null=null;
    if(row.policy_action==='warn'&&config.notify_on_warning)type='trial_warning';
    if(row.policy_action==='grace'&&config.notify_on_grace)type='trial_grace';
    if(row.policy_action==='suspend'&&config.notify_on_suspend)type='subscription_suspend';
    if(!type)continue;
    const period=String(row.trial_ends_at||row.grace_period_end||'none').slice(0,10);
    const dedupe=`${type}:${row.tenant_id}:${row.subscription_id}:${period}`;
    const subject=type==='trial_warning'?'A KleoSaaS próbaidő hamarosan lejár':type==='trial_grace'?'A KleoSaaS próbaidő lejárt':'KleoSaaS előfizetési beavatkozás szükséges';
    const result=await client.query(`INSERT INTO saas_lifecycle_notification_queue(tenant_id,subscription_id,notification_type,recipient_email,subject,payload,dedupe_key) VALUES($1::bigint,$2::bigint,$3,$4,$5,$6::jsonb,$7) ON CONFLICT(dedupe_key) DO NOTHING RETURNING id`,[row.tenant_id,row.subscription_id,type,row.billing_email||null,subject,JSON.stringify({tenant_name:row.name,reason:row.policy_reason,action:row.policy_action,prepared_by:'lifecycle_scheduler'}),dedupe]);
    prepared+=result.rowCount||0;
  }
  return prepared;
}

async function applyScheduledSuspensions(client:any,rows:any[],config:PolicyConfig){
  if(!config.auto_apply_suspend)return 0;
  const candidates=rows.filter(row=>row.policy_action==='suspend');
  let applied=0;
  await client.query('BEGIN');
  try{
    for(const row of candidates){
      const locked=await client.query(`SELECT t.id::text tenant_id,t.status tenant_status,s.id::text subscription_id,s.status subscription_status,s.trial_ends_at,s.grace_period_end FROM tenants t JOIN subscriptions s ON s.tenant_id=t.id WHERE t.id=$1::bigint AND s.id=$2::bigint FOR UPDATE`,[row.tenant_id,row.subscription_id]);
      if(!locked.rowCount)continue;
      const current=locked.rows[0];
      if(current.tenant_status==='suspended'||current.subscription_status==='suspended')continue;
      const eligible=(current.subscription_status==='past_due'&&current.grace_period_end&&new Date(current.grace_period_end).getTime()<=Date.now())||(current.subscription_status==='trial'&&current.trial_ends_at&&new Date(current.trial_ends_at).getTime()<=Date.now()-config.trial_grace_days*86400000);
      if(!eligible)continue;
      await client.query(`UPDATE tenants SET status='suspended',updated_at=now() WHERE id=$1::bigint`,[row.tenant_id]);
      await client.query(`UPDATE subscriptions SET status='suspended',updated_at=now() WHERE id=$1::bigint`,[row.subscription_id]);
      await client.query(`INSERT INTO subscription_events(tenant_id,subscription_id,event_type,source,payload) VALUES($1::bigint,$2::bigint,'lifecycle_auto_suspended','platform_policy',$3::jsonb)`,[row.tenant_id,row.subscription_id,JSON.stringify({reason:row.policy_reason,actor:'lifecycle_scheduler',trial_grace_days:config.trial_grace_days})]);
      applied++;
    }
    await client.query('COMMIT');
    return applied;
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
}

export async function runSaasLifecycleSchedulerCycle(){
  const client=await db.connect();
  let hasLock=false;
  const startedAt=new Date().toISOString();
  try{
    const lock=await client.query(`SELECT pg_try_advisory_lock(hashtext($1)) AS locked`,[SCHEDULER_LOCK_KEY]);
    hasLock=Boolean(lock.rows[0]?.locked);
    if(!hasLock)return{ok:true,skipped:true,reason:'scheduler_locked',started_at:startedAt};
    const configResult=await client.query(`SELECT enabled,trial_warning_days,trial_grace_days,notify_on_warning,notify_on_grace,notify_on_suspend,auto_apply_suspend FROM saas_lifecycle_policy_config WHERE id=1`);
    const config=configResult.rows[0] as PolicyConfig|undefined;
    if(!config?.enabled)return{ok:true,skipped:true,reason:'policy_disabled',started_at:startedAt};
    const rows=await schedulerPolicyRows(client,config);
    const preparedCount=await prepareScheduledNotifications(client,rows,config);
    const suspendedCount=await applyScheduledSuspensions(client,rows,config);
    const delivery=await processLifecycleNotificationQueue(25);
    return{ok:true,skipped:false,started_at:startedAt,finished_at:new Date().toISOString(),candidate_count:rows.length,prepared_count:preparedCount,suspended_count:suspendedCount,...delivery};
  }finally{
    if(hasLock)await client.query(`SELECT pg_advisory_unlock(hashtext($1))`,[SCHEDULER_LOCK_KEY]).catch(()=>{});
    client.release();
  }
}

let schedulerStarted=false;
export function startSaasLifecycleScheduler(){
  if(schedulerStarted)return;
  schedulerStarted=true;
  if(process.env.SAAS_LIFECYCLE_SCHEDULER_DISABLED==='1'){
    console.log('[SAAS LIFECYCLE SCHEDULER] disabled by environment');
    return;
  }
  const expression=String(process.env.SAAS_LIFECYCLE_CRON||DEFAULT_SCHEDULER_CRON).trim();
  const timezone=String(process.env.SAAS_LIFECYCLE_TIMEZONE||DEFAULT_SCHEDULER_TIMEZONE).trim();
  if(!cron.validate(expression))throw new Error(`Invalid SAAS_LIFECYCLE_CRON: ${expression}`);
  cron.schedule(expression,()=>{runSaasLifecycleSchedulerCycle().then(result=>console.log('[SAAS LIFECYCLE SCHEDULER]',JSON.stringify(result))).catch(error=>console.error('[SAAS LIFECYCLE SCHEDULER] cycle failed:',error));},{timezone});
  console.log(`[SAAS LIFECYCLE SCHEDULER] scheduled ${expression} (${timezone})`);
}

startSaasLifecycleScheduler();
