import cron from "node-cron";
import db from "../db";
import { sendEmail } from "../mailer";
import { getApmAdminRecipients } from "./apmAlertDelivery";
import { assessTraceForensics, ensureTransactionTraceForensicsSchema } from "./transactionTraceForensics";

const TZ="Europe/Budapest";
const COOLDOWN_MINUTES=Math.max(30,Number(process.env.TRANSACTION_TRACE_ALERT_COOLDOWN_MINUTES||180));
let started=false;
let ready:Promise<void>|null=null;

async function ensureWatchdogSchema(){if(!ready)ready=(async()=>{await ensureTransactionTraceForensicsSchema();await db.query(`
 CREATE TABLE IF NOT EXISTS business_transaction_trace_watchdog_state(
  state_key text PRIMARY KEY,
  last_run_at timestamptz,
  last_notified_at timestamptz,
  last_checked integer NOT NULL DEFAULT 0,
  last_attention integer NOT NULL DEFAULT 0,
  last_critical integer NOT NULL DEFAULT 0,
  last_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
 );
`)})().catch(error=>{ready=null;throw error});return ready}

async function syncAlert(trace:any,item:any){const key=`trace:${trace.trace_id}:${item.code}`;await db.query(`INSERT INTO business_transaction_trace_alerts(alert_key,trace_id,severity,alert_type,title,detail) VALUES($1,$2::uuid,$3,$4,$5,$6) ON CONFLICT(alert_key) DO UPDATE SET severity=EXCLUDED.severity,title=EXCLUDED.title,detail=EXCLUDED.detail,last_seen_at=now(),resolved_at=NULL,occurrences=business_transaction_trace_alerts.occurrences+1`,[key,trace.trace_id,item.severity,item.code,item.title,item.detail]);return key}

async function sendDigest(criticalItems:any[],checked:number,attention:number){
 const state=(await db.query(`SELECT last_notified_at FROM business_transaction_trace_watchdog_state WHERE state_key='global'`)).rows[0];
 const last=state?.last_notified_at?new Date(state.last_notified_at).getTime():0;
 if(!criticalItems.length||last&&Date.now()-last<COOLDOWN_MINUTES*60000)return{sent:false,reason:criticalItems.length?'cooldown':'no-critical'};
 const recipients=await getApmAdminRecipients();
 const top=criticalItems.slice(0,20);
 const subject=`[CRITICAL] VIR Transaction Trace Watchdog – ${criticalItems.length} kritikus eltérés`;
 const text=[
  'A VIR Transaction Trace Watchdog kritikus bizonyítási/életút eltérést észlelt.','',
  `Ellenőrzött trace-ek: ${checked}`,
  `Összes eltérés: ${attention}`,
  `Kritikus eltérések: ${criticalItems.length}`,'',
  ...top.flatMap((x:any,i:number)=>[`${i+1}. ${x.root_type} · ${x.root_id}`,`   ${x.title}: ${x.detail}`]),
  criticalItems.length>top.length?`... +${criticalItems.length-top.length} további kritikus eltérés.`:'','',
  'VIR → Pénzügy és pénztár → Tranzakció-életút',
  'A watchdog nem módosított üzleti adatot; csak bizonyítási állapotot ellenőrzött.'
 ].filter(Boolean).join('\n');
 if(!recipients.length){await db.query(`INSERT INTO business_transaction_trace_alert_deliveries(alert_key,recipient,status,error_text) VALUES('trace-watchdog-digest','unconfigured-admin-recipient','logged','Nincs admin e-mail cím konfigurálva.')`);return{sent:false,reason:'no-recipient'}}
 let sent=0,failed=0;for(const recipient of recipients){try{const r:any=await sendEmail({to:recipient,subject,text});await db.query(`INSERT INTO business_transaction_trace_alert_deliveries(alert_key,recipient,status,error_text) VALUES('trace-watchdog-digest',$1,$2,$3)`,[recipient,r?.sent?'sent':'logged',r?.logged?'SMTP nem küldött; naplózva.':null]);if(r?.sent)sent++}catch(error:any){failed++;await db.query(`INSERT INTO business_transaction_trace_alert_deliveries(alert_key,recipient,status,error_text) VALUES('trace-watchdog-digest',$1,'failed',$2)`,[recipient,String(error?.message||error).slice(0,1500)])}}
 await db.query(`INSERT INTO business_transaction_trace_watchdog_state(state_key,last_notified_at,updated_at) VALUES('global',now(),now()) ON CONFLICT(state_key) DO UPDATE SET last_notified_at=now(),updated_at=now()`);
 return{sent:sent>0,sent_count:sent,failed_count:failed};
}

export async function runSafeTraceWatchdog(limit=800){
 await ensureWatchdogSchema();const traces=(await db.query(`SELECT trace_id::text,root_type,root_id,location_id,lifecycle_status,integrity_status,last_sequence,last_hash,first_seen_at,last_seen_at FROM business_transaction_traces WHERE last_seen_at>=now()-interval '30 days' ORDER BY last_seen_at DESC LIMIT $1`,[Math.max(1,Math.min(2000,Number(limit||800)))])).rows;
 let checked=0,attention=0,critical=0;const criticalItems:any[]=[];
 for(const trace of traces){checked++;try{const assessment=await assessTraceForensics(String(trace.trace_id),'trace-watchdog');const active=new Set<string>();for(const item of assessment.anomalies){active.add(item.code);await syncAlert(trace,item);attention++;if(item.severity==='critical'){critical++;criticalItems.push({trace_id:trace.trace_id,root_type:trace.root_type,root_id:trace.root_id,title:item.title,detail:item.detail,code:item.code})}}await db.query(`UPDATE business_transaction_trace_alerts SET resolved_at=COALESCE(resolved_at,now()),last_seen_at=now() WHERE trace_id=$1::uuid AND resolved_at IS NULL AND NOT (alert_type=ANY($2::text[]))`,[trace.trace_id,active.size?Array.from(active):['__none__']])}catch(error:any){console.error('[transaction-trace] safe watchdog trace failed',trace.trace_id,error?.message||error)}}
 const notification=await sendDigest(criticalItems,checked,attention);const summary={checked,attention,critical,notification,generated_at:new Date().toISOString()};
 await db.query(`INSERT INTO business_transaction_trace_watchdog_state(state_key,last_run_at,last_checked,last_attention,last_critical,last_summary,updated_at) VALUES('global',now(),$1,$2,$3,$4::jsonb,now()) ON CONFLICT(state_key) DO UPDATE SET last_run_at=now(),last_checked=EXCLUDED.last_checked,last_attention=EXCLUDED.last_attention,last_critical=EXCLUDED.last_critical,last_summary=EXCLUDED.last_summary,updated_at=now()`,[checked,attention,critical,JSON.stringify(summary)]);
 return summary;
}

export function startSafeTraceWatchdog(){if(started||process.env.TRANSACTION_TRACE_DISABLED==='1'||process.env.NODE_ENV==='test')return;started=true;cron.schedule('*/10 * * * *',()=>{void runSafeTraceWatchdog(1000).catch(error=>console.error('[transaction-trace] digest watchdog failed',error))},{timezone:TZ});const timer=setTimeout(()=>{void runSafeTraceWatchdog(600).catch(error=>console.error('[transaction-trace] initial digest watchdog failed',error))},150000);timer.unref?.();console.log('[transaction-trace] digest watchdog scheduled every 10 minutes Europe/Budapest')}
