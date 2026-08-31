import { Router, Response } from "express";
import pool from "../db";
import type { AuthRequest } from "../middleware/auth";
import { requireManagement } from "../middleware/requireRoles";
import { actorId,average,clamp,parseHorizon,safeRows,tenantId,validateLocation } from "./virP20P22Shared";

const router=Router();
router.use(requireManagement);

type DailyPoint={day:string;revenue:number;bookings:number};
type ForecastPoint={day:string;revenue:number;bookings:number;lower:number;upper:number};

function linearFit(values:number[]){
  const n=values.length;if(!n)return {slope:0,intercept:0};
  const xMean=(n-1)/2,yMean=average(values);let num=0,den=0;
  for(let i=0;i<n;i++){num+=(i-xMean)*(values[i]-yMean);den+=(i-xMean)*(i-xMean);}
  const slope=den?num/den:0;return {slope,intercept:yMean-slope*xMean};
}
function weekdayMultipliers(points:DailyPoint[],selector:(p:DailyPoint)=>number){
  const global=Math.max(0.0001,average(points.map(selector))),sums=Array(7).fill(0),counts=Array(7).fill(0);
  points.forEach(p=>{const d=new Date(`${p.day}T12:00:00Z`).getUTCDay();sums[d]+=selector(p);counts[d]++;});
  return sums.map((s,i)=>clamp((counts[i]?s/counts[i]:global)/global,0.55,1.55));
}
function residualStd(values:number[],fit:{slope:number;intercept:number}){
  if(values.length<3)return 0;const residuals=values.map((v,i)=>v-(fit.intercept+fit.slope*i));const mean=average(residuals);return Math.sqrt(average(residuals.map(x=>(x-mean)**2)));
}
function nextDate(last:string,offset:number){const d=new Date(`${last}T12:00:00Z`);d.setUTCDate(d.getUTCDate()+offset);return d.toISOString().slice(0,10);}
function model(points:DailyPoint[],days:7|30|90){
  const revenue=points.map(x=>x.revenue),bookings=points.map(x=>x.bookings),rFit=linearFit(revenue),bFit=linearFit(bookings),rWeek=weekdayMultipliers(points,p=>p.revenue),bWeek=weekdayMultipliers(points,p=>p.bookings);
  const recentR=average(revenue.slice(-14)),prevR=average(revenue.slice(-28,-14)),recentB=average(bookings.slice(-14)),prevB=average(bookings.slice(-28,-14));
  const rMomentum=prevR>0?clamp(recentR/prevR,0.80,1.20):1,bMomentum=prevB>0?clamp(recentB/prevB,0.80,1.20):1;
  const rStd=residualStd(revenue,rFit),lastDay=points.at(-1)?.day||new Date().toISOString().slice(0,10),out:ForecastPoint[]=[];
  for(let step=1;step<=days;step++){
    const day=nextDate(lastDay,step),dow=new Date(`${day}T12:00:00Z`).getUTCDay(),decay=Math.exp(-step/45);
    const rBase=Math.max(0,rFit.intercept+rFit.slope*(revenue.length-1+step)),bBase=Math.max(0,bFit.intercept+bFit.slope*(bookings.length-1+step));
    const r=Math.max(0,rBase*rWeek[dow]*(1+(rMomentum-1)*decay)),b=Math.max(0,bBase*bWeek[dow]*(1+(bMomentum-1)*decay));
    const band=1.64*rStd*Math.sqrt(Math.max(1,step/7));out.push({day,revenue:Number(r.toFixed(2)),bookings:Number(b.toFixed(2)),lower:Number(Math.max(0,r-band).toFixed(2)),upper:Number((r+band).toFixed(2))});
  }
  return {points:out,rMomentum,bMomentum,rFit,bFit,rStd};
}
function backtest(points:DailyPoint[]){
  const holdout=Math.min(28,Math.max(7,Math.floor(points.length*0.2))),train=points.slice(0,-holdout),actual=points.slice(-holdout);
  if(train.length<28||actual.length<7)return {mae:0,mape_percent:100,holdout_days:0};
  const predicted=model(train,holdout as 7|30|90).points;let abs=0,ape=0,apeN=0;
  actual.forEach((a,i)=>{const p=predicted[i]?.revenue||0;abs+=Math.abs(a.revenue-p);if(a.revenue>1){ape+=Math.abs(a.revenue-p)/a.revenue;apeN++;}});
  return {mae:Number((abs/actual.length).toFixed(4)),mape_percent:Number(((apeN?ape/apeN:1)*100).toFixed(4)),holdout_days:actual.length};
}
async function loadSeries(tenant:string,location:string|null):Promise<DailyPoint[]>{
  const rows=await safeRows(`WITH days AS (SELECT generate_series(current_date-180,current_date-1,interval '1 day')::date day), agg AS (SELECT a.start_time::date day,COUNT(DISTINCT a.id)::int bookings,COALESCE(SUM(CASE WHEN a.status NOT IN ('cancelled','no_show') THEN COALESCE(aps.price,0) ELSE 0 END),0)::numeric revenue FROM appointments a LEFT JOIN appointment_services aps ON aps.appointment_id=a.id WHERE a.tenant_id::text=$1 AND ($2::uuid IS NULL OR a.location_id=$2::uuid) AND a.start_time>=current_date-180 AND a.start_time<current_date GROUP BY 1) SELECT d.day::text,COALESCE(a.bookings,0)::int bookings,COALESCE(a.revenue,0)::numeric revenue FROM days d LEFT JOIN agg a USING(day) ORDER BY d.day`,[tenant,location]);
  return rows.map(x=>({day:String(x.day).slice(0,10),revenue:Number(x.revenue||0),bookings:Number(x.bookings||0)}));
}
export async function buildP20Forecast(tenant:string,location:string|null,days:7|30|90){
  const series=await loadSeries(tenant,location),usable=series.slice(-Math.min(180,series.length)),bt=backtest(usable),m=model(usable,days),revenueForecast=m.points.reduce((s,x)=>s+x.revenue,0),bookingForecast=Math.round(m.points.reduce((s,x)=>s+x.bookings,0)),lower=m.points.reduce((s,x)=>s+x.lower,0),upper=m.points.reduce((s,x)=>s+x.upper,0);
  const historyScore=clamp(usable.length/120,0,1),accuracyScore=bt.holdout_days?clamp(1-bt.mape_percent/60,0,1):0.2,confidence=clamp(0.35+0.30*historyScore+0.35*accuracyScore,0.35,0.94);
  return {model:"ensemble_linear_weekday_momentum_v1",horizon_days:days,history_days:usable.length,confidence:Number(confidence.toFixed(4)),revenue_forecast:Number(revenueForecast.toFixed(2)),revenue_lower:Number(lower.toFixed(2)),revenue_upper:Number(upper.toFixed(2)),booking_forecast:bookingForecast,metrics:{mae:bt.mae,mape_percent:bt.mape_percent,holdout_days:bt.holdout_days,revenue_momentum:Number(m.rMomentum.toFixed(4)),booking_momentum:Number(m.bMomentum.toFixed(4)),revenue_daily_slope:Number(m.rFit.slope.toFixed(4)),booking_daily_slope:Number(m.bFit.slope.toFixed(4))},daily:m.points,limitations:["statistical forecast from internal historical data","confidence depends on history and holdout error","not a guarantee of future revenue","automatic external execution disabled"]};
}

router.get("/status",async(req:AuthRequest,res:Response)=>{const tenant=tenantId(req,res);if(!tenant)return;try{const counts=(await pool.query(`SELECT COUNT(*)::int runs,MAX(created_at) last_run_at,AVG(mape_percent)::numeric avg_mape FROM vir_p20_model_runs WHERE tenant_id=$1::bigint`,[tenant])).rows[0];return res.json({ok:true,model:"validated_predictive_ensemble_v1",supported_horizons:[7,30,90],backtesting:true,prediction_intervals:true,automatic_execution:false,counts});}catch(error:any){return res.status(500).json({ok:false,error:error?.message||"p20_status_failed"});}});
router.get("/forecast",async(req:AuthRequest,res:Response)=>{const tenant=tenantId(req,res);if(!tenant)return;const location=await validateLocation(req.query.locationId,tenant,res);if(location===undefined)return;try{return res.json({ok:true,forecast:await buildP20Forecast(tenant,location,parseHorizon(req.query.days))});}catch(error:any){return res.status(500).json({ok:false,error:error?.message||"p20_forecast_failed"});}});
router.post("/run",async(req:AuthRequest,res:Response)=>{const tenant=tenantId(req,res);if(!tenant)return;const location=await validateLocation(req.body?.locationId,tenant,res);if(location===undefined)return;try{const days=parseHorizon(req.body?.days),f=await buildP20Forecast(tenant,location,days),row=(await pool.query(`INSERT INTO vir_p20_model_runs(tenant_id,location_id,horizon_days,model_key,history_days,confidence,mae,mape_percent,revenue_forecast,revenue_lower,revenue_upper,booking_forecast,metrics,forecast,created_by) VALUES($1::bigint,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15) RETURNING *`,[tenant,location,days,f.model,f.history_days,f.confidence,f.metrics.mae,f.metrics.mape_percent,f.revenue_forecast,f.revenue_lower,f.revenue_upper,f.booking_forecast,JSON.stringify(f.metrics),JSON.stringify(f),actorId(req)])).rows[0];return res.status(201).json({ok:true,item:row,forecast:f});}catch(error:any){return res.status(500).json({ok:false,error:error?.message||"p20_run_failed"});}});
router.get("/runs",async(req:AuthRequest,res:Response)=>{const tenant=tenantId(req,res);if(!tenant)return;try{return res.json({ok:true,items:(await pool.query(`SELECT * FROM vir_p20_model_runs WHERE tenant_id=$1::bigint ORDER BY created_at DESC LIMIT 100`,[tenant])).rows});}catch(error:any){return res.status(500).json({ok:false,error:error?.message||"p20_runs_failed"});}});

export default router;
