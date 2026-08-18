import { Router } from "express";
import db from "../db";
import type { AuthRequest } from "../middleware/auth";
import { hasAnyRole } from "../security/roles";
import { askExecutiveAssistant, currentBudapestDate, ensureExecutiveAiSchema, runExecutiveBrief, startExecutiveAiScheduler } from "../services/executiveAiAssistant";
import { ensureExecutiveAiMenu } from "../services/executiveAiMenu";

const router=Router();
startExecutiveAiScheduler();
void ensureExecutiveAiMenu();
const validDate=(v:string)=>/^\d{4}-\d{2}-\d{2}$/.test(v);
const dateParam=(v:unknown)=>{const s=String(v||currentBudapestDate());if(!validDate(s))throw Object.assign(new Error("A dátum formátuma YYYY-MM-DD legyen."),{status:400});return s};
function location(req:AuthRequest,source:any){
  const own=String(req.user?.location_id||"").trim()||null;
  if(hasAnyRole(req.user?.role,["admin","manager"]))return String(source?.location_id||own||"").trim()||null;
  return own;
}

router.use(async(_req,_res,next)=>{try{await Promise.all([ensureExecutiveAiSchema(),ensureExecutiveAiMenu()]);next()}catch(error){next(error)}});

router.get("/brief",async(req:AuthRequest,res,next)=>{
  try{
    const date=dateParam(req.query.date),locationId=location(req,req.query),runType=String(req.query.run_type||"").trim();
    const key=locationId||"__all__";
    const existing=(await db.query(`SELECT business_date::text,location_key,run_type,status,ai_used,narrative,signals,recommendations,generated_at
      FROM executive_ai_briefs WHERE business_date=$1 AND location_key=$2 ${runType?"AND run_type=$3":""} ORDER BY generated_at DESC LIMIT 1`,runType?[date,key,runType]:[date,key])).rows[0];
    if(existing)return res.json({...existing,location_id:locationId});
    return res.json(await runExecutiveBrief(date,locationId,{runType:"live",persist:false,notify:false,useAi:false}));
  }catch(error:any){if(error?.status)return res.status(error.status).json({message:error.message});next(error)}
});

router.post("/run",async(req:AuthRequest,res,next)=>{
  try{
    const date=dateParam(req.body?.date),locationId=location(req,req.body),runType=String(req.body?.run_type||"manual").trim().slice(0,40)||"manual";
    res.json(await runExecutiveBrief(date,locationId,{runType,persist:true,notify:true,useAi:req.body?.use_ai!==false}));
  }catch(error:any){if(error?.status)return res.status(error.status).json({message:error.message});next(error)}
});

router.post("/ask",async(req:AuthRequest,res,next)=>{
  try{res.json(await askExecutiveAssistant(String(req.body?.question||""),dateParam(req.body?.date),location(req,req.body)))}
  catch(error:any){if(error?.status)return res.status(error.status).json({message:error.message});next(error)}
});

router.get("/history",async(req:AuthRequest,res,next)=>{
  try{
    const locationId=location(req,req.query),key=locationId||"__all__",days=Math.max(1,Math.min(90,Number(req.query.days||30)));
    const [briefs,alerts,deliveries]=await Promise.all([
      db.query(`SELECT id,business_date::text,location_key,run_type,status,ai_used,narrative,recommendations,generated_at FROM executive_ai_briefs WHERE location_key=$1 AND business_date>=CURRENT_DATE-$2::int ORDER BY generated_at DESC LIMIT 120`,[key,days]),
      db.query(`SELECT * FROM executive_ai_alert_events WHERE location_key=$1 ORDER BY (resolved_at IS NULL) DESC,last_seen_at DESC LIMIT 100`,[key]),
      db.query(`SELECT * FROM executive_ai_alert_deliveries ORDER BY created_at DESC LIMIT 50`),
    ]);
    res.json({briefs:briefs.rows,alerts:alerts.rows,deliveries:deliveries.rows});
  }catch(error){next(error)}
});

router.get("/automation",async(_req,res)=>res.json({enabled:process.env.EXECUTIVE_AI_DISABLED!=="1",timezone:"Europe/Budapest",runs:["08:10","13:10","20:10"],mode:"analyst_only",autonomous_actions:false,openai_configured:Boolean(process.env.OPENAI_API_KEY),monthly_ai_budget_usd:Number(process.env.EXECUTIVE_AI_MONTHLY_BUDGET_USD||5)}));

export default router;
