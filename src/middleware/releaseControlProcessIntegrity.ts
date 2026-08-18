import type { NextFunction, Request, Response } from "express";
import db from "../db";
import { buildResilienceRecoveryReleaseGate } from "./releaseControlResilience";

type ReleaseGate = {
  key: string;
  group: string;
  label: string;
  status: "pass" | "fail";
  blocking: true;
  editable: false;
  message: string;
  evidence: string | null;
  source: string;
};

const TZ = "Europe/Budapest";
const GLOBAL_LOCATION_KEY = "__all__";

function previousControlDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now() - 86_400_000));
}

async function tableExists(table: string) {
  const { rows } = await db.query("SELECT to_regclass($1) IS NOT NULL ok", [`public.${table}`]);
  return Boolean(rows[0]?.ok);
}

export async function buildProcessIntegrityReleaseGate(): Promise<ReleaseGate> {
  const businessDate = previousControlDate();
  try {
    if (!(await tableExists("business_process_integrity_runs"))) {
      return {key:"business.process_integrity",group:"Üzleti integritás",label:"Előző üzleti nap teljes folyamatintegritása",status:"fail",blocking:true,editable:false,message:`NO-GO: a ${businessDate} naphoz a Business Process Integrity séma vagy futási bizonyíték nem érhető el.`,evidence:null,source:"business-process-integrity"};
    }
    const { rows } = await db.query(`SELECT business_date::text business_date,status,process_count,passed_count,warning_count,failed_count,exception_count,generated_at FROM business_process_integrity_runs WHERE business_date=$1::date AND location_key=$2 LIMIT 1`,[businessDate,GLOBAL_LOCATION_KEY]);
    const row = rows[0];
    if (!row) return {key:"business.process_integrity",group:"Üzleti integritás",label:"Előző üzleti nap teljes folyamatintegritása",status:"fail",blocking:true,editable:false,message:`NO-GO: a ${businessDate} üzleti napra nincs globális folyamatintegritási futás.`,evidence:null,source:"business-process-integrity"};
    const exceptionCount=Number(row.exception_count||0),passed=String(row.status||"").toLowerCase()==="ok"&&exceptionCount===0;
    const evidence=`business_date=${row.business_date}; status=${row.status}; processes=${Number(row.process_count||0)}; passed=${Number(row.passed_count||0)}; warnings=${Number(row.warning_count||0)}; failed=${Number(row.failed_count||0)}; exceptions=${exceptionCount}; generated_at=${new Date(row.generated_at).toISOString()}`;
    return {key:"business.process_integrity",group:"Üzleti integritás",label:"Előző üzleti nap teljes folyamatintegritása",status:passed?"pass":"fail",blocking:true,editable:false,message:passed?`PASS: a ${row.business_date} üzleti nap pénzügyi, készlet-, beszerzési és rendszerintegritási kontrollja eltérés nélkül zárt.`:`NO-GO: a ${row.business_date} üzleti nap folyamatintegritása ${row.status}; ${exceptionCount} kivétel, ${Number(row.failed_count||0)} kritikus és ${Number(row.warning_count||0)} figyelmeztetéses folyamat maradt.`,evidence,source:"business-process-integrity"};
  } catch (error:any) {
    return {key:"business.process_integrity",group:"Üzleti integritás",label:"Előző üzleti nap teljes folyamatintegritása",status:"fail",blocking:true,editable:false,message:`NO-GO: a folyamatintegritási release gate nem ellenőrizhető (${error?.message||"ismeretlen adatbázishiba"}).`,evidence:null,source:"business-process-integrity"};
  }
}

export async function buildTransactionTraceReleaseGate():Promise<ReleaseGate>{
  try{
    const traceTable=await tableExists("business_transaction_traces"),eventTable=await tableExists("business_transaction_events"),signatureTable=await tableExists("business_transaction_proof_signatures"),alertTable=await tableExists("business_transaction_trace_alerts");
    const hmacConfigured=Boolean(String(process.env.TRANSACTION_TRACE_HMAC_KEY||"").trim());
    if(!traceTable||!eventTable||!signatureTable||!alertTable)return{key:"business.transaction_trace",group:"Üzleti integritás",label:"Tranzakció-életút és bizonyítás",status:"fail",blocking:true,editable:false,message:"NO-GO: a Transaction Lifecycle & Traceability / Forensic Watchdog runtime séma hiányos.",evidence:`traces=${traceTable}; events=${eventTable}; signatures=${signatureTable}; alerts=${alertTable}`,source:"transaction-trace"};
    const broken=Number((await db.query(`SELECT COUNT(*)::int count FROM business_transaction_traces WHERE integrity_status='broken' AND last_seen_at>=now()-interval '30 days'`)).rows[0]?.count||0);
    const unsigned=Number((await db.query(`SELECT COUNT(*)::int count FROM business_transaction_traces t WHERE t.last_sequence>0 AND t.last_seen_at>=now()-interval '30 days' AND t.last_seen_at<now()-interval '20 minutes' AND NOT EXISTS(SELECT 1 FROM business_transaction_proof_signatures s WHERE s.trace_id=t.trace_id AND s.trace_sequence=t.last_sequence AND s.trace_hash=t.last_hash)`)).rows[0]?.count||0);
    const openCritical=Number((await db.query(`SELECT COUNT(*)::int count FROM business_transaction_trace_alerts WHERE resolved_at IS NULL AND severity='critical'`)).rows[0]?.count||0);
    const traces=Number((await db.query(`SELECT COUNT(*)::int count FROM business_transaction_traces WHERE last_seen_at>=now()-interval '30 days'`)).rows[0]?.count||0);
    const passed=hmacConfigured&&broken===0&&unsigned===0&&openCritical===0;
    return{key:"business.transaction_trace",group:"Üzleti integritás",label:"Tranzakció-életút és bizonyítás",status:passed?"pass":"fail",blocking:true,editable:false,message:passed?`PASS: append-only SHA-256 trace ledger, HMAC proof signing és forensic watchdog aktív; ${traces} aktív trace, nincs sérült, lejárt aláíratlan vagy kritikus watchdog eltérés.`:`NO-GO: transaction trace proof nem production-ready. HMAC=${hmacConfigured?"konfigurált":"HIÁNYZIK"}, sérült trace=${broken}, 20 percnél régebbi aláíratlan trace=${unsigned}, nyitott kritikus watchdog=${openCritical}.`,evidence:`hmac_configured=${hmacConfigured}; traces_30d=${traces}; broken_30d=${broken}; unsigned_stale_30d=${unsigned}; open_critical_watchdog=${openCritical}`,source:"transaction-trace"};
  }catch(error:any){return{key:"business.transaction_trace",group:"Üzleti integritás",label:"Tranzakció-életút és bizonyítás",status:"fail",blocking:true,editable:false,message:`NO-GO: a tranzakció-életút release gate nem ellenőrizhető (${error?.message||"ismeretlen adatbázishiba"}).`,evidence:null,source:"transaction-trace"}}
}

export async function buildExceptionManagementReleaseGate():Promise<ReleaseGate>{
  try{
    const casesTable=await tableExists("exception_cases"),eventsTable=await tableExists("exception_case_events"),rulesTable=await tableExists("exception_routing_rules");
    if(!casesTable||!eventsTable||!rulesTable)return{key:"business.exception_management",group:"Üzleti integritás",label:"Exception Command Center release readiness",status:"fail",blocking:true,editable:false,message:"NO-GO: az Exception Command Center runtime séma hiányos.",evidence:`cases=${casesTable}; events=${eventsTable}; rules=${rulesTable}`,source:"exception-command-center"};
    const blockingCategories=['finance','nav','inventory','cashier','trace','system','process'];
    const row=(await db.query(`SELECT
        COUNT(*) FILTER(WHERE severity='critical')::int critical,
        COUNT(*) FILTER(WHERE severity='high' AND sla_state='breached')::int high_breached,
        COUNT(*) FILTER(WHERE owner_key IS NULL)::int unassigned,
        COUNT(*)::int total
      FROM exception_cases
      WHERE status IN('open','acknowledged','in_progress','waiting','snoozed')
        AND category=ANY($1::text[])`,[blockingCategories])).rows[0]||{};
    const critical=Number(row.critical||0),highBreached=Number(row.high_breached||0),unassigned=Number(row.unassigned||0),total=Number(row.total||0);
    const passed=critical===0&&highBreached===0;
    return{key:"business.exception_management",group:"Üzleti integritás",label:"Exception Command Center release readiness",status:passed?"pass":"fail",blocking:true,editable:false,
      message:passed?`PASS: nincs release-kritikus nyitott Exception case. Figyelt aktív ügyek: ${total}; kiosztatlan: ${unassigned}.`:`NO-GO: ${critical} kritikus és ${highBreached} magas súlyosságú, SLA-sértett release-kritikus Exception case nyitott.`,
      evidence:`blocking_categories=${blockingCategories.join(',')}; active=${total}; critical=${critical}; high_sla_breached=${highBreached}; unassigned=${unassigned}`,source:"exception-command-center"};
  }catch(error:any){return{key:"business.exception_management",group:"Üzleti integritás",label:"Exception Command Center release readiness",status:"fail",blocking:true,editable:false,message:`NO-GO: az Exception Command Center release gate nem ellenőrizhető (${error?.message||"ismeretlen adatbázishiba"}).`,evidence:null,source:"exception-command-center"}}
}

export async function buildMajorIncidentReleaseGate():Promise<ReleaseGate>{
  try{
    const incidentTable=await tableExists("major_incidents"),actionTable=await tableExists("major_incident_actions"),eventTable=await tableExists("major_incident_events");
    if(!incidentTable||!actionTable||!eventTable)return{key:"business.major_incident",group:"Üzleti integritás",label:"Major Incident / War Room release readiness",status:"fail",blocking:true,editable:false,message:"NO-GO: a Major Incident / War Room runtime séma hiányos.",evidence:`incidents=${incidentTable}; actions=${actionTable}; events=${eventTable}`,source:"major-incident-war-room"};
    const row=(await db.query(`SELECT
        COUNT(*) FILTER(WHERE severity='sev1' AND status NOT IN('postmortem_closed','dismissed'))::int sev1_open,
        COUNT(*) FILTER(WHERE severity='sev2' AND status IN('open','mitigating','monitoring'))::int sev2_active,
        COUNT(*) FILTER(WHERE severity IN('sev1','sev2') AND status IN('open','mitigating') AND incident_commander_key IS NULL)::int commander_missing
      FROM major_incidents`)).rows[0]||{};
    const actionRow=(await db.query(`SELECT COUNT(*)::int overdue_critical_actions FROM major_incident_actions a JOIN major_incidents mi ON mi.id=a.incident_id
      WHERE mi.severity IN('sev1','sev2') AND mi.status NOT IN('postmortem_closed','dismissed')
        AND a.status IN('open','in_progress') AND a.priority IN('critical','high') AND a.due_at<now()`)).rows[0]||{};
    const sev1=Number(row.sev1_open||0),sev2=Number(row.sev2_active||0),commanderMissing=Number(row.commander_missing||0),overdueActions=Number(actionRow.overdue_critical_actions||0);
    const passed=sev1===0&&sev2===0&&overdueActions===0;
    return{key:"business.major_incident",group:"Üzleti integritás",label:"Major Incident / War Room release readiness",status:passed?"pass":"fail",blocking:true,editable:false,
      message:passed?"PASS: nincs release-blokkoló SEV1/SEV2 Major Incident vagy lejárt kritikus War Room akció.":`NO-GO: SEV1 governance-open=${sev1}, operatív SEV2=${sev2}, lejárt critical/high War Room akció=${overdueActions}, commander nélkül=${commanderMissing}.`,
      evidence:`sev1_until_postmortem_closed=${sev1}; sev2_operational_active=${sev2}; overdue_critical_high_actions=${overdueActions}; commander_missing=${commanderMissing}`,source:"major-incident-war-room"};
  }catch(error:any){return{key:"business.major_incident",group:"Üzleti integritás",label:"Major Incident / War Room release readiness",status:"fail",blocking:true,editable:false,message:`NO-GO: a Major Incident release gate nem ellenőrizhető (${error?.message||"ismeretlen adatbázishiba"}).`,evidence:null,source:"major-incident-war-room"}}
}

function recomputeReleaseDecision(body:any,newGates:ReleaseGate[]){
  if(!body||!Array.isArray(body.gates))return body;
  const keys=new Set(newGates.map(g=>g.key));const gates=[...body.gates.filter((item:any)=>!keys.has(item?.key)),...newGates];
  const blocking=gates.filter((item:any)=>Boolean(item?.blocking)),blockers=blocking.filter((item:any)=>item?.status!=="pass");
  const summary={total:gates.length,pass:gates.filter((x:any)=>x?.status==="pass").length,warning:gates.filter((x:any)=>x?.status==="warning").length,fail:gates.filter((x:any)=>x?.status==="fail").length,pending:gates.filter((x:any)=>x?.status==="pending").length,blocking_total:blocking.length,blocking_open:blockers.length};
  return{...body,release_ready:blockers.length===0,decision:blockers.length===0?"GO":"NO-GO",summary,blockers:blockers.map((x:any)=>({key:x.key,label:x.label,status:x.status,message:x.message})),gates,meta:{...(body.meta||{}),process_integrity_gate:newGates.find(x=>x.key==="business.process_integrity")?.status||null,transaction_trace_gate:newGates.find(x=>x.key==="business.transaction_trace")?.status||null,exception_management_gate:newGates.find(x=>x.key==="business.exception_management")?.status||null,major_incident_gate:newGates.find(x=>x.key==="business.major_incident")?.status||null,resilience_recovery_gate:newGates.find(x=>x.key==="business.resilience_recovery")?.status||null}};
}

export async function enforceProcessIntegrityReleaseGate(req:Request,res:Response,next:NextFunction){
  if(req.method!=="GET"||(req.path!=="/"&&req.path!==""))return next();
  const gates=await Promise.all([buildProcessIntegrityReleaseGate(),buildTransactionTraceReleaseGate(),buildExceptionManagementReleaseGate(),buildMajorIncidentReleaseGate(),buildResilienceRecoveryReleaseGate()]);
  const originalJson=res.json.bind(res);res.json=((body:any)=>originalJson(recomputeReleaseDecision(body,gates))) as typeof res.json;next();
}
