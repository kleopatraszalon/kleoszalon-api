import cron from "node-cron";
import db from "../db";
import { sendEmail } from "../mailer";
import { getApmAdminRecipients } from "./apmAlertDelivery";
import { ensureMajorIncidentHardeningSchema } from "./majorIncidentWarRoomHardening";

const TZ="Europe/Budapest";
let started=false;
let running:Promise<any>|null=null;
const safe=(v:unknown)=>String(v??"").trim();
const ageMinutes=(v:any)=>Math.max(0,Math.round((Date.now()-new Date(v).getTime())/60000));

async function recentlyAlerted(incidentId:string,code:string){
  const row=(await db.query(`SELECT 1 FROM major_incident_events WHERE incident_id=$1::uuid AND event_type='watchdog_alert' AND evidence->>'code'=$2 AND created_at>now()-interval '60 minutes' LIMIT 1`,[incidentId,code])).rows[0];return Boolean(row);
}
async function auditNotification(incidentId:string,key:string,recipient:string,status:'sent'|'failed'|'logged',error?:string|null){
  await db.query(`INSERT INTO major_incident_notifications(incident_id,notification_key,recipient,status,error_text) VALUES($1::uuid,$2,$3,$4,$5)`,[incidentId,key,recipient,status,error?String(error).slice(0,1500):null]);
}
async function alert(row:any,code:string,message:string){
  if(await recentlyAlerted(row.id,code))return{deduplicated:true,sent:0,failed:0,logged:0};
  await db.query(`INSERT INTO major_incident_events(incident_id,event_type,actor_key,message,evidence) VALUES($1::uuid,'watchdog_alert','system-war-room-watchdog',$2,$3::jsonb)`,[row.id,message,JSON.stringify({code,severity:row.severity,status:row.status,incident_no:row.incident_no})]);
  const recipients=await getApmAdminRecipients(),key=`major-incident-watchdog:${row.id}:${code}`;
  if(!recipients.length){await auditNotification(row.id,key,'unconfigured-admin-recipient','logged','Nincs konfigurált admin e-mail cím.');return{deduplicated:false,sent:0,failed:0,logged:1}}
  const subject=`[WAR ROOM WATCHDOG ${String(row.severity).toUpperCase()}] ${row.incident_no} · ${code}`;
  const text=[`Major Incident War Room watchdog riasztás.`,``,`Incidens: ${row.incident_no} · ${row.title}`,`SEV: ${row.severity}`,`Státusz: ${row.status}`,`Impact: ${row.impact_score}/100`,`Riasztás: ${message}`,``,`VIR → Statisztika és VIR → Major Incident / War Room`].join('\n');
  let sent=0,failed=0,logged=0;for(const recipient of recipients){try{const result:any=await sendEmail({to:recipient,subject,text});const status=result?.sent?'sent':'logged';await auditNotification(row.id,key,recipient,status,result?.logged?'SMTP nem küldött; naplózva.':null);if(status==='sent')sent++;else logged++}catch(error:any){failed++;await auditNotification(row.id,key,recipient,'failed',error?.message||String(error))}}
  return{deduplicated:false,sent,failed,logged};
}

export async function runMajorIncidentWarRoomWatchdog(){
  if(running)return running;
  running=(async()=>{
    await ensureMajorIncidentHardeningSchema();
    const rows=(await db.query(`SELECT mi.*,
        COALESCE((SELECT MAX(u.created_at) FROM major_incident_updates u WHERE u.incident_id=mi.id),mi.declared_at) last_update_at,
        (SELECT COUNT(*)::int FROM major_incident_actions a WHERE a.incident_id=mi.id AND a.status IN('open','in_progress') AND a.priority IN('critical','high') AND a.due_at<now()) overdue_actions
      FROM major_incidents mi WHERE mi.severity IN('sev1','sev2') AND mi.status IN('open','mitigating','monitoring') ORDER BY mi.declared_at`)).rows;
    let alerts=0,deduplicated=0,sent=0,failed=0,logged=0;
    for(const row of rows){
      const incidentAge=ageMinutes(row.declared_at),updateAge=ageMinutes(row.last_update_at),commanderLimit=row.severity==='sev1'?15:30,updateLimit=row.severity==='sev1'?30:60;
      const checks:Array<{code:string;message:string;active:boolean}>=[
        {code:'commander_missing',active:!safe(row.incident_commander_key)&&incidentAge>=commanderLimit,message:`${incidentAge} perce deklarált ${String(row.severity).toUpperCase()} incidenshez nincs incident commander.`},
        {code:'war_room_update_stale',active:updateAge>=updateLimit,message:`${updateAge} perce nem készült War Room státuszfrissítés; elvárt maximum ${updateLimit} perc.`},
        {code:'critical_action_overdue',active:Number(row.overdue_actions||0)>0,message:`${Number(row.overdue_actions||0)} Critical/High War Room akció lejárt.`},
      ];
      for(const check of checks)if(check.active){const r=await alert(row,check.code,check.message);if(r.deduplicated)deduplicated++;else alerts++;sent+=r.sent;failed+=r.failed;logged+=r.logged}
    }
    return{ok:true,incidents_checked:rows.length,alerts,deduplicated,sent,failed,logged,generated_at:new Date().toISOString()};
  })().finally(()=>{running=null});
  return running;
}

export function startMajorIncidentWarRoomWatchdog(){
  if(started||process.env.EXCEPTION_CENTER_DISABLED==='1'||process.env.NODE_ENV==='test')return;started=true;
  cron.schedule('*/5 * * * *',()=>{void runMajorIncidentWarRoomWatchdog().catch(error=>console.error('[major-incident-watchdog] run failed',error))},{timezone:TZ});
  const timer=setTimeout(()=>{void runMajorIncidentWarRoomWatchdog().catch(error=>console.error('[major-incident-watchdog] initial run failed',error))},125_000);timer.unref?.();
  console.log('[major-incident-watchdog] heartbeat scheduled every 5 minutes Europe/Budapest');
}
