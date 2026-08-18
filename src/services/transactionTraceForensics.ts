import crypto from "crypto";
import cron from "node-cron";
import db from "../db";
import { sendEmail } from "../mailer";
import { getApmAdminRecipients } from "./apmAlertDelivery";
import { ensureTransactionTraceabilitySchema, verifyTransactionTrace } from "./transactionTraceability";
import { ensureTransactionTraceSigningSchema, verifyTraceProofSignature } from "./transactionTraceSigning";

const TZ="Europe/Budapest";
const SLA_MINUTES=Math.max(30,Number(process.env.TRANSACTION_TRACE_SLA_MINUTES||240));
const ALERT_COOLDOWN_MINUTES=Math.max(30,Number(process.env.TRANSACTION_TRACE_ALERT_COOLDOWN_MINUTES||180));
let schemaPromise:Promise<void>|null=null;
let started=false;

const hmacKey=()=>String(process.env.TRANSACTION_TRACE_HMAC_KEY||"").trim();
const n=(v:unknown)=>{const x=Number(v??0);return Number.isFinite(x)?x:0};
const ageMinutes=(v:unknown)=>Math.max(0,Math.round((Date.now()-new Date(String(v)).getTime())/60000));

export function ensureTransactionTraceForensicsSchema(){
 if(!schemaPromise)schemaPromise=(async()=>{
  await ensureTransactionTraceabilitySchema();
  await ensureTransactionTraceSigningSchema();
  await db.query(`
   CREATE TABLE IF NOT EXISTS business_transaction_trace_alerts(
    alert_key text PRIMARY KEY,
    trace_id uuid NOT NULL REFERENCES business_transaction_traces(trace_id) ON DELETE CASCADE,
    severity text NOT NULL CHECK(severity IN('warning','critical')),
    alert_type text NOT NULL,
    title text NOT NULL,
    detail text NOT NULL,
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    last_notified_at timestamptz,
    resolved_at timestamptz,
    occurrences bigint NOT NULL DEFAULT 1
   );
   CREATE INDEX IF NOT EXISTS business_transaction_trace_alerts_open_idx ON business_transaction_trace_alerts(resolved_at,last_seen_at DESC);
   CREATE TABLE IF NOT EXISTS business_transaction_trace_alert_deliveries(
    id bigserial PRIMARY KEY,
    alert_key text NOT NULL,
    recipient text NOT NULL,
    status text NOT NULL CHECK(status IN('sent','failed','logged')),
    error_text text,
    created_at timestamptz NOT NULL DEFAULT now()
   );
   CREATE INDEX IF NOT EXISTS business_transaction_trace_alert_deliveries_key_idx ON business_transaction_trace_alert_deliveries(alert_key,created_at DESC);
  `);
 })().catch(error=>{schemaPromise=null;throw error});
 return schemaPromise;
}

async function traceRow(traceId:string){return(await db.query(`SELECT trace_id::text,root_type,root_id,location_id,title,lifecycle_status,integrity_status,last_sequence,last_hash,first_seen_at,last_seen_at,created_at,updated_at FROM business_transaction_traces WHERE trace_id=$1::uuid`,[traceId])).rows[0]}
async function traceIdFor(rootType:string,rootId:string){return String((await db.query(`SELECT trace_id::text FROM business_transaction_traces WHERE root_type=$1 AND root_id=$2 LIMIT 1`,[rootType,rootId])).rows[0]?.trace_id||"")}

export async function buildTraceGraph(traceId:string){
 await ensureTransactionTraceForensicsSchema();
 const [trace,entities,events]=await Promise.all([
  traceRow(traceId),
  db.query(`SELECT entity_type,entity_id,relation,first_seen_at,last_seen_at FROM business_transaction_entities WHERE trace_id=$1::uuid ORDER BY first_seen_at,entity_type,entity_id`,[traceId]),
  db.query(`SELECT sequence,entity_type,entity_id,module_key,event_type,occurred_at FROM business_transaction_events WHERE trace_id=$1::uuid ORDER BY sequence`,[traceId]),
 ]);
 if(!trace)throw Object.assign(new Error("A trace nem található."),{status:404});
 const nodes:any[]=[{id:`root:${trace.root_type}:${trace.root_id}`,type:"root",label:`${trace.root_type} · ${trace.root_id}`,module:"root",status:trace.lifecycle_status}];
 const seen=new Set(nodes.map(x=>x.id));
 for(const e of entities.rows){const id=`${e.entity_type}:${e.entity_id}`;if(!seen.has(id)){seen.add(id);nodes.push({id,type:e.entity_type,label:String(e.entity_id),module:moduleForEntity(e.entity_type),relation:e.relation,first_seen_at:e.first_seen_at,last_seen_at:e.last_seen_at})}}
 const edges:any[]=[];
 for(const e of entities.rows)edges.push({from:nodes[0].id,to:`${e.entity_type}:${e.entity_id}`,type:"contains",label:e.relation||"member"});
 let prev:any=null;
 for(const ev of events.rows){const current=`${ev.entity_type}:${ev.entity_id}`;if(prev&&prev!==current)edges.push({from:prev,to:current,type:"sequence",label:`#${ev.sequence}`});prev=current}
 return{trace_id:trace.trace_id,root:{type:trace.root_type,id:trace.root_id},nodes:nodes.slice(0,250),edges:dedupeEdges(edges).slice(0,500),generated_at:new Date().toISOString()};
}
function moduleForEntity(entity:string){if(entity.startsWith('appointment'))return'booking';if(entity.startsWith('work_order'))return'workorder';if(entity.includes('inventory'))return'inventory';if(entity.includes('purchase')||entity.includes('procurement'))return'procurement';return'finance'}
function dedupeEdges(items:any[]){const seen=new Set<string>();return items.filter(x=>{const k=`${x.from}|${x.to}|${x.type}`;if(seen.has(k))return false;seen.add(k);return true})}

export async function assessTraceForensics(traceId:string,verifiedBy="forensic-toolkit"){
 await ensureTransactionTraceForensicsSchema();
 const trace=await traceRow(traceId);if(!trace)throw Object.assign(new Error("A trace nem található."),{status:404});
 const [proof,signature,eventsResult,entityCountResult]=await Promise.all([
  verifyTransactionTrace(traceId,verifiedBy),
  verifyTraceProofSignature(traceId),
  db.query(`SELECT sequence,event_type,entity_type,entity_id,module_key,action,occurred_at,source,event_hash,evidence FROM business_transaction_events WHERE trace_id=$1::uuid ORDER BY sequence`,[traceId]),
  db.query(`SELECT COUNT(*)::int count FROM business_transaction_entities WHERE trace_id=$1::uuid`,[traceId]),
 ]);
 const events=eventsResult.rows;const anomalies:any[]=[];let risk=0;
 const add=(severity:"warning"|"critical",code:string,title:string,detail:string,points:number,evidence:any={})=>{anomalies.push({severity,code,title,detail,points,evidence});risk+=points};
 if(proof.result!=="verified"||!proof.hash_chain_ok||!proof.sequence_ok)add("critical","hash_chain_broken","Hash-lánc sérült","Az append-only eseménylánc sorrendje vagy hash-kapcsolata nem igazolható.",80,{proof});
 if(signature.status==="broken")add("critical","hmac_broken","HMAC proof érvénytelen","A külső kulccsal ellenőrzött checkpoint nem érvényes.",90,{signature});
 else if(!signature.configured)add("critical","hmac_unconfigured","HMAC aláírás nincs konfigurálva","A DB-n kívüli proof kulcs nincs beállítva, ezért a bizonyítás nem teljes értékű.",65,{});
 else if(signature.status!=="verified")add("warning","hmac_not_current","HMAC checkpoint nem aktuális",signature.message||"A trace aktuális állapotára nincs friss HMAC checkpoint.",35,{signature});
 const age=ageMinutes(trace.first_seen_at),inactive=ageMinutes(trace.last_seen_at);
 if(trace.lifecycle_status!=="complete"&&age>SLA_MINUTES)add(age>SLA_MINUTES*2?"critical":"warning","lifecycle_sla_breach","Életút SLA túllépés",`A tranzakció ${age} perce nyitott/hiányos; az SLA ${SLA_MINUTES} perc.`,age>SLA_MINUTES*2?55:30,{age_minutes:age,sla_minutes:SLA_MINUTES});
 if(trace.integrity_status==="broken")add("critical","trace_marked_broken","Trace integritási státusz sérült","A trace központi integritási státusza broken.",80,{});
 if(!events.length)add("critical","events_missing","Bizonyítási események hiányoznak","A trace létrejött, de nincs hozzá eseménybizonyíték.",80,{});
 const gaps:number[]=[];for(let i=1;i<events.length;i++)gaps.push(Math.max(0,(new Date(events[i].occurred_at).getTime()-new Date(events[i-1].occurred_at).getTime())/60000));
 const maxGap=gaps.length?Math.max(...gaps):0;if(maxGap>SLA_MINUTES*2&&trace.lifecycle_status!=="complete")add("warning","large_event_gap","Hosszú eseményköz",`A legnagyobb eseményköz ${Math.round(maxGap)} perc.`,20,{max_gap_minutes:Math.round(maxGap)});
 const navErrors=events.filter((e:any)=>e.entity_type==='nav_invoice_queue'&&['error','failed','rejected'].includes(String(e.evidence?.status||'').toLowerCase())).length;if(navErrors)add("critical","nav_error_event","NAV hibás esemény",`${navErrors} NAV esemény hibás/elutasított állapotot tartalmaz.`,60,{count:navErrors});
 const reversals=events.filter((e:any)=>e.event_type.includes('financial_movements')&&(e.evidence?.reversed_by_id||e.evidence?.payment_status==='reversal'||e.evidence?.reference_type==='reversal')).length;if(reversals)add("warning","financial_reversal","Pénzügyi sztornó/ellenkönyvelés",`${reversals} reversal esemény található; vezetői audit indokolt.`,10,{count:reversals});
 risk=Math.min(100,risk);
 const grade=risk>=70?'critical':risk>=30?'warning':'ok';
 return{trace,proof,signature,risk_score:risk,risk_level:grade,sla:{limit_minutes:SLA_MINUTES,age_minutes:age,inactive_minutes:inactive,breached:trace.lifecycle_status!=="complete"&&age>SLA_MINUTES},counts:{events:events.length,entities:Number(entityCountResult.rows[0]?.count||0),anomalies:anomalies.length},anomalies,generated_at:new Date().toISOString()};
}

function canonical(value:any):string{if(value===null||typeof value!=="object")return JSON.stringify(value);if(Array.isArray(value))return`[${value.map(canonical).join(',')}]`;return`{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`}
export async function buildProofPackage(rootType:string,rootId:string,generatedBy="management-user"){
 await ensureTransactionTraceForensicsSchema();const tid=await traceIdFor(rootType,rootId);if(!tid)throw Object.assign(new Error("A trace még nem létezik. Nyisd meg előbb az életutat vagy futtass backfillt."),{status:404});
 const [assessment,graph,events,entities,verifications,signatures]=await Promise.all([
  assessTraceForensics(tid,generatedBy),buildTraceGraph(tid),
  db.query(`SELECT event_id::text,sequence,event_type,entity_type,entity_id,module_key,action,occurred_at,actor_key,source,previous_hash,event_hash,evidence,metadata FROM business_transaction_events WHERE trace_id=$1::uuid ORDER BY sequence`,[tid]),
  db.query(`SELECT entity_type,entity_id,relation,first_seen_at,last_seen_at FROM business_transaction_entities WHERE trace_id=$1::uuid ORDER BY first_seen_at,entity_type`,[tid]),
  db.query(`SELECT verified_at,verified_by,event_count,broken_count,sequence_ok,hash_chain_ok,result,detail FROM business_transaction_verifications WHERE trace_id=$1::uuid ORDER BY verified_at DESC LIMIT 20`,[tid]),
  db.query(`SELECT trace_sequence,trace_hash,algorithm,key_id,signature,signed_by,signed_at FROM business_transaction_proof_signatures WHERE trace_id=$1::uuid ORDER BY signed_at DESC LIMIT 20`,[tid]),
 ]);
 const body={format:"KLEO-VIR-TRANSACTION-PROOF-PACKAGE-V1",generated_at:new Date().toISOString(),generated_by:generatedBy,trace:assessment.trace,forensics:assessment,graph,events:events.rows,entities:entities.rows,verifications:verifications.rows,proof_signatures:signatures.rows};
 const canonicalBody=canonical(body),manifestHash=crypto.createHash('sha256').update(canonicalBody,'utf8').digest('hex'),key=hmacKey();
 const manifestSignature=key?crypto.createHmac('sha256',key).update(manifestHash,'utf8').digest('hex'):null;
 return{...body,manifest:{algorithm:"SHA-256",hash:manifestHash,hmac_algorithm:key?"HMAC-SHA256":null,hmac_signature:manifestSignature,key_id:key?String(process.env.TRANSACTION_TRACE_HMAC_KEY_ID||'render-hmac-v1'):null,signed:Boolean(key)}};
}

export async function traceHealthSummary(days=30,locationId:string|null=null){
 await ensureTransactionTraceForensicsSchema();const d=Math.max(1,Math.min(365,Number(days||30)));const params:any[]=[d];let loc='';if(locationId){params.push(locationId);loc=` AND t.location_id=$2`}
 const summary=(await db.query(`SELECT COUNT(*)::int total,COUNT(*) FILTER(WHERE t.lifecycle_status='complete')::int complete,COUNT(*) FILTER(WHERE t.lifecycle_status<>'complete')::int incomplete,COUNT(*) FILTER(WHERE t.integrity_status='verified')::int verified,COUNT(*) FILTER(WHERE t.integrity_status='broken')::int broken,COUNT(*) FILTER(WHERE t.last_sequence>0)::int evented FROM business_transaction_traces t WHERE t.last_seen_at>=now()-($1::text||' days')::interval${loc}`,params)).rows[0]||{};
 const unsigned=(await db.query(`SELECT COUNT(*)::int count FROM business_transaction_traces t WHERE t.last_seen_at>=now()-($1::text||' days')::interval${loc} AND t.last_sequence>0 AND NOT EXISTS(SELECT 1 FROM business_transaction_proof_signatures s WHERE s.trace_id=t.trace_id AND s.trace_sequence=t.last_sequence AND s.trace_hash=t.last_hash AND s.key_id=$${params.length+1})`,[...params,String(process.env.TRANSACTION_TRACE_HMAC_KEY_ID||'render-hmac-v1')])).rows[0]?.count||0;
 const alerts=(await db.query(`SELECT COUNT(*) FILTER(WHERE resolved_at IS NULL)::int open,COUNT(*) FILTER(WHERE resolved_at IS NULL AND severity='critical')::int critical FROM business_transaction_trace_alerts`)).rows[0]||{};
 const recentBroken=(await db.query(`SELECT trace_id::text,root_type,root_id,location_id,lifecycle_status,integrity_status,last_seen_at FROM business_transaction_traces t WHERE t.last_seen_at>=now()-($1::text||' days')::interval${loc} AND (t.integrity_status='broken' OR t.lifecycle_status='incomplete') ORDER BY last_seen_at DESC LIMIT 30`,params)).rows;
 return{days:d,location_id:locationId,hmac_configured:Boolean(hmacKey()),sla_minutes:SLA_MINUTES,counts:{total:n(summary.total),complete:n(summary.complete),incomplete:n(summary.incomplete),verified:n(summary.verified),broken:n(summary.broken),evented:n(summary.evented),unsigned_current:n(unsigned),open_alerts:n(alerts.open),critical_alerts:n(alerts.critical)},recent_attention:recentBroken,generated_at:new Date().toISOString()};
}

async function auditDelivery(alertKey:string,recipient:string,status:'sent'|'failed'|'logged',error?:string){await db.query(`INSERT INTO business_transaction_trace_alert_deliveries(alert_key,recipient,status,error_text) VALUES($1,$2,$3,$4)`,[alertKey,recipient,status,error?String(error).slice(0,1500):null])}
async function notify(alert:any){const recipients=await getApmAdminRecipients();if(!recipients.length){await auditDelivery(alert.alert_key,'unconfigured-admin-recipient','logged','Nincs admin e-mail cím konfigurálva.');return}const subject=`[${alert.severity==='critical'?'CRITICAL':'WARNING'}] VIR trace – ${alert.title}`;const text=[alert.title,'',alert.detail,'',`Trace: ${alert.trace_id}`,`Típus: ${alert.root_type}`,`Azonosító: ${alert.root_id}`,'','VIR → Pénzügy és pénztár → Tranzakció-életút'].join('\n');for(const recipient of recipients){try{const r:any=await sendEmail({to:recipient,subject,text});await auditDelivery(alert.alert_key,recipient,r?.sent?'sent':'logged',r?.logged?'SMTP nem küldött; naplózva.':undefined)}catch(error:any){await auditDelivery(alert.alert_key,recipient,'failed',error?.message||String(error))}}}
async function upsertAlert(trace:any,severity:'warning'|'critical',type:string,title:string,detail:string){const key=`trace:${trace.trace_id}:${type}`;const previous=(await db.query(`SELECT * FROM business_transaction_trace_alerts WHERE alert_key=$1`,[key])).rows[0];const row=(await db.query(`INSERT INTO business_transaction_trace_alerts(alert_key,trace_id,severity,alert_type,title,detail) VALUES($1,$2::uuid,$3,$4,$5,$6) ON CONFLICT(alert_key) DO UPDATE SET severity=EXCLUDED.severity,title=EXCLUDED.title,detail=EXCLUDED.detail,last_seen_at=now(),resolved_at=NULL,occurrences=business_transaction_trace_alerts.occurrences+1 RETURNING *`,[key,trace.trace_id,severity,type,title,detail])).rows[0];const last=previous?.last_notified_at?new Date(previous.last_notified_at).getTime():0;if(!last||Date.now()-last>=ALERT_COOLDOWN_MINUTES*60000){await notify({...row,root_type:trace.root_type,root_id:trace.root_id});await db.query(`UPDATE business_transaction_trace_alerts SET last_notified_at=now() WHERE alert_key=$1`,[key])}return key}

export async function runTraceWatchdog(limit=500){
 await ensureTransactionTraceForensicsSchema();const traces=(await db.query(`SELECT trace_id::text,root_type,root_id,location_id,lifecycle_status,integrity_status,last_sequence,last_hash,first_seen_at,last_seen_at FROM business_transaction_traces WHERE last_seen_at>=now()-interval '30 days' ORDER BY last_seen_at DESC LIMIT $1`,[Math.max(1,Math.min(2000,Number(limit||500)))])).rows;let checked=0,attention=0,critical=0;
 for(const trace of traces){checked++;try{const a=await assessTraceForensics(String(trace.trace_id),'trace-watchdog');const activeTypes=new Set<string>();for(const item of a.anomalies){activeTypes.add(item.code);await upsertAlert(trace,item.severity,item.code,item.title,item.detail);attention++;if(item.severity==='critical')critical++}await db.query(`UPDATE business_transaction_trace_alerts SET resolved_at=COALESCE(resolved_at,now()),last_seen_at=now() WHERE trace_id=$1::uuid AND resolved_at IS NULL AND NOT(alert_type=ANY($2::text[]))`,[trace.trace_id,Array.from(activeTypes).length?Array.from(activeTypes):['__none__']])}catch(error:any){console.error('[transaction-trace] watchdog trace failed',trace.trace_id,error?.message||error)}}
 return{checked,attention,critical,generated_at:new Date().toISOString()};
}

export function startTraceForensicWatchdog(){if(started||process.env.TRANSACTION_TRACE_DISABLED==='1'||process.env.NODE_ENV==='test')return;started=true;cron.schedule('*/10 * * * *',()=>{void runTraceWatchdog(800).catch(error=>console.error('[transaction-trace] watchdog failed',error))},{timezone:TZ});const timer=setTimeout(()=>{void runTraceWatchdog(500).catch(error=>console.error('[transaction-trace] initial watchdog failed',error))},135000);timer.unref?.();console.log('[transaction-trace] forensic watchdog scheduled every 10 minutes Europe/Budapest')}
