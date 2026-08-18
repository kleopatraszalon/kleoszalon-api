import type {NextFunction,Request,Response} from "express";
import db from "../db";
import {ensureResilienceRecoveryHardeningSchema} from "../services/resilienceRecoveryHardening";

type Gate={key:string;group:string;label:string;status:"pass"|"fail";blocking:true;editable:false;message:string;evidence:string|null;source:string};
function releaseRef(){return String(process.env.RENDER_GIT_COMMIT||process.env.GIT_COMMIT_SHA||process.env.COMMIT_SHA||"unversioned").trim()}

export async function buildResilienceRecoveryReleaseGate():Promise<Gate>{
 try{
  await ensureResilienceRecoveryHardeningSchema();
  const ref=releaseRef();
  const row=(await db.query(`SELECT
      COUNT(*)::int active_freezes,
      COUNT(*) FILTER(WHERE NOT EXISTS(
        SELECT 1 FROM resilience_emergency_change_overrides o
        WHERE o.freeze_id=f.id AND o.release_ref=$1 AND o.status='approved' AND o.expires_at>now()
      ))::int uncovered_freezes,
      COUNT(*) FILTER(WHERE EXISTS(
        SELECT 1 FROM resilience_emergency_change_overrides o
        WHERE o.freeze_id=f.id AND o.release_ref=$1 AND o.status='approved' AND o.expires_at>now()
      ))::int covered_freezes
    FROM resilience_change_freezes f WHERE f.status='active'`,[ref])).rows[0]||{};
  const session=(await db.query(`SELECT COUNT(*)::int active_sessions FROM resilience_recovery_sessions WHERE status IN('open','recovering','verifying')`)).rows[0]||{};
  const breaches=(await db.query(`SELECT
      COUNT(*) FILTER(WHERE now()>mi.declared_at+(sp.rto_minutes||' minutes')::interval AND ss.state<>'verified')::int rto_breaches,
      COUNT(*) FILTER(WHERE ss.rpo_observed_minutes IS NOT NULL AND ss.rpo_observed_minutes>sp.rpo_minutes)::int rpo_breaches,
      COUNT(*) FILTER(WHERE ss.state<>'verified')::int unverified_services
    FROM resilience_recovery_sessions rs JOIN major_incidents mi ON mi.id=rs.incident_id
    JOIN resilience_recovery_service_state ss ON ss.session_id=rs.id JOIN resilience_service_profiles sp ON sp.service_key=ss.service_key
    WHERE rs.status IN('open','recovering','verifying')`)).rows[0]||{};
  const pending=Number((await db.query(`SELECT COUNT(*)::int count FROM resilience_emergency_change_overrides WHERE status='pending'`)).rows[0]?.count||0);
  const freezes=Number(row.active_freezes||0),uncovered=Number(row.uncovered_freezes||0),covered=Number(row.covered_freezes||0),activeSessions=Number(session.active_sessions||0),rto=Number(breaches.rto_breaches||0),rpo=Number(breaches.rpo_breaches||0),unverified=Number(breaches.unverified_services||0);
  const passed=uncovered===0&&(freezes===0?activeSessions===0:covered===freezes);
  const emergency=freezes>0&&uncovered===0&&covered===freezes;
  return{key:"business.resilience_recovery",group:"Üzleti integritás",label:"Resilience & Recovery / change-freeze",status:passed?"pass":"fail",blocking:true,editable:false,
    message:passed?(emergency?`EMERGENCY CONTROL PASS: ${freezes} aktív change-freeze mindegyikét külön, exact-SHA (${ref}) kétkulcsos override fedi. A többi release gate továbbra is kötelező.`:"PASS: nincs aktív recovery change-freeze vagy lezáratlan recovery session."):`NO-GO: aktív recovery session=${activeSessions}, change-freeze=${freezes}, exact-SHA override nélkül=${uncovered}. RTO sértés=${rto}, RPO sértés=${rpo}, nem verifikált szolgáltatás=${unverified}.`,
    evidence:`release_ref=${ref}; active_sessions=${activeSessions}; active_freezes=${freezes}; covered_freezes=${covered}; uncovered_freezes=${uncovered}; rto_breaches=${rto}; rpo_breaches=${rpo}; unverified_services=${unverified}; pending_overrides=${pending}`,source:"resilience-recovery"};
 }catch(error:any){return{key:"business.resilience_recovery",group:"Üzleti integritás",label:"Resilience & Recovery / change-freeze",status:"fail",blocking:true,editable:false,message:`NO-GO: a Resilience & Recovery release gate nem ellenőrizhető (${error?.message||"ismeretlen adatbázishiba"}).`,evidence:null,source:"resilience-recovery"}}
}

function recompute(body:any,gate:Gate){
 if(!body||!Array.isArray(body.gates))return body;const gates=[...body.gates.filter((x:any)=>x?.key!==gate.key),gate];const blocking=gates.filter((x:any)=>Boolean(x?.blocking)),blockers=blocking.filter((x:any)=>x?.status!=="pass");
 return{...body,release_ready:blockers.length===0,decision:blockers.length===0?"GO":"NO-GO",summary:{total:gates.length,pass:gates.filter((x:any)=>x?.status==="pass").length,warning:gates.filter((x:any)=>x?.status==="warning").length,fail:gates.filter((x:any)=>x?.status==="fail").length,pending:gates.filter((x:any)=>x?.status==="pending").length,blocking_total:blocking.length,blocking_open:blockers.length},blockers:blockers.map((x:any)=>({key:x.key,label:x.label,status:x.status,message:x.message})),gates,meta:{...(body.meta||{}),resilience_recovery_gate:gate.status}};
}
export async function enforceResilienceReleaseGate(req:Request,res:Response,next:NextFunction){if(req.method!=="GET"||(req.path!=="/"&&req.path!==""))return next();const gate=await buildResilienceRecoveryReleaseGate();const original=res.json.bind(res);res.json=((body:any)=>original(recompute(body,gate))) as typeof res.json;next()}
