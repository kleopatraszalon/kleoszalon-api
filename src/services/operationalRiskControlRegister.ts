import cron from "node-cron";
import db from "../db";
import {ensureBusinessContinuityGameDaySchema} from "./businessContinuityGameDay";

const TZ="Europe/Budapest";
let schemaPromise:Promise<void>|null=null;
let schedulerStarted=false;
const safe=(v:unknown)=>String(v??"").trim();
const num=(v:unknown)=>{const n=Number(v??0);return Number.isFinite(n)?n:0};
const ACTIVE_RISK_STATUSES=["identified","assessed","mitigating","monitoring"];

type RiskStatus="identified"|"assessed"|"mitigating"|"monitoring"|"accepted"|"closed";
type SourceCandidate={fingerprint:string;source_type:string;source_id:string;source_key:string;title:string;description:string;category:string;location_id?:string|null;owner_key?:string|null;owner_team?:string|null;severity:string;likelihood:number;impact:number;source_route:string;payload?:any;resolved?:boolean};

const DEFAULT_CONTROLS=[
 {key:"release-control",name:"Release Control Center",description:"Fail-closed release governance: csak bizonyítottan zöld technikai és üzleti kapuk mellett enged élesítést.",category:"system",type:"preventive",mode:"automated",frequency:"continuous",keyControl:true,evidence:"Release gate evidence és exact-SHA deployment proof."},
 {key:"transaction-trace",name:"Tranzakció-életút bizonyítás",description:"Append-only SHA-256/HMAC bizonyítás és üzleti tranzakció trace minden kritikus pénzügyi életútra.",category:"finance",type:"detective",mode:"automated",frequency:"continuous",keyControl:true,evidence:"Érvényes trace proof és signature coverage."},
 {key:"financial-reconciliation",name:"Pénzügyi egyeztetés",description:"Napi end-to-end pénzügyi és készlet-integritási reconciliation eltérésdetektálással.",category:"finance",type:"detective",mode:"automated",frequency:"daily",keyControl:true,evidence:"Reconciliation run és nulla nyitott kritikus eltérés."},
 {key:"exception-sla",name:"Exception SLA governance",description:"Automatikus eltérésbeemelés, SLA, routing, escalation és bizonyítékos lezárás.",category:"process",type:"detective",mode:"automated",frequency:"continuous",keyControl:true,evidence:"Exception case/event/SLA evidence."},
 {key:"rbac-boundary",name:"RBAC és scope boundary",description:"Szerepkör- és telephelyalapú hozzáférési határok a vezetői és pénzügyi funkciókra.",category:"security",type:"preventive",mode:"automated",frequency:"continuous",keyControl:true,evidence:"RBAC regression és permission audit."},
 {key:"resilience-gameday",name:"Resilience / GameDay readiness",description:"RTO/RPO, recovery runbook és időszakos bizonyítékos GameDay gyakorlat.",category:"resilience",type:"preventive",mode:"hybrid",frequency:"quarterly",keyControl:true,evidence:"PASS GameDay scorecard és RTO/RPO evidence."},
 {key:"backup-restore",name:"Backup / Restore proof",description:"Izolált restore-gyakorlat, adatintegritási ellenőrzés és visszaállítási evidence.",category:"resilience",type:"corrective",mode:"hybrid",frequency:"quarterly",keyControl:true,evidence:"Restore proof, RTO/RPO mérés és üzleti verifikáció."}
];

function band(score:number){return score>=16?"critical":score>=10?"high":score>=5?"medium":"low"}
function frequencyDays(v:string){return v==="daily"?1:v==="weekly"?7:v==="monthly"?31:v==="quarterly"?92:v==="annual"?365:v==="continuous"?30:90}

export function ensureOperationalRiskControlSchema(){
 if(!schemaPromise)schemaPromise=(async()=>{
  await ensureBusinessContinuityGameDaySchema();
  await db.query(`
   CREATE EXTENSION IF NOT EXISTS pgcrypto;
   CREATE TABLE IF NOT EXISTS operational_risks(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),risk_no text NOT NULL UNIQUE DEFAULT ('RISK-'||to_char(now(),'YYYYMMDD-HH24MISS')||'-'||substr(gen_random_uuid()::text,1,6)),
    source_fingerprint text UNIQUE,title text NOT NULL,description text NOT NULL,category text NOT NULL,location_id text,
    owner_key text,owner_team text,status text NOT NULL DEFAULT 'identified' CHECK(status IN('identified','assessed','mitigating','monitoring','accepted','closed')),
    treatment text NOT NULL DEFAULT 'reduce' CHECK(treatment IN('reduce','avoid','transfer','accept','monitor')),
    likelihood integer NOT NULL CHECK(likelihood BETWEEN 1 AND 5),impact integer NOT NULL CHECK(impact BETWEEN 1 AND 5),
    inherent_score integer NOT NULL CHECK(inherent_score BETWEEN 1 AND 25),inherent_band text NOT NULL CHECK(inherent_band IN('low','medium','high','critical')),
    residual_score integer NOT NULL CHECK(residual_score BETWEEN 1 AND 25),residual_band text NOT NULL CHECK(residual_band IN('low','medium','high','critical')),
    appetite_threshold integer NOT NULL DEFAULT 8 CHECK(appetite_threshold BETWEEN 1 AND 25),appetite_state text NOT NULL DEFAULT 'outside' CHECK(appetite_state IN('within','outside')),
    last_assessed_at timestamptz NOT NULL DEFAULT now(),next_review_at timestamptz NOT NULL DEFAULT (now()+interval '90 days'),
    accepted_by text,accepted_at timestamptz,acceptance_note text,acceptance_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
    closed_by text,closed_at timestamptz,closure_note text,closure_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
   );
   CREATE INDEX IF NOT EXISTS operational_risks_work_idx ON operational_risks(status,residual_band,appetite_state,next_review_at);
   CREATE INDEX IF NOT EXISTS operational_risks_location_idx ON operational_risks(location_id,status,residual_score DESC);

   CREATE TABLE IF NOT EXISTS operational_risk_sources(
    id bigserial PRIMARY KEY,risk_id uuid NOT NULL REFERENCES operational_risks(id) ON DELETE CASCADE,
    source_type text NOT NULL,source_id text NOT NULL,source_key text NOT NULL,severity text NOT NULL,status text NOT NULL DEFAULT 'open' CHECK(status IN('open','resolved')),
    source_route text,payload jsonb NOT NULL DEFAULT '{}'::jsonb,first_seen_at timestamptz NOT NULL DEFAULT now(),last_seen_at timestamptz NOT NULL DEFAULT now(),resolved_at timestamptz,
    UNIQUE(risk_id,source_type,source_id)
   );
   CREATE INDEX IF NOT EXISTS operational_risk_sources_idx ON operational_risk_sources(source_type,source_id,status);

   CREATE TABLE IF NOT EXISTS operational_controls(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),control_no text NOT NULL UNIQUE DEFAULT ('CTRL-'||to_char(now(),'YYYYMMDD-HH24MISS')||'-'||substr(gen_random_uuid()::text,1,6)),
    control_key text NOT NULL UNIQUE,name text NOT NULL,description text NOT NULL,category text NOT NULL,
    control_type text NOT NULL CHECK(control_type IN('preventive','detective','corrective')),execution_mode text NOT NULL CHECK(execution_mode IN('manual','automated','hybrid')),
    owner_key text,owner_team text,frequency text NOT NULL CHECK(frequency IN('continuous','daily','weekly','monthly','quarterly','annual','event')),
    is_key_control boolean NOT NULL DEFAULT false,expected_evidence text,enabled boolean NOT NULL DEFAULT true,
    design_score numeric(5,2) NOT NULL DEFAULT 0 CHECK(design_score BETWEEN 0 AND 100),operation_score numeric(5,2) NOT NULL DEFAULT 0 CHECK(operation_score BETWEEN 0 AND 100),
    effectiveness_score numeric(5,2) NOT NULL DEFAULT 0 CHECK(effectiveness_score BETWEEN 0 AND 100),last_test_at timestamptz,next_test_at timestamptz,
    created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
   );
   CREATE INDEX IF NOT EXISTS operational_controls_due_idx ON operational_controls(enabled,is_key_control,next_test_at,effectiveness_score);

   CREATE TABLE IF NOT EXISTS operational_risk_controls(
    risk_id uuid NOT NULL REFERENCES operational_risks(id) ON DELETE CASCADE,control_id uuid NOT NULL REFERENCES operational_controls(id) ON DELETE CASCADE,
    weight integer NOT NULL DEFAULT 100 CHECK(weight BETWEEN 1 AND 100),rationale text,linked_by text NOT NULL,linked_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(risk_id,control_id)
   );

   CREATE TABLE IF NOT EXISTS operational_control_tests(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),control_id uuid NOT NULL REFERENCES operational_controls(id) ON DELETE CASCADE,risk_id uuid REFERENCES operational_risks(id) ON DELETE SET NULL,
    result text NOT NULL CHECK(result IN('pass','partial','fail')),design_score numeric(5,2) NOT NULL CHECK(design_score BETWEEN 0 AND 100),
    operating_score numeric(5,2) NOT NULL CHECK(operating_score BETWEEN 0 AND 100),effectiveness_score numeric(5,2) NOT NULL CHECK(effectiveness_score BETWEEN 0 AND 100),
    test_note text NOT NULL,evidence jsonb NOT NULL DEFAULT '{}'::jsonb,tested_by text NOT NULL,tested_at timestamptz NOT NULL DEFAULT now()
   );
   CREATE INDEX IF NOT EXISTS operational_control_tests_idx ON operational_control_tests(control_id,tested_at DESC);

   CREATE TABLE IF NOT EXISTS operational_kris(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),risk_id uuid NOT NULL REFERENCES operational_risks(id) ON DELETE CASCADE,code text NOT NULL,
    name text NOT NULL,description text NOT NULL,direction text NOT NULL CHECK(direction IN('max','min')),unit text,
    warning_threshold numeric NOT NULL,breach_threshold numeric NOT NULL,owner_key text,frequency text NOT NULL DEFAULT 'monthly' CHECK(frequency IN('daily','weekly','monthly','quarterly')),
    enabled boolean NOT NULL DEFAULT true,last_value numeric,last_state text NOT NULL DEFAULT 'no_data' CHECK(last_state IN('no_data','ok','warning','breached')),last_measured_at timestamptz,
    created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(risk_id,code)
   );
   CREATE INDEX IF NOT EXISTS operational_kris_state_idx ON operational_kris(enabled,last_state,last_measured_at);

   CREATE TABLE IF NOT EXISTS operational_kri_measurements(
    id bigserial PRIMARY KEY,kri_id uuid NOT NULL REFERENCES operational_kris(id) ON DELETE CASCADE,value numeric NOT NULL,state text NOT NULL CHECK(state IN('ok','warning','breached')),
    note text,evidence jsonb NOT NULL DEFAULT '{}'::jsonb,measured_by text NOT NULL,measured_at timestamptz NOT NULL DEFAULT now()
   );
   CREATE INDEX IF NOT EXISTS operational_kri_measurements_idx ON operational_kri_measurements(kri_id,measured_at DESC,id DESC);

   CREATE TABLE IF NOT EXISTS operational_risk_events(
    id bigserial PRIMARY KEY,risk_id uuid NOT NULL REFERENCES operational_risks(id) ON DELETE CASCADE,event_type text NOT NULL,actor_key text NOT NULL,
    from_status text,to_status text,message text NOT NULL,evidence jsonb NOT NULL DEFAULT '{}'::jsonb,created_at timestamptz NOT NULL DEFAULT now()
   );
   CREATE INDEX IF NOT EXISTS operational_risk_events_idx ON operational_risk_events(risk_id,created_at,id);

   CREATE OR REPLACE FUNCTION kleo_operational_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '% is append-only',TG_TABLE_NAME; END $$;
   DROP TRIGGER IF EXISTS trg_operational_risk_events_immutable ON operational_risk_events;
   CREATE TRIGGER trg_operational_risk_events_immutable BEFORE UPDATE OR DELETE ON operational_risk_events FOR EACH ROW EXECUTE FUNCTION kleo_operational_immutable();
   DROP TRIGGER IF EXISTS trg_operational_control_tests_immutable ON operational_control_tests;
   CREATE TRIGGER trg_operational_control_tests_immutable BEFORE UPDATE OR DELETE ON operational_control_tests FOR EACH ROW EXECUTE FUNCTION kleo_operational_immutable();
   DROP TRIGGER IF EXISTS trg_operational_kri_measurements_immutable ON operational_kri_measurements;
   CREATE TRIGGER trg_operational_kri_measurements_immutable BEFORE UPDATE OR DELETE ON operational_kri_measurements FOR EACH ROW EXECUTE FUNCTION kleo_operational_immutable();

   CREATE OR REPLACE FUNCTION kleo_operational_control_test_guard() RETURNS trigger LANGUAGE plpgsql AS $$
   DECLARE c_owner text;key_control boolean;
   BEGIN
    SELECT owner_key,is_key_control INTO c_owner,key_control FROM operational_controls WHERE id=NEW.control_id;
    IF length(trim(COALESCE(NEW.test_note,'')))<10 OR length(trim(COALESCE(NEW.evidence->>'description','')))<5 THEN RAISE EXCEPTION 'Control test note and evidence are required' USING ERRCODE='23514'; END IF;
    IF COALESCE(key_control,false) AND NULLIF(trim(COALESCE(c_owner,'')),'') IS NOT NULL AND lower(trim(c_owner))=lower(trim(NEW.tested_by)) THEN RAISE EXCEPTION 'Key control test requires independent tester' USING ERRCODE='23514'; END IF;
    RETURN NEW;
   END $$;
   DROP TRIGGER IF EXISTS trg_operational_control_test_guard ON operational_control_tests;
   CREATE TRIGGER trg_operational_control_test_guard BEFORE INSERT ON operational_control_tests FOR EACH ROW EXECUTE FUNCTION kleo_operational_control_test_guard();

   CREATE OR REPLACE FUNCTION kleo_operational_risk_governance() RETURNS trigger LANGUAGE plpgsql AS $$
   DECLARE bad_sources integer;breached_kri integer;stale_key integer;
   BEGIN
    IF NEW.status='accepted' THEN
     IF NULLIF(trim(COALESCE(NEW.accepted_by,'')),'') IS NULL OR lower(trim(NEW.accepted_by))=lower(trim(COALESCE(NEW.owner_key,''))) THEN RAISE EXCEPTION 'Risk acceptance requires independent approver' USING ERRCODE='23514'; END IF;
     IF length(trim(COALESCE(NEW.acceptance_note,'')))<10 OR length(trim(COALESCE(NEW.acceptance_evidence->>'description','')))<5 THEN RAISE EXCEPTION 'Risk acceptance note and evidence are required' USING ERRCODE='23514'; END IF;
     IF NEW.next_review_at IS NULL OR NEW.next_review_at>now()+interval '90 days' THEN RAISE EXCEPTION 'Accepted risk requires review within 90 days' USING ERRCODE='23514'; END IF;
    END IF;
    IF NEW.status='closed' THEN
     IF NEW.residual_score>NEW.appetite_threshold THEN RAISE EXCEPTION 'Risk cannot close outside appetite' USING ERRCODE='23514'; END IF;
     IF length(trim(COALESCE(NEW.closure_note,'')))<10 OR length(trim(COALESCE(NEW.closure_evidence->>'description','')))<5 THEN RAISE EXCEPTION 'Risk closure note and evidence are required' USING ERRCODE='23514'; END IF;
     SELECT COUNT(*)::int INTO bad_sources FROM operational_risk_sources WHERE risk_id=NEW.id AND status='open' AND lower(severity) IN('critical','high','sev1','sev2','fail');
     SELECT COUNT(*)::int INTO breached_kri FROM operational_kris WHERE risk_id=NEW.id AND enabled=true AND last_state='breached';
     SELECT COUNT(*)::int INTO stale_key FROM operational_risk_controls rc JOIN operational_controls c ON c.id=rc.control_id WHERE rc.risk_id=NEW.id AND c.enabled=true AND c.is_key_control=true AND (c.last_test_at IS NULL OR c.last_test_at<now()-interval '180 days');
     IF bad_sources>0 OR breached_kri>0 OR stale_key>0 THEN RAISE EXCEPTION 'Risk closure blocked: unresolved source, breached KRI or stale key control remains' USING ERRCODE='23514'; END IF;
    END IF;
    RETURN NEW;
   END $$;
   DROP TRIGGER IF EXISTS trg_operational_risk_governance ON operational_risks;
   CREATE TRIGGER trg_operational_risk_governance BEFORE UPDATE OF status,accepted_by,acceptance_note,acceptance_evidence,closure_note,closure_evidence,residual_score,appetite_threshold,next_review_at ON operational_risks FOR EACH ROW EXECUTE FUNCTION kleo_operational_risk_governance();
  `);
  for(const c of DEFAULT_CONTROLS){await db.query(`INSERT INTO operational_controls(control_key,name,description,category,control_type,execution_mode,frequency,is_key_control,expected_evidence,created_by,next_test_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'system-risk-register',now()) ON CONFLICT(control_key) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,category=EXCLUDED.category,control_type=EXCLUDED.control_type,execution_mode=EXCLUDED.execution_mode,frequency=EXCLUDED.frequency,is_key_control=EXCLUDED.is_key_control,expected_evidence=EXCLUDED.expected_evidence,enabled=true,updated_at=now()`,[c.key,c.name,c.description,c.category,c.type,c.mode,c.frequency,c.keyControl,c.evidence])}
 })().catch(error=>{schemaPromise=null;throw error});
 return schemaPromise;
}

async function event(riskId:string,type:string,actor:string,message:string,fromStatus?:string|null,toStatus?:string|null,evidence:any={}){await db.query(`INSERT INTO operational_risk_events(risk_id,event_type,actor_key,from_status,to_status,message,evidence) VALUES($1::uuid,$2,$3,$4,$5,$6,$7::jsonb)`,[riskId,type,actor,fromStatus||null,toStatus||null,message,JSON.stringify(evidence||{})])}

export async function recalculateOperationalRisk(riskId:string){
 await ensureOperationalRiskControlSchema();
 const risk=(await db.query(`SELECT * FROM operational_risks WHERE id=$1::uuid`,[riskId])).rows[0];if(!risk)throw Object.assign(new Error("A risk rekord nem található."),{status:404});
 const row=(await db.query(`SELECT COALESCE(SUM(c.effectiveness_score*rc.weight)/NULLIF(SUM(rc.weight),0),0)::numeric eff FROM operational_risk_controls rc JOIN operational_controls c ON c.id=rc.control_id AND c.enabled=true WHERE rc.risk_id=$1::uuid`,[riskId])).rows[0];
 const inherent=Math.max(1,Math.min(25,num(risk.likelihood)*num(risk.impact)));const eff=Math.max(0,Math.min(100,num(row?.eff)));const mitigation=Math.min(.8,eff/125);const residual=Math.max(1,Math.ceil(inherent*(1-mitigation)));
 const updated=(await db.query(`UPDATE operational_risks SET inherent_score=$2,inherent_band=$3,residual_score=$4,residual_band=$5,appetite_state=CASE WHEN $4<=appetite_threshold THEN 'within' ELSE 'outside' END,last_assessed_at=now(),updated_at=now() WHERE id=$1::uuid RETURNING *`,[riskId,inherent,band(inherent),residual,band(residual)])).rows[0];
 return{...updated,control_effectiveness:Number(eff.toFixed(2))};
}

async function linkDefaultControls(riskId:string,category:string,actor:string){
 const keys=category==="finance"||category==="nav"?["financial-reconciliation","transaction-trace","release-control"]:category==="resilience"?["resilience-gameday","backup-restore","release-control"]:category==="continuity"?["resilience-gameday","release-control"]:["exception-sla","release-control","rbac-boundary"];
 await db.query(`INSERT INTO operational_risk_controls(risk_id,control_id,weight,rationale,linked_by) SELECT $1::uuid,c.id,100,'Automatikus alapkontroll a risk kategóriához',$3 FROM operational_controls c WHERE c.control_key=ANY($2::text[]) ON CONFLICT(risk_id,control_id) DO NOTHING`,[riskId,keys,actor]);
}

async function upsertSource(c:SourceCandidate){
 const existing=(await db.query(`SELECT * FROM operational_risks WHERE source_fingerprint=$1`,[c.fingerprint])).rows[0];let riskId:string;let created=false;
 if(!existing){const inherent=Math.max(1,Math.min(25,c.likelihood*c.impact));const r=(await db.query(`INSERT INTO operational_risks(source_fingerprint,title,description,category,location_id,owner_key,owner_team,likelihood,impact,inherent_score,inherent_band,residual_score,residual_band,appetite_state,created_by)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$10,$11,CASE WHEN $10<=8 THEN 'within' ELSE 'outside' END,'system-risk-sync') RETURNING id::text`,[c.fingerprint,c.title,c.description,c.category,c.location_id||null,c.owner_key||null,c.owner_team||null,c.likelihood,c.impact,inherent,band(inherent)])).rows[0];riskId=r.id;created=true;await linkDefaultControls(riskId,c.category,"system-risk-sync");await event(riskId,"risk_identified","system-risk-sync","Automatikus operational risk létrehozva vezetői forrásból.",null,"identified",{source_type:c.source_type,source_id:c.source_id})}
 else{riskId=String(existing.id);await db.query(`UPDATE operational_risks SET title=$2,description=$3,category=$4,location_id=COALESCE($5,location_id),owner_key=COALESCE($6,owner_key),owner_team=COALESCE($7,owner_team),likelihood=GREATEST(likelihood,$8),impact=GREATEST(impact,$9),status=CASE WHEN status='closed' AND $10=false THEN 'identified' ELSE status END,updated_at=now() WHERE id=$1::uuid`,[riskId,c.title,c.description,c.category,c.location_id||null,c.owner_key||null,c.owner_team||null,c.likelihood,c.impact,Boolean(c.resolved)])}
 const source=(await db.query(`INSERT INTO operational_risk_sources(risk_id,source_type,source_id,source_key,severity,status,source_route,payload,resolved_at)
  VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$8::jsonb,CASE WHEN $6='resolved' THEN now() END)
  ON CONFLICT(risk_id,source_type,source_id) DO UPDATE SET source_key=EXCLUDED.source_key,severity=EXCLUDED.severity,status=EXCLUDED.status,source_route=EXCLUDED.source_route,payload=EXCLUDED.payload,last_seen_at=now(),resolved_at=CASE WHEN EXCLUDED.status='resolved' THEN COALESCE(operational_risk_sources.resolved_at,now()) ELSE NULL END RETURNING id`,[riskId,c.source_type,c.source_id,c.source_key,c.severity,c.resolved?"resolved":"open",c.source_route,JSON.stringify(c.payload||{})])).rows[0];
 await recalculateOperationalRisk(riskId);return{risk_id:riskId,created,source_id:source.id};
}

async function sourceCandidates():Promise<SourceCandidate[]>{
 await ensureOperationalRiskControlSchema();const out:SourceCandidate[]=[];
 const capas=(await db.query(`SELECT c.id::text,c.status,c.severity,c.title,c.problem_statement,c.owner_key,c.owner_team,rc.location_id FROM exception_capa_candidates c JOIN exception_root_cause_clusters rc ON rc.id=c.cluster_id WHERE c.severity IN('critical','high') AND c.status NOT IN('verified','rejected')`)).rows;
 for(const x of capas)out.push({fingerprint:`capa:${x.id}`,source_type:"capa",source_id:x.id,source_key:x.id,title:`Operational risk · ${x.title}`,description:x.problem_statement,category:"process",location_id:x.location_id,owner_key:x.owner_key,owner_team:x.owner_team,severity:x.severity,likelihood:x.severity==="critical"?4:3,impact:x.severity==="critical"?5:4,source_route:`/finance/exception-command-center/capa?id=${x.id}`,payload:{status:x.status,severity:x.severity}});
 const incidents=(await db.query(`SELECT id::text,incident_no,severity,status,title,summary,location_id,incident_commander_key,impact_score FROM major_incidents WHERE severity IN('sev1','sev2') AND status NOT IN('postmortem_closed','dismissed')`)).rows;
 for(const x of incidents)out.push({fingerprint:`major:${x.id}`,source_type:"major_incident",source_id:x.id,source_key:x.incident_no,title:`Operational risk · ${x.title}`,description:x.summary,category:"resilience",location_id:x.location_id,owner_key:x.incident_commander_key,severity:x.severity,likelihood:x.severity==="sev1"?5:4,impact:x.severity==="sev1"?5:4,source_route:`/finance/exception-command-center/major-incidents?id=${x.id}`,payload:{status:x.status,impact_score:x.impact_score}});
 const recoveries=(await db.query(`SELECT rs.id::text,rs.incident_id::text,rs.location_id,rs.status,rs.actual_rto_minutes,rs.max_observed_rpo_minutes,mi.incident_no,mi.title,
  MAX(CASE WHEN sp.criticality='tier1' AND ((rs.actual_rto_minutes IS NOT NULL AND rs.actual_rto_minutes>sp.rto_minutes) OR (ss.rpo_observed_minutes IS NOT NULL AND ss.rpo_observed_minutes>sp.rpo_minutes)) THEN 1 ELSE 0 END)::int tier1_breach,
  MAX(CASE WHEN (rs.actual_rto_minutes IS NOT NULL AND rs.actual_rto_minutes>sp.rto_minutes) OR (ss.rpo_observed_minutes IS NOT NULL AND ss.rpo_observed_minutes>sp.rpo_minutes) THEN 1 ELSE 0 END)::int any_breach
  FROM resilience_recovery_sessions rs JOIN major_incidents mi ON mi.id=rs.incident_id JOIN resilience_recovery_service_state ss ON ss.session_id=rs.id JOIN resilience_service_profiles sp ON sp.service_key=ss.service_key
  WHERE rs.status IN('all_clear','closed') GROUP BY rs.id,mi.incident_no,mi.title HAVING MAX(CASE WHEN (rs.actual_rto_minutes IS NOT NULL AND rs.actual_rto_minutes>sp.rto_minutes) OR (ss.rpo_observed_minutes IS NOT NULL AND ss.rpo_observed_minutes>sp.rpo_minutes) THEN 1 ELSE 0 END)=1`)).rows;
 for(const x of recoveries)out.push({fingerprint:`resilience:${x.id}`,source_type:"resilience",source_id:x.id,source_key:x.incident_no,title:`Recovery target breach · ${x.title}`,description:`A helyreállítás során RTO/RPO céltúllépés történt. Mért RTO: ${x.actual_rto_minutes??"—"} perc; max RPO: ${x.max_observed_rpo_minutes??"—"} perc.`,category:"resilience",location_id:x.location_id,severity:x.tier1_breach?"critical":"high",likelihood:x.tier1_breach?4:3,impact:x.tier1_breach?5:4,source_route:`/finance/exception-command-center/resilience?session=${x.id}`,payload:{status:x.status,tier1_breach:Boolean(x.tier1_breach),actual_rto_minutes:x.actual_rto_minutes,max_observed_rpo_minutes:x.max_observed_rpo_minutes}});
 const drills=(await db.query(`SELECT id::text,drill_no,title,objective,location_id,result,overall_score,owner_key,completed_at FROM continuity_drills WHERE status='completed' AND result IN('fail','conditional') AND completed_at>=now()-interval '365 days'`)).rows;
 for(const x of drills)out.push({fingerprint:`gameday:${x.id}`,source_type:"gameday",source_id:x.id,source_key:x.drill_no,title:`GameDay risk · ${x.title}`,description:`${x.objective} Eredmény: ${String(x.result).toUpperCase()}, score: ${x.overall_score??0}/100.`,category:"continuity",location_id:x.location_id,owner_key:x.owner_key,severity:x.result==="fail"?"critical":"high",likelihood:x.result==="fail"?4:3,impact:x.result==="fail"?4:3,source_route:`/finance/exception-command-center/gameday?drill=${x.id}`,payload:{result:x.result,score:x.overall_score,completed_at:x.completed_at}});
 return out;
}

export async function syncOperationalRiskRegister(){await ensureOperationalRiskControlSchema();const candidates=await sourceCandidates();let created=0,updated=0;const activeByType=new Map<string,Set<string>>();for(const c of candidates){if(!activeByType.has(c.source_type))activeByType.set(c.source_type,new Set());activeByType.get(c.source_type)!.add(c.source_id);const r=await upsertSource(c);r.created?created++:updated++}
 for(const [type,ids] of activeByType){const values=[...ids];await db.query(`UPDATE operational_risk_sources SET status='resolved',resolved_at=COALESCE(resolved_at,now()) WHERE source_type=$1 AND status='open' AND NOT(source_id=ANY($2::text[]))`,[type,values.length?values:["__none__"]])}
 const risks=(await db.query(`SELECT id::text FROM operational_risks WHERE status<>'closed'`)).rows;for(const r of risks)await recalculateOperationalRisk(r.id);return{candidates:candidates.length,created,updated,recalculated:risks.length,generated_at:new Date().toISOString()}}

export async function operationalRiskSummary(locationId:string|null=null){await ensureOperationalRiskControlSchema();const risk=(await db.query(`SELECT COUNT(*) FILTER(WHERE status<>'closed')::int open_risks,COUNT(*) FILTER(WHERE status='accepted')::int accepted_risks,COUNT(*) FILTER(WHERE status<>'closed' AND residual_band='critical')::int critical_residual,COUNT(*) FILTER(WHERE status<>'closed' AND residual_band='high')::int high_residual,COUNT(*) FILTER(WHERE status<>'closed' AND appetite_state='outside')::int outside_appetite,COUNT(*) FILTER(WHERE status<>'closed' AND next_review_at<now())::int overdue_reviews FROM operational_risks WHERE ($1::text IS NULL OR location_id=$1 OR location_id IS NULL)`,[locationId])).rows[0]||{};const controls=(await db.query(`SELECT COUNT(*) FILTER(WHERE enabled AND is_key_control)::int key_controls,COUNT(*) FILTER(WHERE enabled AND is_key_control AND (last_test_at IS NULL OR next_test_at<now()))::int key_controls_due,ROUND(AVG(effectiveness_score) FILTER(WHERE enabled),1) avg_effectiveness FROM operational_controls`)).rows[0]||{};const kri=(await db.query(`SELECT COUNT(*) FILTER(WHERE k.enabled AND k.last_state='breached')::int breached_kri,COUNT(*) FILTER(WHERE k.enabled AND k.last_state='warning')::int warning_kri FROM operational_kris k JOIN operational_risks r ON r.id=k.risk_id WHERE ($1::text IS NULL OR r.location_id=$1 OR r.location_id IS NULL)`,[locationId])).rows[0]||{};return{...risk,...controls,...kri,generated_at:new Date().toISOString()}}

export async function listOperationalRisks(filters:any={}){await ensureOperationalRiskControlSchema();const params:any[]=[];const where:string[]=[];const add=(sql:string,v:any)=>{params.push(v);where.push(sql.replace("?",`$${params.length}`))};if(filters.status&&filters.status!=="all")add("r.status=?",safe(filters.status));if(filters.band&&filters.band!=="all")add("r.residual_band=?",safe(filters.band));if(filters.category&&filters.category!=="all")add("r.category=?",safe(filters.category));if(filters.location_id)add("r.location_id=?",safe(filters.location_id));if(filters.q){params.push(`%${safe(filters.q)}%`);const p=params.length;where.push(`(r.risk_no ILIKE $${p} OR r.title ILIKE $${p} OR r.description ILIKE $${p})`)}params.push(Math.max(20,Math.min(300,num(filters.limit)||100)));return(await db.query(`SELECT r.*,COUNT(DISTINCT rc.control_id)::int control_count,COUNT(DISTINCT s.id) FILTER(WHERE s.status='open')::int open_sources,COUNT(DISTINCT k.id) FILTER(WHERE k.last_state='breached')::int breached_kri FROM operational_risks r LEFT JOIN operational_risk_controls rc ON rc.risk_id=r.id LEFT JOIN operational_risk_sources s ON s.risk_id=r.id LEFT JOIN operational_kris k ON k.risk_id=r.id ${where.length?`WHERE ${where.join(' AND ')}`:''} GROUP BY r.id ORDER BY CASE r.residual_band WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,r.residual_score DESC,r.updated_at DESC LIMIT $${params.length}`,params)).rows}

export async function getOperationalRisk(id:string){await ensureOperationalRiskControlSchema();const item=await recalculateOperationalRisk(id);const controls=(await db.query(`SELECT c.*,rc.weight,rc.rationale,rc.linked_by,rc.linked_at,(SELECT row_to_json(t) FROM operational_control_tests t WHERE t.control_id=c.id ORDER BY t.tested_at DESC LIMIT 1) last_test FROM operational_risk_controls rc JOIN operational_controls c ON c.id=rc.control_id WHERE rc.risk_id=$1::uuid ORDER BY c.is_key_control DESC,c.name`,[id])).rows;const sources=(await db.query(`SELECT * FROM operational_risk_sources WHERE risk_id=$1::uuid ORDER BY status,last_seen_at DESC`,[id])).rows;const kris=(await db.query(`SELECT k.*,(SELECT json_agg(m ORDER BY m.measured_at DESC) FROM (SELECT * FROM operational_kri_measurements WHERE kri_id=k.id ORDER BY measured_at DESC LIMIT 10)m) measurements FROM operational_kris k WHERE k.risk_id=$1::uuid ORDER BY k.name`,[id])).rows;const events=(await db.query(`SELECT * FROM operational_risk_events WHERE risk_id=$1::uuid ORDER BY created_at,id`,[id])).rows;return{item,controls,sources,kris,events}}

export async function createOperationalRisk(input:any,actor:string){await ensureOperationalRiskControlSchema();const title=safe(input.title),description=safe(input.description),category=safe(input.category)||"process";if(title.length<5||description.length<10)throw Object.assign(new Error("Risk cím és részletes leírás szükséges."),{status:400});const likelihood=Math.max(1,Math.min(5,num(input.likelihood)||3)),impact=Math.max(1,Math.min(5,num(input.impact)||3)),inherent=likelihood*impact;const row=(await db.query(`INSERT INTO operational_risks(title,description,category,location_id,owner_key,owner_team,treatment,likelihood,impact,inherent_score,inherent_band,residual_score,residual_band,appetite_threshold,appetite_state,next_review_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$10,$11,$12,CASE WHEN $10<=$12 THEN 'within' ELSE 'outside' END,COALESCE($13::timestamptz,now()+interval '90 days'),$14) RETURNING *`,[title,description,category,safe(input.location_id)||null,safe(input.owner_key)||null,safe(input.owner_team)||null,safe(input.treatment)||"reduce",likelihood,impact,inherent,band(inherent),Math.max(1,Math.min(25,num(input.appetite_threshold)||8)),safe(input.next_review_at)||null,actor])).rows[0];await linkDefaultControls(row.id,category,actor);await event(row.id,"risk_identified",actor,"Manuális operational risk létrehozva.",null,"identified",{category});return getOperationalRisk(row.id)}

const transitions:Record<RiskStatus,RiskStatus[]>={identified:["assessed","mitigating","monitoring","accepted"],assessed:["mitigating","monitoring","accepted","closed"],mitigating:["monitoring","accepted","closed"],monitoring:["mitigating","accepted","closed"],accepted:["mitigating","monitoring","closed"],closed:["identified"]};
export async function updateOperationalRisk(id:string,input:any,actor:string){await ensureOperationalRiskControlSchema();const before=(await db.query(`SELECT * FROM operational_risks WHERE id=$1::uuid`,[id])).rows[0];if(!before)throw Object.assign(new Error("A risk rekord nem található."),{status:404});const status=(safe(input.status)||before.status) as RiskStatus;if(status!==before.status&&!transitions[before.status as RiskStatus]?.includes(status))throw Object.assign(new Error(`Érvénytelen risk státuszváltás: ${before.status} → ${status}.`),{status:409});const evidence=input.evidence||{};const note=safe(input.note);const acceptedBy=status==="accepted"?(safe(input.approver_key)||actor):before.accepted_by;const closedBy=status==="closed"?actor:before.closed_by;await db.query(`UPDATE operational_risks SET title=$2,description=$3,category=$4,owner_key=$5,owner_team=$6,status=$7,treatment=$8,likelihood=$9,impact=$10,appetite_threshold=$11,next_review_at=COALESCE($12::timestamptz,next_review_at),accepted_by=$13,accepted_at=CASE WHEN $7='accepted' THEN COALESCE(accepted_at,now()) ELSE accepted_at END,acceptance_note=CASE WHEN $7='accepted' THEN $14 ELSE acceptance_note END,acceptance_evidence=CASE WHEN $7='accepted' THEN $15::jsonb ELSE acceptance_evidence END,closed_by=$16,closed_at=CASE WHEN $7='closed' THEN now() ELSE closed_at END,closure_note=CASE WHEN $7='closed' THEN $14 ELSE closure_note END,closure_evidence=CASE WHEN $7='closed' THEN $15::jsonb ELSE closure_evidence END,updated_at=now() WHERE id=$1::uuid`,[id,safe(input.title??before.title),safe(input.description??before.description),safe(input.category??before.category),input.owner_key===undefined?before.owner_key:(safe(input.owner_key)||null),input.owner_team===undefined?before.owner_team:(safe(input.owner_team)||null),status,safe(input.treatment??before.treatment),Math.max(1,Math.min(5,num(input.likelihood??before.likelihood))),Math.max(1,Math.min(5,num(input.impact??before.impact))),Math.max(1,Math.min(25,num(input.appetite_threshold??before.appetite_threshold))),safe(input.next_review_at)||null,acceptedBy,status==="accepted"?note:before.acceptance_note,JSON.stringify(status==="accepted"?evidence:before.acceptance_evidence||{}),closedBy]);await recalculateOperationalRisk(id);await event(id,status!==before.status?"status_changed":"risk_updated",actor,note||`Risk frissítve${status!==before.status?`: ${before.status} → ${status}`:""}.`,before.status,status,evidence);return getOperationalRisk(id)}

export async function listOperationalControls(){await ensureOperationalRiskControlSchema();return(await db.query(`SELECT c.*,COUNT(DISTINCT rc.risk_id)::int risk_count,(SELECT result FROM operational_control_tests t WHERE t.control_id=c.id ORDER BY t.tested_at DESC LIMIT 1) last_result FROM operational_controls c LEFT JOIN operational_risk_controls rc ON rc.control_id=c.id GROUP BY c.id ORDER BY c.is_key_control DESC,c.name`)).rows}
export async function upsertOperationalControl(input:any,actor:string,id?:string){await ensureOperationalRiskControlSchema();const name=safe(input.name),description=safe(input.description),key=safe(input.control_key);if(!id&&(key.length<3||name.length<3))throw Object.assign(new Error("Control key és név szükséges."),{status:400});let row;if(id)row=(await db.query(`UPDATE operational_controls SET name=COALESCE(NULLIF($2,''),name),description=COALESCE(NULLIF($3,''),description),category=COALESCE(NULLIF($4,''),category),control_type=COALESCE(NULLIF($5,''),control_type),execution_mode=COALESCE(NULLIF($6,''),execution_mode),owner_key=$7,owner_team=$8,frequency=COALESCE(NULLIF($9,''),frequency),is_key_control=COALESCE($10,is_key_control),expected_evidence=$11,enabled=COALESCE($12,enabled),updated_at=now() WHERE id=$1::uuid RETURNING *`,[id,name,description,safe(input.category),safe(input.control_type),safe(input.execution_mode),safe(input.owner_key)||null,safe(input.owner_team)||null,safe(input.frequency),input.is_key_control===undefined?null:Boolean(input.is_key_control),safe(input.expected_evidence)||null,input.enabled===undefined?null:Boolean(input.enabled)])).rows[0];else row=(await db.query(`INSERT INTO operational_controls(control_key,name,description,category,control_type,execution_mode,owner_key,owner_team,frequency,is_key_control,expected_evidence,created_by,next_test_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now()) RETURNING *`,[key,name,description,safe(input.category)||"process",safe(input.control_type)||"preventive",safe(input.execution_mode)||"manual",safe(input.owner_key)||null,safe(input.owner_team)||null,safe(input.frequency)||"quarterly",Boolean(input.is_key_control),safe(input.expected_evidence)||null,actor])).rows[0];if(!row)throw Object.assign(new Error("A control nem található."),{status:404});return row}
export async function linkOperationalControl(riskId:string,controlId:string,input:any,actor:string){await ensureOperationalRiskControlSchema();await db.query(`INSERT INTO operational_risk_controls(risk_id,control_id,weight,rationale,linked_by) VALUES($1::uuid,$2::uuid,$3,$4,$5) ON CONFLICT(risk_id,control_id) DO UPDATE SET weight=EXCLUDED.weight,rationale=EXCLUDED.rationale`,[riskId,controlId,Math.max(1,Math.min(100,num(input.weight)||100)),safe(input.rationale)||null,actor]);await recalculateOperationalRisk(riskId);await event(riskId,"control_linked",actor,"Kontroll hozzárendelve a riskhez.",null,null,{control_id:controlId});return getOperationalRisk(riskId)}
export async function testOperationalControl(controlId:string,input:any,actor:string){await ensureOperationalRiskControlSchema();const c=(await db.query(`SELECT * FROM operational_controls WHERE id=$1::uuid`,[controlId])).rows[0];if(!c)throw Object.assign(new Error("A control nem található."),{status:404});const design=Math.max(0,Math.min(100,num(input.design_score))),operating=Math.max(0,Math.min(100,num(input.operating_score)));const effectiveness=Math.round(((design+operating)/2)*100)/100;const result=safe(input.result)|| (effectiveness>=80?"pass":effectiveness>=60?"partial":"fail");const evidence=input.evidence||{};const row=(await db.query(`INSERT INTO operational_control_tests(control_id,risk_id,result,design_score,operating_score,effectiveness_score,test_note,evidence,tested_by) VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8::jsonb,$9) RETURNING *`,[controlId,safe(input.risk_id)||null,result,design,operating,effectiveness,safe(input.test_note),JSON.stringify(evidence),actor])).rows[0];const nextDays=frequencyDays(String(c.frequency));await db.query(`UPDATE operational_controls SET design_score=$2,operation_score=$3,effectiveness_score=$4,last_test_at=now(),next_test_at=now()+make_interval(days=>$5),updated_at=now() WHERE id=$1::uuid`,[controlId,design,operating,effectiveness,nextDays]);const risks=(await db.query(`SELECT risk_id::text FROM operational_risk_controls WHERE control_id=$1::uuid`,[controlId])).rows;for(const r of risks){await recalculateOperationalRisk(r.risk_id);await event(r.risk_id,"control_tested",actor,`Control teszt: ${c.name} · ${String(result).toUpperCase()} · ${effectiveness}%.`,null,null,{control_id:controlId,test_id:row.id,result,effectiveness_score:effectiveness})}return row}
export async function createOperationalKri(riskId:string,input:any,actor:string){await ensureOperationalRiskControlSchema();const code=safe(input.code),name=safe(input.name),description=safe(input.description);if(code.length<2||name.length<3||description.length<5)throw Object.assign(new Error("KRI kód, név és leírás szükséges."),{status:400});const row=(await db.query(`INSERT INTO operational_kris(risk_id,code,name,description,direction,unit,warning_threshold,breach_threshold,owner_key,frequency,created_by) VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,[riskId,code,name,description,safe(input.direction)||"max",safe(input.unit)||null,num(input.warning_threshold),num(input.breach_threshold),safe(input.owner_key)||null,safe(input.frequency)||"monthly",actor])).rows[0];await event(riskId,"kri_created",actor,`KRI létrehozva: ${name}.`,null,null,{kri_id:row.id,code});return row}
export async function measureOperationalKri(kriId:string,input:any,actor:string){await ensureOperationalRiskControlSchema();const k=(await db.query(`SELECT * FROM operational_kris WHERE id=$1::uuid`,[kriId])).rows[0];if(!k)throw Object.assign(new Error("A KRI nem található."),{status:404});const value=num(input.value);const warning=num(k.warning_threshold),breach=num(k.breach_threshold);const state=k.direction==="min"?(value<=breach?"breached":value<=warning?"warning":"ok"):(value>=breach?"breached":value>=warning?"warning":"ok");const row=(await db.query(`INSERT INTO operational_kri_measurements(kri_id,value,state,note,evidence,measured_by) VALUES($1::uuid,$2,$3,$4,$5::jsonb,$6) RETURNING *`,[kriId,value,state,safe(input.note)||null,JSON.stringify(input.evidence||{}),actor])).rows[0];await db.query(`UPDATE operational_kris SET last_value=$2,last_state=$3,last_measured_at=now(),updated_at=now() WHERE id=$1::uuid`,[kriId,value,state]);await event(k.risk_id,"kri_measured",actor,`KRI mérés: ${k.name} = ${value}${k.unit?` ${k.unit}`:""} · ${state.toUpperCase()}.`,null,null,{kri_id:kriId,value,state,evidence:input.evidence||{}});return row}

export async function runOperationalRiskGovernanceCycle(){const sync=await syncOperationalRiskRegister();const summary=await operationalRiskSummary(null);return{...sync,summary}}
export function startOperationalRiskScheduler(){if(schedulerStarted)return;schedulerStarted=true;cron.schedule("25 7 * * *",()=>{void runOperationalRiskGovernanceCycle().catch(e=>console.error("[operational-risk] scheduled governance failed",e))},{timezone:TZ});setTimeout(()=>void runOperationalRiskGovernanceCycle().catch(e=>console.error("[operational-risk] initial governance failed",e)),120_000)}
