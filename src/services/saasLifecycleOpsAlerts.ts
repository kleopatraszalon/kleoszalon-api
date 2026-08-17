import db from '../db';
import {sendEmail} from '../mailer';

type AlertInput={alertKey:string;alertType:string;severity:'warning'|'critical';title:string;message:string;details?:any};
const ALERT_RECIPIENTS=String(process.env.SAAS_LIFECYCLE_OPS_ALERT_EMAILS||'').split(',').map(x=>x.trim()).filter(Boolean);

async function upsertAlert(input:AlertInput){
  const {rows}=await db.query(`INSERT INTO saas_lifecycle_ops_alerts(alert_key,alert_type,severity,title,message,status,details)
    VALUES($1,$2,$3,$4,$5,'open',$6::jsonb)
    ON CONFLICT(alert_key) DO UPDATE SET alert_type=EXCLUDED.alert_type,severity=EXCLUDED.severity,title=EXCLUDED.title,message=EXCLUDED.message,
      status=CASE WHEN saas_lifecycle_ops_alerts.status='resolved' THEN 'open' ELSE saas_lifecycle_ops_alerts.status END,
      resolved_at=CASE WHEN saas_lifecycle_ops_alerts.status='resolved' THEN NULL ELSE saas_lifecycle_ops_alerts.resolved_at END,
      last_seen_at=now(),details=EXCLUDED.details,updated_at=now()
    RETURNING id::text,alert_key,severity,title,message,status,last_notified_at`,[input.alertKey,input.alertType,input.severity,input.title,input.message,JSON.stringify(input.details||{})]);
  const row=rows[0];
  if(row&&input.severity==='critical'&&ALERT_RECIPIENTS.length){
    const last=row.last_notified_at?new Date(row.last_notified_at).getTime():0;
    if(!last||Date.now()-last>=12*60*60*1000){
      try{
        const result=await sendEmail({to:ALERT_RECIPIENTS.join(','),subject:`[KleoSaaS CRITICAL] ${input.title}`,text:`${input.title}\n\n${input.message}\n\nAlert key: ${input.alertKey}`,html:`<h3>${input.title}</h3><p>${input.message}</p><p><small>${input.alertKey}</small></p>`});
        if(result?.sent)await db.query(`UPDATE saas_lifecycle_ops_alerts SET last_notified_at=now(),notification_error=NULL,updated_at=now() WHERE id=$1::bigint`,[row.id]);
        else await db.query(`UPDATE saas_lifecycle_ops_alerts SET notification_error='SMTP_NOT_SENT',updated_at=now() WHERE id=$1::bigint`,[row.id]);
      }catch(error:any){await db.query(`UPDATE saas_lifecycle_ops_alerts SET notification_error=$2,updated_at=now() WHERE id=$1::bigint`,[row.id,String(error?.message||error).slice(0,1000)]).catch(()=>{});}
    }
  }
  return row;
}

async function resolveAlert(alertKey:string){await db.query(`UPDATE saas_lifecycle_ops_alerts SET status='resolved',resolved_at=now(),updated_at=now() WHERE alert_key=$1 AND status<>'resolved'`,[alertKey]);}

export async function reconcileLifecycleOpsAlerts(){
  const [lastRun,queue]=await Promise.all([
    db.query(`SELECT status,finished_at,error_text FROM saas_lifecycle_scheduler_runs ORDER BY started_at DESC LIMIT 1`),
    db.query(`SELECT count(*) FILTER(WHERE status='pending')::int pending,count(*) FILTER(WHERE status='failed')::int failed,count(*) FILTER(WHERE status='pending' AND next_attempt_at<=now())::int due_now FROM saas_lifecycle_notification_queue`)
  ]);
  const last=lastRun.rows[0];const q=queue.rows[0]||{pending:0,failed:0,due_now:0};
  if(last?.status==='failed')await upsertAlert({alertKey:'scheduler:last-run-failed',alertType:'scheduler_failed',severity:'critical',title:'Lifecycle scheduler futás sikertelen',message:String(last.error_text||'A legutóbbi lifecycle scheduler futás hibával zárult.'),details:last});else await resolveAlert('scheduler:last-run-failed');
  const age=last?.finished_at?(Date.now()-new Date(last.finished_at).getTime())/60000:null;
  if(age!==null&&age>130)await upsertAlert({alertKey:'scheduler:stale',alertType:'scheduler_stale',severity:'critical',title:'Lifecycle scheduler nem futott időben',message:`Az utolsó befejezett lifecycle futás ${Math.floor(age)} perce történt.`,details:{age_minutes:Math.floor(age)}});else await resolveAlert('scheduler:stale');
  if(Number(q.failed)>0)await upsertAlert({alertKey:'queue:failed',alertType:'queue_failed',severity:'critical',title:'Lifecycle dead-letter queue nem üres',message:`${Number(q.failed)} értesítés véglegesen failed állapotú.`,details:q});else await resolveAlert('queue:failed');
  if(Number(q.pending)>=25)await upsertAlert({alertKey:'queue:backlog',alertType:'queue_backlog',severity:'warning',title:'Lifecycle értesítési backlog magas',message:`${Number(q.pending)} értesítés vár feldolgozásra.`,details:q});else await resolveAlert('queue:backlog');
}
