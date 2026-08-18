import cron from "node-cron";
import db from "../db";
import { ensureExceptionCapaImprovementBridge } from "./exceptionCapaImprovement";

let schemaPromise:Promise<void>|null=null;
let started=false;
let cyclePromise:Promise<any>|null=null;
const safe=(value:unknown)=>String(value??"").trim();
const n=(value:unknown)=>{const parsed=Number(value??0);return Number.isFinite(parsed)?parsed:0};

type RecommendationStatus="monitoring"|"recommended"|"dismissed";
type Evaluation={
  score:number;
  recommended:boolean;
  reason_codes:string[];
  suggested_due_at:string;
  suggested_owner_key:string|null;
  suggested_owner_team:string|null;
  suggested_kpi:{metric_key:string;name:string;unit:string;direction:string;before_value:number;target_value:number;source:string};
  snapshot:Record<string,unknown>;
};

function addDays(days:number){const d=new Date();d.setDate(d.getDate()+days);return d.toISOString()}
function earlierDate(a:string,b:unknown){const raw=safe(b);if(!raw)return a;const parsed=new Date(raw);if(Number.isNaN(parsed.getTime()))return a;return parsed.getTime()<new Date(a).getTime()?parsed.toISOString():a}

export async function ensureExceptionCapaImprovementRecommendationSchema(){
  if(!schemaPromise){
    schemaPromise=(async()=>{
      await ensureExceptionCapaImprovementBridge();
      await db.query(`
        CREATE TABLE IF NOT EXISTS exception_capa_improvement_recommendations(
          capa_id uuid PRIMARY KEY REFERENCES exception_capa_candidates(id) ON DELETE CASCADE,
          status text NOT NULL DEFAULT 'monitoring' CHECK(status IN('monitoring','recommended','dismissed')),
          score integer NOT NULL DEFAULT 0 CHECK(score BETWEEN 0 AND 100),
          reason_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
          suggested_due_at timestamptz,
          suggested_owner_key text,
          suggested_owner_team text,
          suggested_kpi jsonb NOT NULL DEFAULT '{}'::jsonb,
          source_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
          recommended_at timestamptz,
          dismissed_at timestamptz,
          dismissed_by text,
          dismissed_note text,
          dismissed_score integer,
          last_evaluated_at timestamptz NOT NULL DEFAULT now(),
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS exception_capa_improvement_recommendation_status_idx
          ON exception_capa_improvement_recommendations(status,score DESC,last_evaluated_at DESC);
        CREATE OR REPLACE FUNCTION kleo_exception_improvement_recommendation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.status='dismissed' AND (NEW.dismissed_note IS NULL OR length(trim(NEW.dismissed_note))<10) THEN
            RAISE EXCEPTION 'Dismissed recommendation requires at least 10 characters of rationale';
          END IF;
          IF NEW.score<0 OR NEW.score>100 THEN RAISE EXCEPTION 'Recommendation score must be between 0 and 100'; END IF;
          RETURN NEW;
        END $$;
        DROP TRIGGER IF EXISTS trg_exception_improvement_recommendation_guard ON exception_capa_improvement_recommendations;
        CREATE TRIGGER trg_exception_improvement_recommendation_guard
          BEFORE INSERT OR UPDATE ON exception_capa_improvement_recommendations
          FOR EACH ROW EXECUTE FUNCTION kleo_exception_improvement_recommendation_guard();
      `);
    })().catch(error=>{schemaPromise=null;throw error});
  }
  return schemaPromise;
}

function evaluate(capa:any):Evaluation{
  const severity=safe(capa.severity).toLowerCase();
  const clusterType=safe(capa.cluster_type).toLowerCase();
  const caseCount=n(capa.case_count),sourceCount=n(capa.source_count);
  const overdue=Boolean(capa.due_at&&new Date(capa.due_at).getTime()<Date.now()&&!['verified','rejected'].includes(safe(capa.status)));
  let score=severity==='critical'?60:severity==='high'?40:severity==='medium'?15:5;
  const reasons:string[]=[];
  if(severity==='critical')reasons.push('critical_severity');
  else if(severity==='high')reasons.push('high_severity');
  if(clusterType==='recurrence'){score+=35;reasons.push('repeated_exception')}
  else if(clusterType==='outbreak'){score+=25;reasons.push('exception_outbreak')}
  else if(clusterType==='trace'||clusterType==='entity'){score+=10;reasons.push('cross_process_cluster')}
  if(caseCount>=5){score+=25;reasons.push('high_case_count')}
  else if(caseCount>=3){score+=15;reasons.push('multiple_cases')}
  else if(caseCount>=2)score+=5;
  if(sourceCount>=3){score+=10;reasons.push('multiple_sources')}
  if(overdue){score+=15;reasons.push('capa_overdue')}
  score=Math.max(0,Math.min(100,score));
  const recommended=score>=50||severity==='critical'||clusterType==='recurrence'||caseCount>=3;
  const dueDays=severity==='critical'?7:(severity==='high'||clusterType==='recurrence'?14:30);
  const computedDue=earlierDate(addDays(dueDays),capa.due_at);
  const baseline=Math.max(1,caseCount);
  return{
    score,recommended,reason_codes:reasons,
    suggested_due_at:computedDue,
    suggested_owner_key:safe(capa.owner_key)||null,
    suggested_owner_team:safe(capa.owner_team)||null,
    suggested_kpi:{metric_key:'exception_case_count',name:'Kapcsolt Exception case-ek száma',unit:'db',direction:'lower_better',before_value:baseline,target_value:0,source:'Exception Intelligence root-cause klaszter'},
    snapshot:{
      evaluated_at:new Date().toISOString(),capa_status:capa.status,severity,cluster_id:capa.cluster_id,cluster_key:capa.cluster_key,cluster_type:clusterType,
      case_count:caseCount,source_count:sourceCount,due_at:capa.due_at||null,overdue,approved_at:capa.approved_at||null,
    }
  };
}

async function writeEvent(capaId:string,type:string,actor:string,message:string,evidence:any){
  await db.query(`INSERT INTO exception_capa_events(capa_id,event_type,actor_key,message,evidence) VALUES($1::uuid,$2,$3,$4,$5::jsonb)`,[capaId,type,actor,message,JSON.stringify(evidence||{})]);
}

async function sourceCapa(capaId:string){
  return(await db.query(`SELECT c.*,rc.cluster_key,rc.cluster_type,rc.location_id,rc.case_count,rc.source_count,rc.evidence cluster_evidence
    FROM exception_capa_candidates c JOIN exception_root_cause_clusters rc ON rc.id=c.cluster_id WHERE c.id=$1::uuid`,[capaId])).rows[0]||null;
}

export async function refreshExceptionCapaImprovementRecommendation(capaId:string,actor="system-intelligence"){
  await ensureExceptionCapaImprovementRecommendationSchema();
  const capa=await sourceCapa(capaId);if(!capa)throw Object.assign(new Error('A CAPA rekord nem található.'),{status:404});
  const evaluation=evaluate(capa);
  const existing=(await db.query(`SELECT * FROM exception_capa_improvement_recommendations WHERE capa_id=$1::uuid`,[capaId])).rows[0]||null;
  const dismissedScore=n(existing?.dismissed_score);
  const reopen=existing?.status==='dismissed'&&evaluation.recommended&&evaluation.score>=dismissedScore+15;
  let status:RecommendationStatus=evaluation.recommended?'recommended':'monitoring';
  if(existing?.status==='dismissed'&&!reopen)status='dismissed';
  const row=(await db.query(`INSERT INTO exception_capa_improvement_recommendations(
      capa_id,status,score,reason_codes,suggested_due_at,suggested_owner_key,suggested_owner_team,suggested_kpi,source_snapshot,recommended_at,last_evaluated_at,updated_at
    ) VALUES($1::uuid,$2,$3,$4::jsonb,$5::timestamptz,$6,$7,$8::jsonb,$9::jsonb,CASE WHEN $2='recommended' THEN now() ELSE NULL END,now(),now())
    ON CONFLICT(capa_id) DO UPDATE SET
      status=$2,score=$3,reason_codes=$4::jsonb,suggested_due_at=$5::timestamptz,suggested_owner_key=$6,suggested_owner_team=$7,
      suggested_kpi=$8::jsonb,source_snapshot=$9::jsonb,
      recommended_at=CASE WHEN $2='recommended' THEN COALESCE(exception_capa_improvement_recommendations.recommended_at,now()) ELSE exception_capa_improvement_recommendations.recommended_at END,
      dismissed_at=CASE WHEN $2='dismissed' THEN exception_capa_improvement_recommendations.dismissed_at ELSE NULL END,
      dismissed_by=CASE WHEN $2='dismissed' THEN exception_capa_improvement_recommendations.dismissed_by ELSE NULL END,
      dismissed_note=CASE WHEN $2='dismissed' THEN exception_capa_improvement_recommendations.dismissed_note ELSE NULL END,
      dismissed_score=CASE WHEN $2='dismissed' THEN exception_capa_improvement_recommendations.dismissed_score ELSE NULL END,
      last_evaluated_at=now(),updated_at=now()
    RETURNING *`,[
      capaId,status,evaluation.score,JSON.stringify(evaluation.reason_codes),evaluation.suggested_due_at,evaluation.suggested_owner_key,evaluation.suggested_owner_team,
      JSON.stringify(evaluation.suggested_kpi),JSON.stringify(evaluation.snapshot)
    ])).rows[0];
  if((!existing||existing.status!=='recommended')&&status==='recommended'){
    await writeEvent(capaId,reopen?'improvement_recommendation_reopened':'improvement_recommended',actor,
      reopen?'A fejlesztési projekt javaslat újranyílt a kockázati pontszám növekedése miatt.':'Automatikus fejlesztési projekt javaslat készült.',
      {score:evaluation.score,reason_codes:evaluation.reason_codes,suggested_due_at:evaluation.suggested_due_at,suggested_kpi:evaluation.suggested_kpi});
  }
  return{...row,can_promote:['approved','in_progress','verification','verified'].includes(safe(capa.status)),capa_status:capa.status,location_id:capa.location_id||null};
}

export async function getExceptionCapaImprovementRecommendation(capaId:string,tenantId:string){
  const recommendation=await refreshExceptionCapaImprovementRecommendation(capaId);
  const link=(await db.query(`SELECT l.project_id,p.code project_code,p.title project_title,p.status project_status,p.approval_state
    FROM exception_capa_improvement_links l JOIN management_improvement_projects p ON p.id=l.project_id
    WHERE l.capa_id=$1::uuid AND l.tenant_id=$2::bigint`,[capaId,tenantId])).rows[0]||null;
  return{...recommendation,accepted:Boolean(link),project:link||null};
}

export async function dismissExceptionCapaImprovementRecommendation(capaId:string,actor:string,note:string){
  await ensureExceptionCapaImprovementRecommendationSchema();
  const rationale=safe(note);if(rationale.length<10)throw Object.assign(new Error('A javaslat elutasításához legalább 10 karakteres indok szükséges.'),{status:400});
  await refreshExceptionCapaImprovementRecommendation(capaId,actor);
  const row=(await db.query(`UPDATE exception_capa_improvement_recommendations SET status='dismissed',dismissed_at=now(),dismissed_by=$2,dismissed_note=$3,dismissed_score=score,updated_at=now() WHERE capa_id=$1::uuid RETURNING *`,[capaId,actor,rationale])).rows[0];
  await writeEvent(capaId,'improvement_recommendation_dismissed',actor,'A fejlesztési projekt javaslat vezetői indoklással elutasítva.',{score:row.score,note:rationale});
  return row;
}

export async function syncExceptionCapaImprovementRecommendations(){
  if(cyclePromise)return cyclePromise;
  cyclePromise=(async()=>{
    await ensureExceptionCapaImprovementRecommendationSchema();
    const rows=(await db.query(`SELECT c.id::text FROM exception_capa_candidates c
      WHERE c.status NOT IN('verified','rejected') ORDER BY c.updated_at DESC LIMIT 1000`)).rows;
    let recommended=0,monitoring=0,dismissed=0,failed=0;
    for(const item of rows){
      try{const result=await refreshExceptionCapaImprovementRecommendation(String(item.id));if(result.status==='recommended')recommended++;else if(result.status==='dismissed')dismissed++;else monitoring++}
      catch(error){failed++;console.error('[exception-capa] improvement recommendation evaluation failed',item.id,error)}
    }
    return{checked:rows.length,recommended,monitoring,dismissed,failed,generated_at:new Date().toISOString()};
  })().finally(()=>{cyclePromise=null});
  return cyclePromise;
}

export function startExceptionCapaImprovementRecommendationScheduler(){
  if(started||process.env.EXCEPTION_CENTER_DISABLED==='1'||process.env.NODE_ENV==='test')return;started=true;
  cron.schedule('12,27,42,57 * * * *',()=>{void syncExceptionCapaImprovementRecommendations().catch(error=>console.error('[exception-capa] scheduled improvement recommendation sync failed',error))},{timezone:'Europe/Budapest'});
}
