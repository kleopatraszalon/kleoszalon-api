import cron from "node-cron";
import db from "../db";
import { ensureExceptionCommandCenterSchema } from "./exceptionCommandCenter";

const TZ="Europe/Budapest";
let started=false;

async function tableExists(table:string){
  try{return Boolean((await db.query("SELECT to_regclass($1) IS NOT NULL ok",[`public.${table}`])).rows[0]?.ok)}catch{return false}
}
async function closeCase(id:string,fromStatus:string,message:string,evidence:any){
  const updated=(await db.query(`UPDATE exception_cases SET status='resolved',sla_state='closed',resolved_at=now(),
      resolution_note=$2,resolution_evidence=$3::jsonb,updated_at=now()
    WHERE id=$1::uuid AND status IN('open','acknowledged','in_progress','waiting','snoozed') RETURNING id`,[id,message,JSON.stringify(evidence||{})])).rows[0];
  if(updated)await db.query(`INSERT INTO exception_case_events(case_id,event_type,actor_key,from_status,to_status,message,evidence)
      VALUES($1::uuid,'consistency_resolved','system-consistency',$2,'resolved',$3,$4::jsonb)`,[id,fromStatus,message,JSON.stringify(evidence||{})]);
  return Boolean(updated);
}

export async function reconcileExceptionCommandCenterConsistency(){
  await ensureExceptionCommandCenterSchema();
  let navResolved=0;
  if(await tableExists('nav_invoice_queue')){
    const rows=(await db.query(`SELECT c.id::text,c.status,c.source_key,
      latest.status latest_status,latest.event_at
      FROM exception_cases c
      LEFT JOIN LATERAL(
        SELECT lower(COALESCE(q.status,'')) status,
          COALESCE(NULLIF(to_jsonb(q)->>'updated_at','')::timestamptz,NULLIF(to_jsonb(q)->>'created_at','')::timestamptz,now()) event_at
        FROM nav_invoice_queue q WHERE q.invoice_id::text=c.source_key
        ORDER BY COALESCE(NULLIF(to_jsonb(q)->>'updated_at','')::timestamptz,NULLIF(to_jsonb(q)->>'created_at','')::timestamptz,now()) DESC LIMIT 1
      ) latest ON true
      WHERE c.source_type='nav' AND c.status IN('open','acknowledged','in_progress','waiting','snoozed')`)).rows;
    for(const row of rows){
      const status=String(row.latest_status||'');
      if(status&&!["error","failed","rejected"].includes(status)){
        if(await closeCase(String(row.id),String(row.status),`A NAV számla legutolsó állapota már ${status}; a korábbi hibajelzés nem aktuális.`,{source:'nav-latest-status',latest_status:status,event_at:row.event_at}))navResolved++;
      }
    }
  }
  return{ok:true,nav_resolved:navResolved,reconciled_at:new Date().toISOString()};
}

export function startExceptionCommandCenterConsistencyScheduler(){
  if(started||process.env.EXCEPTION_CENTER_DISABLED==='1'||process.env.NODE_ENV==='test')return;started=true;
  cron.schedule('2-59/5 * * * *',()=>{void reconcileExceptionCommandCenterConsistency().catch(error=>console.error('[exception-center] consistency reconciliation failed',error))},{timezone:TZ});
  const timer=setTimeout(()=>{void reconcileExceptionCommandCenterConsistency().catch(error=>console.error('[exception-center] initial consistency reconciliation failed',error))},70_000);timer.unref?.();
  console.log('[exception-center] consistency reconciler scheduled every 5 minutes Europe/Budapest');
}
