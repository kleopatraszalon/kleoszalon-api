import cron from "node-cron";
import db from "../db";
import {ensureOperationalRiskControlSchema} from "./operationalRiskControlRegister";

const TZ="Europe/Budapest";
let started=false;

/**
 * Resolve source links even when a complete source class has zero current candidates.
 * The main source sync is optimized for active candidates; this reconciler is the
 * fail-safe negative-set pass for all supported automatic source types.
 */
export async function reconcileStaleOperationalRiskSources(){
 await ensureOperationalRiskControlSchema();
 const counts:Record<string,number>={};
 const run=async(type:string,sql:string)=>{
  const r=await db.query(sql);
  counts[type]=Number(r.rowCount||0);
 };
 await run('capa',`UPDATE operational_risk_sources s
   SET status='resolved',resolved_at=COALESCE(resolved_at,now()),last_seen_at=now()
   WHERE s.source_type='capa' AND s.status='open'
     AND NOT EXISTS(
       SELECT 1 FROM exception_capa_candidates c
       WHERE c.id::text=s.source_id
         AND c.severity IN('critical','high')
         AND c.status NOT IN('verified','rejected')
     )`);
 await run('major_incident',`UPDATE operational_risk_sources s
   SET status='resolved',resolved_at=COALESCE(resolved_at,now()),last_seen_at=now()
   WHERE s.source_type='major_incident' AND s.status='open'
     AND NOT EXISTS(
       SELECT 1 FROM major_incidents mi
       WHERE mi.id::text=s.source_id
         AND mi.severity IN('sev1','sev2')
         AND mi.status NOT IN('postmortem_closed','dismissed')
     )`);
 await run('resilience',`UPDATE operational_risk_sources s
   SET status='resolved',resolved_at=COALESCE(resolved_at,now()),last_seen_at=now()
   WHERE s.source_type='resilience' AND s.status='open'
     AND NOT EXISTS(
       SELECT 1
       FROM resilience_recovery_sessions rs
       JOIN resilience_recovery_service_state ss ON ss.session_id=rs.id
       JOIN resilience_service_profiles sp ON sp.service_key=ss.service_key
       WHERE rs.id::text=s.source_id
         AND rs.status IN('all_clear','closed')
         AND (
           (rs.actual_rto_minutes IS NOT NULL AND rs.actual_rto_minutes>sp.rto_minutes)
           OR (ss.rpo_observed_minutes IS NOT NULL AND ss.rpo_observed_minutes>sp.rpo_minutes)
         )
     )`);
 await run('gameday',`UPDATE operational_risk_sources s
   SET status='resolved',resolved_at=COALESCE(resolved_at,now()),last_seen_at=now()
   WHERE s.source_type='gameday' AND s.status='open'
     AND NOT EXISTS(
       SELECT 1 FROM continuity_drills d
       WHERE d.id::text=s.source_id
         AND d.status='completed'
         AND d.result IN('fail','conditional')
         AND d.completed_at>=now()-interval '365 days'
     )`);
 return{resolved_by_source:counts,resolved_total:Object.values(counts).reduce((a,b)=>a+b,0),generated_at:new Date().toISOString()};
}

export function startOperationalRiskHardeningScheduler(){
 if(started||process.env.NODE_ENV==='test')return;
 started=true;
 cron.schedule('27 7 * * *',()=>void reconcileStaleOperationalRiskSources().catch(e=>console.error('[operational-risk] stale source reconciliation failed',e)),{timezone:TZ});
 const t=setTimeout(()=>void reconcileStaleOperationalRiskSources().catch(e=>console.error('[operational-risk] initial stale source reconciliation failed',e)),145_000);
 t.unref?.();
}
