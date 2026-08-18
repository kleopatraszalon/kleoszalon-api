import cron from "node-cron";
import db from "../db";
import { runFinancialReconciliation, runStockReconciliation } from "./businessReconciliation";
import { runBusinessProcessIntegrity } from "./businessProcessIntegrity";

const TZ="Europe/Budapest";
let started=false;
const previousBusinessDate=()=>new Intl.DateTimeFormat("en-CA",{timeZone:TZ,year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(Date.now()-86_400_000));

async function locationIds(){
  try{return (await db.query(`SELECT id::text id FROM locations ORDER BY id`)).rows.map((x:any)=>String(x.id))}catch{return [] as string[]}
}

export async function runScheduledBusinessReconciliation(date=previousBusinessDate()){
  const summary:any={date,global:{},locations:[]};
  summary.global.finance=await runFinancialReconciliation(date,null,{persist:true,notify:true});
  summary.global.stock=await runStockReconciliation(date,null,{persist:true,notify:true});
  summary.global.process_integrity=await runBusinessProcessIntegrity(date,null,{persist:true});
  for(const locationId of await locationIds()){
    const row:any={location_id:locationId};
    try{row.finance=await runFinancialReconciliation(date,locationId,{persist:true,notify:false})}catch(error:any){row.finance_error=error?.message||String(error)}
    try{row.stock=await runStockReconciliation(date,locationId,{persist:true,notify:false})}catch(error:any){row.stock_error=error?.message||String(error)}
    try{row.process_integrity=await runBusinessProcessIntegrity(date,locationId,{persist:true})}catch(error:any){row.process_integrity_error=error?.message||String(error)}
    summary.locations.push(row);
  }
  return summary;
}

export function startBusinessReconciliationSchedulerV2(){
  if(started||process.env.RECONCILIATION_DISABLED==="1"||process.env.NODE_ENV==="test")return;
  started=true;
  cron.schedule("20 2 * * *",()=>{void runScheduledBusinessReconciliation().catch(error=>console.error("[reconciliation] scheduled run failed",error));},{timezone:TZ});
  const timer=setTimeout(()=>{void runScheduledBusinessReconciliation().catch(error=>console.error("[reconciliation] initial run failed",error));},45_000);
  timer.unref?.();
  console.log("[reconciliation] daily finance + stock + end-to-end process integrity control scheduled 02:20 Europe/Budapest");
}
