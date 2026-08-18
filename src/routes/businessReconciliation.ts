import { Router } from "express";
import db from "../db";
import { AuthRequest } from "../middleware/auth";
import {
  ensureBusinessReconciliationSchema,
  runFinancialReconciliation,
  runStockReconciliation,
} from "../services/businessReconciliation";
import { startBusinessReconciliationSchedulerV2 } from "../services/businessReconciliationScheduler";
import { ensureBusinessControlAlertDeliverySchema } from "../services/businessControlAlertDelivery";
import { ensureBusinessControlMenu } from "../services/businessControlMenu";
import { ensureExecutiveAiMenu } from "../services/executiveAiMenu";

const router=Router();
startBusinessReconciliationSchedulerV2();

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

router.use(async(_req,_res,next)=>{try{await Promise.all([ensureBusinessReconciliationSchema(),ensureBusinessControlAlertDeliverySchema(),ensureBusinessControlMenu(),ensureExecutiveAiMenu()]);next()}catch(error){next(error)}});

router.get("/finance",async(req:AuthRequest,res,next)=>{
  try{const date=dateParam(req.query.date);res.json(await runFinancialReconciliation(date,loc(req,req.query),{persist:false,notify:false}))}catch(error:any){if(error?.status)return res.status(error.status).json({message:error.message});next(error)}
});
router.get("/stock",async(req:AuthRequest,res,next)=>{
  try{const date=dateParam(req.query.date);res.json(await runStockReconciliation(date,loc(req,req.query),{persist:false,notify:false}))}catch(error:any){if(error?.status)return res.status(error.status).json({message:error.message});next(error)}
});
router.post("/run",async(req:AuthRequest,res,next)=>{
  try{
    const date=dateParam(req.body?.date),locationId=loc(req,req.body),scope=String(req.body?.scope||"all");
    if(!["finance","stock","all"].includes(scope))return res.status(400).json({message:"Érvénytelen reconciliation scope."});
    const out:any={business_date:date,location_id:locationId};
    if(scope==="finance"||scope==="all")out.finance=await runFinancialReconciliation(date,locationId,{persist:true,notify:true});
    if(scope==="stock"||scope==="all")out.stock=await runStockReconciliation(date,locationId,{persist:true,notify:true});
    res.json(out);
  }catch(error:any){if(error?.status)return res.status(error.status).json({message:error.message});next(error)}
});
router.get("/history",async(req:AuthRequest,res,next)=>{
  try{
    const days=Math.max(1,Math.min(90,Number(req.query.days||30))),locationId=loc(req,req.query),key=locationId||"__all__";
    const [finance,stock,alerts]=await Promise.all([
      db.query(`SELECT * FROM financial_reconciliation_runs WHERE location_key=$1 AND business_date>=CURRENT_DATE-$2::int ORDER BY business_date DESC LIMIT 90`,[key,days]),
      db.query(`SELECT * FROM stock_reconciliation_runs WHERE location_key=$1 AND business_date>=CURRENT_DATE-$2::int ORDER BY business_date DESC LIMIT 90`,[key,days]),
      db.query(`SELECT * FROM reconciliation_alert_events WHERE location_key=$1 ORDER BY (resolved_at IS NULL) DESC,last_seen_at DESC LIMIT 100`,[key]),
    ]);
    res.json({finance:finance.rows,stock:stock.rows,alerts:alerts.rows});
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
