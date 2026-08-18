import cron from "node-cron";
import db from "../db";
import { ensureExceptionIntelligenceSchema } from "./exceptionCommandCenterIntelligence";

const TZ="Europe/Budapest";
let schemaPromise:Promise<void>|null=null;
let started=false;
const safe=(v:unknown)=>String(v??"").trim();
const n=(v:unknown)=>{const x=Number(v??0);return Number.isFinite(x)?x:0};

type CapaStatus="proposed"|"approved"|"in_progress"|"verification"|"verified"|"rejected";

export function ensureExceptionCapaSchema(){
  if(!schemaPromise){
    schemaPromise=(async()=>{
      await ensureExceptionIntelligenceSchema();
      await db.query(`
        CREATE TABLE IF NOT EXISTS exception_capa_candidates(
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          cluster_id uuid NOT NULL UNIQUE REFERENCES exception_root_cause_clusters(id) ON DELETE CASCADE,
          status text NOT NULL DEFAULT 'proposed' CHECK(status IN('proposed','approved','in_progress','verification','verified','rejected')),
          severity text NOT NULL CHECK(severity IN('critical','high','medium','low')),
          title text NOT NULL,
          problem_statement text NOT NULL,
          root_cause_hypothesis text NOT NULL,
          corrective_action text NOT NULL,
          preventive_action text NOT NULL,
          owner_team text,
          owner_key text,
          due_at timestamptz,
          approved_by text,
          approved_at timestamptz,
          verified_by text,
          verified_at timestamptz,
          verification_note text,
          verification_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
          created_by text NOT NULL DEFAULT 'system-intelligence',
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS exception_capa_status_due_idx ON exception_capa_candidates(status,due_at,severity);
        CREATE TABLE IF NOT EXISTS exception_capa_events(
          id bigserial PRIMARY KEY,
          capa_id uuid NOT NULL REFERENCES exception_capa_candidates(id) ON DELETE CASCADE,
          event_type text NOT NULL,
          actor_key text NOT NULL,
          from_status text,
          to_status text,
          message text,
          evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
          created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS exception_capa_events_capa_idx ON exception_capa_events(capa_id,created_at,id);
        CREATE OR REPLACE FUNCTION kleo_exception_capa_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'exception_capa_events is append-only'; END $$;
        DROP TRIGGER IF EXISTS trg_exception_capa_events_immutable ON exception_capa_events;
        CREATE TRIGGER trg_exception_capa_events_immutable BEFORE UPDATE OR DELETE ON exception_capa_events
        FOR EACH ROW EXECUTE FUNCTION kleo_exception_capa_event_immutable();
      `);
    })().catch(error=>{schemaPromise=null;throw error});
  }
  return schemaPromise;
}

function proposal(cluster:any){
  const recommendation=safe(cluster.evidence?.recommendation)||"A klaszterhez root-cause vizsgálat szükséges.";
  if(cluster.cluster_type==="recurrence")return{
    root:"A korábbi lezárás valószínűleg a tünetet kezelte, de a kiváltó ok vagy a kontroll nem szűnt meg tartósan.",
    corrective:"Vizsgáld felül az utolsó lezárási bizonyítékot, reprodukáld a hibát és szüntesd meg a konkrét kiváltó okot.",
    preventive:"Vezess be tartós kontrollt vagy automatikus tesztet, amely ugyanennek az eltérésnek a visszatérését még üzleti hatás előtt jelzi."
  };
  if(cluster.cluster_type==="outbreak")return{
    root:"Közös telephelyi ok feltételezhető: helyi infrastruktúra, jogosultság, folyamatváltozás, készlet- vagy eszközállapot.",
    corrective:"Egyetlen közös incidensként vizsgáld a klasztert; ellenőrizd az időben legkorábbi változást és az érintett helyi függőségeket.",
    preventive:"A telephelyi változtatásokhoz vezess be előzetes kontrollt, rollback tervet és utóellenőrzési checklistet."
  };
  if(cluster.cluster_type==="trace")return{
    root:"Egy tranzakciós életút több downstream kontrollpontban hibás; a gyökérok várhatóan a legkorábbi sérült vagy hiányos esemény előtt található.",
    corrective:"A trace időrendben első hibás eseményétől indulva javítsd a láncot, majd futtass end-to-end újraellenőrzést.",
    preventive:"A kritikus trace lépésekre fail-closed integritási és idempotencia kontrollt, valamint regressziós tesztet vezess be."
  };
  return{
    root:"Azonos üzleti entitást több modul jelez; közös adat-, kulcs-, jogosultság- vagy integrációs probléma valószínű.",
    corrective:"Ellenőrizd az entitás forrásrekordját, kapcsolatait, utolsó módosítását és a downstream szinkronokat.",
    preventive:"A közös entitásra vezess be referenciális/integritási kontrollt és módosítás utáni automatikus keresztmodul-validációt."
  };
}

async function event(capaId:string,type:string,actor:string,message:string,fromStatus?:string|null,toStatus?:string|null,evidence:any={}){
  await db.query(`INSERT INTO exception_capa_events(capa_id,event_type,actor_key,from_status,to_status,message,evidence) VALUES($1::uuid,$2,$3,$4,$5,$6,$7::jsonb)`,[capaId,type,actor,fromStatus||null,toStatus||null,message,JSON.stringify(evidence||{})]);
}

export async function syncExceptionCapaCandidates(){
  await ensureExceptionCapaSchema();
  const clusters=(await db.query(`SELECT * FROM exception_root_cause_clusters WHERE status='active' AND (severity IN('critical','high') OR cluster_type IN('recurrence','outbreak')) ORDER BY last_seen_at DESC`)).rows;
  let created=0,refreshed=0;
  for(const cluster of clusters){
    const p=proposal(cluster);const dueDays=cluster.severity==='critical'?3:cluster.severity==='high'?7:14;
    const existing=(await db.query(`SELECT id::text,status FROM exception_capa_candidates WHERE cluster_id=$1::uuid`,[cluster.id])).rows[0];
    if(!existing){
      const row=(await db.query(`INSERT INTO exception_capa_candidates(cluster_id,severity,title,problem_statement,root_cause_hypothesis,corrective_action,preventive_action,due_at)
        VALUES($1::uuid,$2,$3,$4,$5,$6,$7,now()+make_interval(days=>$8)) RETURNING id::text`,[
        cluster.id,cluster.severity,`CAPA · ${cluster.title}`,`${cluster.summary} Érintett Exception case-ek: ${n(cluster.case_count)}; források: ${n(cluster.source_count)}.`,p.root,p.corrective,p.preventive,dueDays
      ])).rows[0];
      await event(row.id,"proposed","system-intelligence","Automatikus CAPA-javaslat létrehozva root-cause klaszter alapján.",null,"proposed",{cluster_id:cluster.id,cluster_key:cluster.cluster_key,recommendation:cluster.evidence?.recommendation});created++;
    }else if(existing.status==="proposed"){
      await db.query(`UPDATE exception_capa_candidates SET severity=$2,title=$3,problem_statement=$4,root_cause_hypothesis=$5,updated_at=now() WHERE id=$1::uuid`,[
        existing.id,cluster.severity,`CAPA · ${cluster.title}`,`${cluster.summary} Érintett Exception case-ek: ${n(cluster.case_count)}; források: ${n(cluster.source_count)}.`,p.root
      ]);refreshed++;
    }
  }
  return{clusters_checked:clusters.length,created,refreshed,generated_at:new Date().toISOString()};
}

export async function exceptionCapaSummary(locationId:string|null=null){
  await ensureExceptionCapaSchema();
  const row=(await db.query(`SELECT COUNT(*)::int total,
      COUNT(*) FILTER(WHERE c.status='proposed')::int proposed,
      COUNT(*) FILTER(WHERE c.status='approved')::int approved,
      COUNT(*) FILTER(WHERE c.status='in_progress')::int in_progress,
      COUNT(*) FILTER(WHERE c.status='verification')::int verification,
      COUNT(*) FILTER(WHERE c.status='verified' AND c.verified_at>=now()-interval '30 days')::int verified_30d,
      COUNT(*) FILTER(WHERE c.status NOT IN('verified','rejected') AND c.due_at<now())::int overdue,
      COUNT(*) FILTER(WHERE c.severity='critical' AND c.status NOT IN('verified','rejected'))::int critical_open
    FROM exception_capa_candidates c JOIN exception_root_cause_clusters rc ON rc.id=c.cluster_id
    WHERE ($1::text IS NULL OR rc.location_id=$1 OR rc.location_id IS NULL)`,[locationId])).rows[0]||{};
  return{...row,generated_at:new Date().toISOString()};
}

export async function listExceptionCapas(filters:any={}){
  await ensureExceptionCapaSchema();const params:any[]=[];const where:string[]=[];const add=(expr:string,value:any)=>{params.push(value);where.push(expr.replace('?',`$${params.length}`))};
  if(filters.status&&filters.status!=="all")add("c.status=?",safe(filters.status));
  if(filters.severity&&filters.severity!=="all")add("c.severity=?",safe(filters.severity));
  if(filters.location_id)add("rc.location_id=?",safe(filters.location_id));
  if(filters.q){params.push(`%${safe(filters.q)}%`);const p=params.length;where.push(`(c.title ILIKE $${p} OR c.problem_statement ILIKE $${p} OR c.root_cause_hypothesis ILIKE $${p})`)}
  const limit=Math.max(20,Math.min(300,n(filters.limit)||100));params.push(limit);
  return(await db.query(`SELECT c.*,rc.cluster_key,rc.cluster_type,rc.location_id,rc.case_count,rc.source_count,rc.status cluster_status,rc.evidence cluster_evidence
    FROM exception_capa_candidates c JOIN exception_root_cause_clusters rc ON rc.id=c.cluster_id
    ${where.length?`WHERE ${where.join(' AND ')}`:''}
    ORDER BY CASE c.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
      CASE c.status WHEN 'proposed' THEN 0 WHEN 'approved' THEN 1 WHEN 'in_progress' THEN 2 WHEN 'verification' THEN 3 ELSE 4 END,c.due_at NULLS LAST LIMIT $${params.length}`,params)).rows;
}

export async function getExceptionCapa(id:string){
  await ensureExceptionCapaSchema();const item=(await db.query(`SELECT c.*,rc.cluster_key,rc.cluster_type,rc.location_id,rc.case_count,rc.source_count,rc.status cluster_status,rc.evidence cluster_evidence FROM exception_capa_candidates c JOIN exception_root_cause_clusters rc ON rc.id=c.cluster_id WHERE c.id=$1::uuid`,[id])).rows[0];
  if(!item)throw Object.assign(new Error("A CAPA rekord nem található."),{status:404});
  const events=(await db.query(`SELECT * FROM exception_capa_events WHERE capa_id=$1::uuid ORDER BY created_at,id`,[id])).rows;
  const cases=(await db.query(`SELECT ec.id::text,ec.title,ec.category,ec.severity,ec.status,ec.sla_state,ec.owner_name,ec.location_id,ec.source_route,cc.reason FROM exception_root_cause_cluster_cases cc JOIN exception_cases ec ON ec.id=cc.case_id WHERE cc.cluster_id=$1::uuid ORDER BY ec.priority_score DESC,ec.last_detected_at DESC`,[item.cluster_id])).rows;
  return{item,events,cases};
}

const transitions:Record<CapaStatus,CapaStatus[]>={
  proposed:["approved","rejected"],approved:["in_progress","rejected"],in_progress:["verification","rejected"],verification:["verified","in_progress"],verified:[],rejected:["proposed"]
};

export async function updateExceptionCapa(id:string,input:any,actor:string){
  await ensureExceptionCapaSchema();const before=(await db.query(`SELECT * FROM exception_capa_candidates WHERE id=$1::uuid`,[id])).rows[0];if(!before)throw Object.assign(new Error("A CAPA rekord nem található."),{status:404});
  const requested=input.status?safe(input.status) as CapaStatus:before.status as CapaStatus;
  if(requested!==before.status&&!transitions[before.status as CapaStatus]?.includes(requested))throw Object.assign(new Error(`Érvénytelen CAPA státuszváltás: ${before.status} → ${requested}.`),{status:409});
  const note=safe(input.note);
  if(requested!==before.status&&["approved","rejected"].includes(requested)&&note.length<5)throw Object.assign(new Error("Jóváhagyáshoz vagy elutasításhoz legalább 5 karakteres indok szükséges."),{status:400});
  const verificationNote=safe(input.verification_note||before.verification_note);
  const verificationEvidence=input.verification_evidence===undefined?(before.verification_evidence||{}):input.verification_evidence;
  if(requested==="verified"&&(verificationNote.length<10||!verificationEvidence||Object.keys(verificationEvidence).length===0))throw Object.assign(new Error("CAPA verifikálásához legalább 10 karakteres verifikációs jegyzet és bizonyíték szükséges."),{status:400});
  const due=input.due_at===undefined?before.due_at:(safe(input.due_at)||null);
  const row=(await db.query(`UPDATE exception_capa_candidates SET status=$2,
      problem_statement=$3,root_cause_hypothesis=$4,corrective_action=$5,preventive_action=$6,owner_team=$7,owner_key=$8,due_at=$9,
      approved_by=CASE WHEN $2='approved' THEN COALESCE(approved_by,$10) ELSE approved_by END,
      approved_at=CASE WHEN $2='approved' THEN COALESCE(approved_at,now()) ELSE approved_at END,
      verified_by=CASE WHEN $2='verified' THEN $10 ELSE verified_by END,
      verified_at=CASE WHEN $2='verified' THEN now() ELSE verified_at END,
      verification_note=$11,verification_evidence=$12::jsonb,updated_at=now()
    WHERE id=$1::uuid RETURNING *`,[
      id,requested,safe(input.problem_statement??before.problem_statement),safe(input.root_cause_hypothesis??before.root_cause_hypothesis),safe(input.corrective_action??before.corrective_action),safe(input.preventive_action??before.preventive_action),
      input.owner_team===undefined?before.owner_team:(safe(input.owner_team)||null),input.owner_key===undefined?before.owner_key:(safe(input.owner_key)||null),due,actor,verificationNote||null,JSON.stringify(verificationEvidence||{})
    ])).rows[0];
  if(requested!==before.status)await event(id,"status_changed",actor,note||`CAPA státusz: ${before.status} → ${requested}.`,before.status,requested,{verification_evidence:requested==="verified"?verificationEvidence:undefined});
  else await event(id,"updated",actor,note||"CAPA tartalom vagy felelős frissítve.",null,null,{owner_team:row.owner_team,owner_key:row.owner_key,due_at:row.due_at});
  return row;
}

export function startExceptionCapaScheduler(){
  if(started||process.env.EXCEPTION_CENTER_DISABLED==="1"||process.env.NODE_ENV==="test")return;started=true;
  cron.schedule("7,22,37,52 * * * *",()=>{void syncExceptionCapaCandidates().catch(error=>console.error("[exception-capa] scheduled sync failed",error))},{timezone:TZ});
  const timer=setTimeout(()=>{void syncExceptionCapaCandidates().catch(error=>console.error("[exception-capa] initial sync failed",error))},125_000);timer.unref?.();
  console.log("[exception-capa] CAPA proposal sync scheduled every 15 minutes Europe/Budapest");
}
