import { Router } from "express";
import db from "../db";
import { AuthRequest } from "../middleware/auth";
import {
  ensureBusinessReconciliationSchema,
  runFinancialReconciliation,
  runStockReconciliation,
} from "../services/businessReconciliation";
import { ensureBusinessProcessIntegritySchema, runBusinessProcessIntegrity } from "../services/businessProcessIntegrity";
import { ensureTransactionTraceabilitySchema } from "../services/transactionTraceability";
import { backfillTraces, recentTraces, searchTraces, startTraceMaintenance, traceDetail } from "../services/transactionTraceRuntime";
import { ensureTransactionTraceSigningSchema, signTraceProof, startTraceProofSigningMaintenance, verifyTraceProofSignature } from "../services/transactionTraceSigning";
import { assessTraceForensics, buildProofPackage, buildTraceGraph, ensureTransactionTraceForensicsSchema, runTraceWatchdog, startTraceForensicWatchdog, traceHealthSummary } from "../services/transactionTraceForensics";
import { startBusinessReconciliationSchedulerV2 } from "../services/businessReconciliationScheduler";
import { ensureBusinessControlAlertDeliverySchema } from "../services/businessControlAlertDelivery";
import { ensureBusinessControlMenu } from "../services/businessControlMenu";
import { ensureExecutiveAiMenu } from "../services/executiveAiMenu";

const router=Router();
startBusinessReconciliationSchedulerV2();
startTraceMaintenance();
startTraceProofSigningMaintenance();
startTraceForensicWatchdog();

async function ensureCriticalMenus(){
  const results=await Promise.allSettled([ensureBusinessControlMenu(),ensureExecutiveAiMenu()]);
  for(const result of results){
    if(result.status==="rejected")console.warn("[menu-bootstrap] critical menu registration retry failed:",result.reason?.message||result.reason);
  }
}
for(const delay of [0,5_000,20_000,60_000]){
  const timer=setTimeout(()=>{void ensureCriticalMenus()},delay);
  timer.unref?.();
}

const validDate=(v:string)=>/^\d{4}-\d{2}-\d{2}$/.test(v);
const dateParam=(v:unknown)=>{const s=String(v||new Date().toISOString().slice(0,10));if(!validDate(s))throw Object.assign(new Error("A dátum formátuma YYYY-MM-DD legyen."),{status:400});return s};
const loc=(req:AuthRequest,source:any)=>String(source?.location_id||req.user?.location_id||"").trim()||null;
const actor=(req:AuthRequest)=>String(req.user?.email||req.user?.id||"management-user");

router.use(async(_req,_res,next)=>{try{await Promise.all([ensureBusinessReconciliationSchema(),ensureBusinessProcessIntegritySchema(),ensureTransactionTraceabilitySchema(),ensureTransactionTraceSigningSchema(),ensureTransactionTraceForensicsSchema(),ensureBusinessControlAlertDeliverySchema(),ensureBusinessControlMenu(),ensureExecutiveAiMenu()]);next()}catch(error){next(error)}});

router.get("/finance",async(req:AuthRequest,res,next)=>{
  try{const date=dateParam(req.query.date);res.json(await runFinancialReconciliation(date,loc(req,req.query),{persist:false,notify:false}))}catch(error:any){if(error?.status)return res.status(error.status).json({message:error.message});next(error)}
});
router.get("/stock",async(req:AuthRequest,res,next)=>{
  try{const date=dateParam(req.query.date);res.json(await runStockReconciliation(date,loc(req,req.query),{persist:false,notify:false}))}catch(error:any){if(error?.status)return res.status(error.status).json({message:error.message});next(error)}
});
router.get("/process-integrity",async(req:AuthRequest,res,next)=>{
  try{const date=dateParam(req.query.date);res.json(await runBusinessProcessIntegrity(date,loc(req,req.query),{persist:false}))}catch(error:any){if(error?.status)return res.status(error.status).json({message:error.message});next(error)}
});

router.get("/trace/health",async(req:AuthRequest,res,next)=>{
  try{res.json(await traceHealthSummary(Number(req.query.days||30),loc(req,req.query)))}catch(error){next(error)}
});
router.post("/trace/watchdog",async(_req:AuthRequest,res,next)=>{
  try{res.json(await runTraceWatchdog(1000))}catch(error){next(error)}
});
router.get("/trace/recent",async(req:AuthRequest,res,next)=>{
  try{res.json({items:await recentTraces(Number(req.query.limit||60),loc(req,req.query))})}catch(error){next(error)}
});
router.get("/trace/search",async(req:AuthRequest,res,next)=>{
  try{res.json({items:await searchTraces(String(req.query.q||""),Number(req.query.limit||40))})}catch(error){next(error)}
});
router.post("/trace/backfill",async(req:AuthRequest,res,next)=>{
  try{res.json(await backfillTraces(Number(req.body?.days||30),Number(req.body?.limit||500)))}catch(error){next(error)}
});
router.get("/trace/:root_type/:root_id/forensics",async(req:AuthRequest,res,next)=>{
  try{const data=await traceDetail(String(req.params.root_type),String(req.params.root_id),actor(req));res.json(await assessTraceForensics(String(data.trace.trace_id),actor(req)))}catch(error:any){if(error?.status)return res.status(error.status).json({message:error.message});next(error)}
});
router.get("/trace/:root_type/:root_id/graph",async(req:AuthRequest,res,next)=>{
  try{const data=await traceDetail(String(req.params.root_type),String(req.params.root_id),actor(req));res.json(await buildTraceGraph(String(data.trace.trace_id)))}catch(error:any){if(error?.status)return res.status(error.status).json({message:error.message});next(error)}
});
router.get("/trace/:root_type/:root_id/proof-package",async(req:AuthRequest,res,next)=>{
  try{const rootType=String(req.params.root_type),rootId=String(req.params.root_id);await traceDetail(rootType,rootId,actor(req));const data=await buildProofPackage(rootType,rootId,actor(req));res.setHeader("Content-Type","application/json; charset=utf-8");res.setHeader("Content-Disposition",`attachment; filename="kleo-trace-${rootType}-${rootId.replace(/[^A-Za-z0-9._-]/g,'_')}.json"`);res.json(data)}catch(error:any){if(error?.status)return res.status(error.status).json({message:error.message});next(error)}
});
router.get("/trace/:root_type/:root_id",async(req:AuthRequest,res,next)=>{
  try{const data=await traceDetail(String(req.params.root_type),String(req.params.root_id),actor(req));const signature=await signTraceProof(String(data.trace.trace_id),actor(req));const forensics=await assessTraceForensics(String(data.trace.trace_id),actor(req));res.json({...data,signature,forensics})}catch(error:any){if(error?.status)return res.status(error.status).json({message:error.message});next(error)}
});
router.post("/trace/:root_type/:root_id/verify",async(req:AuthRequest,res,next)=>{
  try{const data=await traceDetail(String(req.params.root_type),String(req.params.root_id),actor(req));const signature=await signTraceProof(String(data.trace.trace_id),actor(req));const forensics=await assessTraceForensics(String(data.trace.trace_id),actor(req));res.json({trace:data.trace,proof:data.proof,signature,forensics,stages:data.stages,verified_at:new Date().toISOString()})}catch(error:any){if(error?.status)return res.status(error.status).json({message:error.message});next(error)}
});
router.get("/trace/:root_type/:root_id/signature",async(req:AuthRequest,res,next)=>{
  try{const data=await traceDetail(String(req.params.root_type),String(req.params.root_id),actor(req));res.json(await verifyTraceProofSignature(String(data.trace.trace_id)))}catch(error:any){if(error?.status)return res.status(error.status).json({message:error.message});next(error)}
});

router.post("/run",async(req:AuthRequest,res,next)=>{
  try{
    const date=dateParam(req.body?.date),locationId=loc(req,req.body),scope=String(req.body?.scope||"all");
    if(!["finance","stock","process","all"].includes(scope))return res.status(400).json({message:"Érvénytelen reconciliation scope."});
    const out:any={business_date:date,location_id:locationId};
    if(scope==="finance"||scope==="all")out.finance=await runFinancialReconciliation(date,locationId,{persist:true,notify:true});
    if(scope==="stock"||scope==="all")out.stock=await runStockReconciliation(date,locationId,{persist:true,notify:true});
    if(scope==="process"||scope==="all")out.process_integrity=await runBusinessProcessIntegrity(date,locationId,{persist:true});
    res.json(out);
  }catch(error:any){if(error?.status)return res.status(error.status).json({message:error.message});next(error)}
});
router.get("/history",async(req:AuthRequest,res,next)=>{
  try{
    const days=Math.max(1,Math.min(90,Number(req.query.days||30))),locationId=loc(req,req.query),key=locationId||"__all__";
    const [finance,stock,processIntegrity,alerts]=await Promise.all([
      db.query(`SELECT * FROM financial_reconciliation_runs WHERE location_key=$1 AND business_date>=CURRENT_DATE-$2::int ORDER BY business_date DESC LIMIT 90`,[key,days]),
      db.query(`SELECT * FROM stock_reconciliation_runs WHERE location_key=$1 AND business_date>=CURRENT_DATE-$2::int ORDER BY business_date DESC LIMIT 90`,[key,days]),
      db.query(`SELECT * FROM business_process_integrity_runs WHERE location_key=$1 AND business_date>=CURRENT_DATE-$2::int ORDER BY business_date DESC LIMIT 90`,[key,days]),
      db.query(`SELECT * FROM reconciliation_alert_events WHERE location_key=$1 ORDER BY (resolved_at IS NULL) DESC,last_seen_at DESC LIMIT 100`,[key]),
    ]);
    res.json({finance:finance.rows,stock:stock.rows,process_integrity:processIntegrity.rows,alerts:alerts.rows});
  }catch(error){next(error)}
});
router.get("/process-integrity/exceptions",async(req:AuthRequest,res,next)=>{
  try{
    const date=dateParam(req.query.date),locationId=loc(req,req.query),key=locationId||"__all__";
    const {rows}=await db.query(`SELECT e.* FROM business_process_integrity_exceptions e JOIN business_process_integrity_runs r ON r.id=e.run_id WHERE r.business_date=$1::date AND r.location_key=$2 ORDER BY CASE e.severity WHEN 'critical' THEN 0 ELSE 1 END,e.process_key,e.id`,[date,key]);
    res.json({business_date:date,location_id:locationId,items:rows});
  }catch(error){next(error)}
});
router.get("/alerts/deliveries",async(req:AuthRequest,res,next)=>{
  try{
    const limit=Math.max(1,Math.min(200,Number(req.query.limit||50)));
    const {rows}=await db.query(`SELECT * FROM business_control_alert_deliveries ORDER BY created_at DESC LIMIT $1`,[limit]);
    res.json({items:rows});
  }catch(error){next(error)}
});

export default router;
