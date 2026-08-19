import cron from "node-cron";
import db from "../db";
import { sendEmail } from "../mailer";
import { ensureExceptionCapaManagementQueueSchema } from "./exceptionCapaManagementQueue";

let schemaPromise:Promise<void>|null=null;
let cyclePromise:Promise<any>|null=null;
let started=false;
const safe=(value:unknown)=>String(value??"").trim();
const emailLike=(value:unknown)=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(safe(value));
const minutesSince=(value:unknown)=>Math.max(0,(Date.now()-new Date(String(value)).getTime())/60000);

export async function ensureExceptionCapaManagementWatchdogSchema(){
  if(!schemaPromise){
    schemaPromise=(async()=>{
      await ensureExceptionCapaManagementQueueSchema();
      await db.query(`
        CREATE TABLE IF NOT EXISTS exception_capa_management_escalations(
          id bigserial PRIMARY KEY,
          capa_id uuid NOT NULL REFERENCES exception_capa_candidates(id) ON DELETE CASCADE,
          cycle_key text NOT NULL,
          escalation_level integer NOT NULL CHECK(escalation_level BETWEEN 1 AND 3),
          trigger_code text NOT NULL,
          recipient text NOT NULL,
          status text NOT NULL CHECK(status IN('sent','failed','logged')),
          detail text,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          UNIQUE(capa_id,cycle_key,escalation_level,recipient)
        );
        CREATE INDEX IF NOT EXISTS exception_capa_management_escalation_time_idx
          ON exception_capa_management_escalations(created_at DESC,escalation_level);
      `);
    })().catch(error=>{schemaPromise=null;throw error});
  }
  return schemaPromise;
}

async function tenantManagementRecipients(tenantId:string){
  try{
    const {rows}=await db.query(`
      SELECT DISTINCT lower(trim(u.email)) email
      FROM tenant_users tu
      JOIN users u ON u.id=tu.user_id
      WHERE tu.tenant_id=$1::bigint
        AND tu.active=true
        AND NULLIF(trim(COALESCE(u.email,'')),'') IS NOT NULL
        AND (
          lower(COALESCE(tu.tenant_role,'')) IN('owner','admin','manager')
          OR COALESCE(u.role::text,'') ~* '(super[_-]?admin|administrator|rendszergazda|admin|manager)'
        )
      ORDER BY 1
      LIMIT 50
    `,[tenantId]);
    return rows.map((row:any)=>safe(row.email).toLowerCase()).filter(Boolean);
  }catch(error){
    console.warn('[exception-capa] tenant management recipient lookup failed',tenantId,error);
    return [];
  }
}

function escalationTarget(row:any){
  const anchor=row.assigned_at||row.recommended_at||row.last_evaluated_at;
  const age=anchor?minutesSince(anchor):0;
  const l1=Number(row.level1_after_minutes||60),l2=Number(row.level2_after_minutes||240),l3=Number(row.level3_after_minutes||720);
  let level=age>=l3?3:age>=l2?2:age>=l1?1:0;
  let trigger=row.assigned_at?'assignment_ack_overdue':'unassigned_recommendation';
  const overdue=Boolean(row.suggested_due_at&&new Date(row.suggested_due_at).getTime()<Date.now());
  if(overdue){level=Math.max(level,String(row.severity)==='critical'?3:2);trigger='suggested_due_overdue'}
  return{level,trigger,age_minutes:Math.round(age),overdue};
}

async function reserveDelivery(row:any,cycleKey:string,level:number,trigger:string,recipient:string){
  const {rows}=await db.query(`
    INSERT INTO exception_capa_management_escalations(capa_id,cycle_key,escalation_level,trigger_code,recipient,status,detail)
    VALUES($1::uuid,$2,$3,$4,$5,'logged','reserved')
    ON CONFLICT(capa_id,cycle_key,escalation_level,recipient) DO NOTHING
    RETURNING id
  `,[row.capa_id,cycleKey,level,trigger,recipient]);
  return rows[0]?.id?String(rows[0].id):null;
}

async function finishDelivery(id:string,status:'sent'|'failed'|'logged',detail:string|null){
  await db.query(`UPDATE exception_capa_management_escalations SET status=$2,detail=$3,updated_at=now() WHERE id=$1::bigint`,[id,status,detail]);
}

async function deliver(row:any,level:number,trigger:string,ageMinutes:number){
  const owner=safe(row.assigned_owner_key).toLowerCase();
  const managers=await tenantManagementRecipients(String(row.tenant_id));
  const recipients=[...new Set([
    ...(level===1&&emailLike(owner)?[owner]:[]),
    ...(level>=2||!row.assigned_at?managers:[]),
    ...(level>=2&&emailLike(owner)?[owner]:[]),
  ])];
  const effective=recipients.length?recipients:[`unconfigured-tenant-management:${row.tenant_id}`];
  const cycleKey=String(row.assigned_at||row.recommended_at||row.last_evaluated_at||row.capa_id);
  let sent=0,failed=0,logged=0,skipped=0;
  for(const recipient of effective){
    const reservation=await reserveDelivery(row,cycleKey,level,trigger,recipient);
    if(!reservation){skipped++;continue}
    let status:'sent'|'failed'|'logged'='logged',detail:string|null=null;
    if(!recipient.startsWith('unconfigured-tenant-management:')){
      const subject=`[L${level} VIR CAPA] ${row.title}`;
      const text=[
        `CAPA vezetői munkasor automatikus L${level} eszkaláció.`,"",
        `CAPA: ${row.title}`,
        `Súlyosság: ${String(row.severity).toUpperCase()}`,
        `Kockázati pontszám: ${Number(row.score||0)}/100`,
        `Telephely: ${row.location_id||'—'}`,
        `Trigger: ${trigger}`,
        `Kiosztás / javaslat kora: ${ageMinutes} perc`,
        `Felelős: ${row.assigned_owner_key||row.assigned_owner_team||'nincs kijelölve'}`,
        `Visszaigazolva: ${row.acknowledged_at?'igen':'nem'}`,
        `Javasolt határidő: ${row.suggested_due_at?new Date(row.suggested_due_at).toISOString():'—'}`,"",
        'VIR → Statisztika és VIR → CAPA vezetői munkasor',
      ].join('\n');
      try{
        const result:any=await sendEmail({to:recipient,subject,text});
        status=result?.sent?'sent':'logged';
        detail=result?.logged?'SMTP nem küldött; az eszkaláció naplózásra került.':null;
      }catch(error:any){status='failed';detail=error?.message||String(error)}
    }else detail='Nincs tenant-szintű vezetői e-mail cím konfigurálva.';
    await finishDelivery(reservation,status,detail);
    if(status==='sent')sent++;else if(status==='failed')failed++;else logged++;
  }
  if(sent+failed+logged>0){
    await db.query(`UPDATE exception_capa_improvement_recommendations SET last_management_notice_at=now(),updated_at=now() WHERE capa_id=$1::uuid`,[row.capa_id]);
    await db.query(`INSERT INTO exception_capa_events(capa_id,event_type,actor_key,message,evidence)
      VALUES($1::uuid,'improvement_assignment_escalated','system-management-watchdog',$2,$3::jsonb)`,[
      row.capa_id,`Automatikus L${level} CAPA vezetői eszkaláció: ${trigger}.`,JSON.stringify({level,trigger,age_minutes:ageMinutes,recipients:effective,sent,failed,logged})
    ]);
  }
  return{sent,failed,logged,skipped};
}

export async function runExceptionCapaManagementWatchdog(){
  if(cyclePromise)return cyclePromise;
  cyclePromise=(async()=>{
    await ensureExceptionCapaManagementWatchdogSchema();
    const {rows}=await db.query(`
      SELECT r.capa_id::text,r.status recommendation_status,r.score,r.suggested_due_at,r.recommended_at,r.last_evaluated_at,
        r.assigned_owner_key,r.assigned_owner_team,r.assigned_at,r.acknowledged_at,
        c.title,c.severity,rc.location_id::text,loc.tenant_id::text,
        er.level1_after_minutes,er.level2_after_minutes,er.level3_after_minutes
      FROM exception_capa_improvement_recommendations r
      JOIN exception_capa_candidates c ON c.id=r.capa_id
      JOIN exception_root_cause_clusters rc ON rc.id=c.cluster_id
      JOIN locations loc ON loc.id::text=rc.location_id::text
      JOIN exception_escalation_rules er ON er.severity=c.severity AND er.active=true
      LEFT JOIN exception_capa_improvement_links l ON l.capa_id=r.capa_id AND l.tenant_id=loc.tenant_id
      WHERE r.status='recommended'
        AND l.project_id IS NULL
        AND (r.assigned_at IS NULL OR r.acknowledged_at IS NULL)
      ORDER BY c.severity,r.score DESC,r.suggested_due_at NULLS LAST
      LIMIT 1000
    `);
    let escalated=0,sent=0,failed=0,logged=0,skipped=0;
    for(const row of rows){
      const target=escalationTarget(row);if(!target.level)continue;
      const result=await deliver(row,target.level,target.trigger,target.age_minutes);
      if(result.sent+result.failed+result.logged>0)escalated++;
      sent+=result.sent;failed+=result.failed;logged+=result.logged;skipped+=result.skipped;
    }
    return{checked:rows.length,escalated,sent,failed,logged,skipped,generated_at:new Date().toISOString()};
  })().finally(()=>{cyclePromise=null});
  return cyclePromise;
}

export function startExceptionCapaManagementWatchdog(){
  if(started||process.env.EXCEPTION_CENTER_DISABLED==='1'||process.env.NODE_ENV==='test')return;
  started=true;
  cron.schedule('*/15 * * * *',()=>{void runExceptionCapaManagementWatchdog().catch(error=>console.error('[exception-capa] management watchdog failed',error))},{timezone:'Europe/Budapest'});
}
