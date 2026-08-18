import type { NextFunction, Request, Response } from "express";
import db from "../db";

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
    const traceTable=await tableExists("business_transaction_traces"),eventTable=await tableExists("business_transaction_events"),signatureTable=await tableExists("business_transaction_proof_signatures");
    const hmacConfigured=Boolean(String(process.env.TRANSACTION_TRACE_HMAC_KEY||"").trim());
    if(!traceTable||!eventTable||!signatureTable)return{key:"business.transaction_trace",group:"Üzleti integritás",label:"Tranzakció-életút és bizonyítás",status:"fail",blocking:true,editable:false,message:"NO-GO: a Transaction Lifecycle & Traceability runtime séma hiányos.",evidence:`traces=${traceTable}; events=${eventTable}; signatures=${signatureTable}`,source:"transaction-trace"};
    const broken=Number((await db.query(`SELECT COUNT(*)::int count FROM business_transaction_traces WHERE integrity_status='broken' AND last_seen_at>=now()-interval '30 days'`)).rows[0]?.count||0);
    const unsigned=Number((await db.query(`SELECT COUNT(*)::int count FROM business_transaction_traces t WHERE t.last_sequence>0 AND t.last_seen_at>=now()-interval '30 days' AND t.last_seen_at<now()-interval '20 minutes' AND NOT EXISTS(SELECT 1 FROM business_transaction_proof_signatures s WHERE s.trace_id=t.trace_id AND s.trace_sequence=t.last_sequence AND s.trace_hash=t.last_hash)`)).rows[0]?.count||0);
    const traces=Number((await db.query(`SELECT COUNT(*)::int count FROM business_transaction_traces WHERE last_seen_at>=now()-interval '30 days'`)).rows[0]?.count||0);
    const passed=hmacConfigured&&broken===0&&unsigned===0;
    return{key:"business.transaction_trace",group:"Üzleti integritás",label:"Tranzakció-életút és bizonyítás",status:passed?"pass":"fail",blocking:true,editable:false,message:passed?`PASS: append-only SHA-256 trace ledger aktív, HMAC proof signing konfigurált; ${traces} aktív trace, nincs sérült vagy lejárt aláíratlan bizonyítás.`:`NO-GO: transaction trace proof nem production-ready. HMAC=${hmacConfigured?"konfigurált":"HIÁNYZIK"}, sérült trace=${broken}, 20 percnél régebbi aláíratlan trace=${unsigned}.`,evidence:`hmac_configured=${hmacConfigured}; traces_30d=${traces}; broken_30d=${broken}; unsigned_stale_30d=${unsigned}`,source:"transaction-trace"};
  }catch(error:any){return{key:"business.transaction_trace",group:"Üzleti integritás",label:"Tranzakció-életút és bizonyítás",status:"fail",blocking:true,editable:false,message:`NO-GO: a tranzakció-életút release gate nem ellenőrizhető (${error?.message||"ismeretlen adatbázishiba"}).`,evidence:null,source:"transaction-trace"}}
}

function recomputeReleaseDecision(body:any,newGates:ReleaseGate[]){
  if(!body||!Array.isArray(body.gates))return body;
  const keys=new Set(newGates.map(g=>g.key));const gates=[...body.gates.filter((item:any)=>!keys.has(item?.key)),...newGates];
  const blocking=gates.filter((item:any)=>Boolean(item?.blocking)),blockers=blocking.filter((item:any)=>item?.status!=="pass");
  const summary={total:gates.length,pass:gates.filter((x:any)=>x?.status==="pass").length,warning:gates.filter((x:any)=>x?.status==="warning").length,fail:gates.filter((x:any)=>x?.status==="fail").length,pending:gates.filter((x:any)=>x?.status==="pending").length,blocking_total:blocking.length,blocking_open:blockers.length};
  return{...body,release_ready:blockers.length===0,decision:blockers.length===0?"GO":"NO-GO",summary,blockers:blockers.map((x:any)=>({key:x.key,label:x.label,status:x.status,message:x.message})),gates,meta:{...(body.meta||{}),process_integrity_gate:newGates.find(x=>x.key==="business.process_integrity")?.status||null,transaction_trace_gate:newGates.find(x=>x.key==="business.transaction_trace")?.status||null}};
}

export async function enforceProcessIntegrityReleaseGate(req:Request,res:Response,next:NextFunction){
  if(req.method!=="GET"||(req.path!=="/"&&req.path!==""))return next();
  const gates=await Promise.all([buildProcessIntegrityReleaseGate(),buildTransactionTraceReleaseGate()]);
  const originalJson=res.json.bind(res);res.json=((body:any)=>originalJson(recomputeReleaseDecision(body,gates))) as typeof res.json;next();
}
