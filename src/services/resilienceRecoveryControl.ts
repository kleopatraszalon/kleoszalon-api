import cron from "node-cron";
import db from "../db";
import { ensureMajorIncidentSchema } from "./majorIncidentWarRoom";

const TZ="Europe/Budapest";
let schemaPromise:Promise<void>|null=null;
let started=false;
let syncPromise:Promise<any>|null=null;
const safe=(v:unknown)=>String(v??"").trim();
const num=(v:unknown)=>{const n=Number(v??0);return Number.isFinite(n)?n:0};
const ACTIVE_INCIDENT_STATUSES=["open","mitigating","monitoring","resolved"];
const SERVICE_MAP:Record<string,string[]>={
  finance:["vir-core","postgresql","finance-nav"],nav:["vir-core","postgresql","finance-nav"],cashier:["vir-core","postgresql","cashier"],
  inventory:["vir-core","postgresql","inventory"],procurement:["vir-core","postgresql","inventory"],communications:["vir-core","communications"],
  trace:["vir-core","postgresql"],system:["vir-core","postgresql"],process:["vir-core","postgresql"],payroll:["vir-core","postgresql"],complaints:["vir-core","communications"]
};

export function ensureResilienceRecoverySchema(){
  if(!schemaPromise){
    schemaPromise=(async()=>{
      await ensureMajorIncidentSchema();
      await db.query(`
        CREATE TABLE IF NOT EXISTS resilience_service_profiles(
          service_key text PRIMARY KEY,
          name text NOT NULL,
          criticality text NOT NULL CHECK(criticality IN('tier1','tier2','tier3')),
          rto_minutes integer NOT NULL CHECK(rto_minutes>0),
          rpo_minutes integer NOT NULL CHECK(rpo_minutes>=0),
          owner_team text,
          enabled boolean NOT NULL DEFAULT true,
          updated_by text,
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        INSERT INTO resilience_service_profiles(service_key,name,criticality,rto_minutes,rpo_minutes,owner_team) VALUES
          ('vir-core','VIR core alkalmazás','tier1',30,5,'IT / VIR'),
          ('postgresql','PostgreSQL üzleti adatbázis','tier1',30,5,'IT / adatbázis'),
          ('finance-nav','Pénzügy és NAV','tier1',60,15,'Pénzügy'),
          ('booking','Foglalás és munkalap','tier1',60,15,'Operáció'),
          ('cashier','Pénztár és checkout','tier1',30,5,'Pénzügy / operáció'),
          ('inventory','Készlet és beszerzés','tier2',120,30,'Beszerzés / raktár'),
          ('communications','E-mail, push és panaszcsatorna','tier2',120,60,'Marketing / ügyfélszolgálat'),
          ('mobile-app','Mobil alkalmazás','tier2',120,60,'IT / marketing')
        ON CONFLICT(service_key) DO NOTHING;

        CREATE TABLE IF NOT EXISTS resilience_recovery_runbooks(
          service_key text NOT NULL REFERENCES resilience_service_profiles(service_key) ON DELETE CASCADE,
          step_key text NOT NULL,
          order_index integer NOT NULL,
          title text NOT NULL,
          instruction text NOT NULL,
          mandatory boolean NOT NULL DEFAULT true,
          verification_required boolean NOT NULL DEFAULT true,
          active boolean NOT NULL DEFAULT true,
          PRIMARY KEY(service_key,step_key)
        );
        INSERT INTO resilience_recovery_runbooks(service_key,step_key,order_index,title,instruction,mandatory,verification_required)
        SELECT p.service_key,x.step_key,x.order_index,x.title,x.instruction,true,true
        FROM resilience_service_profiles p CROSS JOIN (VALUES
          ('impact_scope',10,'Hatás és függőségek rögzítése','Azonosítsd az érintett üzleti folyamatot, adatfüggőséget, felhasználói és pénzügyi hatást.'),
          ('integrity_protect',20,'Adatintegritás védelme','Állítsd meg a további hibás állapotterjedést; dokumentáld a szükséges read-only, queue vagy fail-closed kontrollt.'),
          ('restore',30,'Szolgáltatás helyreállítása','Hajtsd végre a jóváhagyott helyreállítási lépést a War Room döntése szerint.'),
          ('verify',40,'Technikai és üzleti verifikáció','Ellenőrizd a szolgáltatás technikai működését és egy reprezentatív end-to-end üzleti tranzakciót.'),
          ('business_signoff',50,'Üzleti visszaigazolás','Rögzítsd, hogy a szolgáltatás üzletileg ismét használható, és a fennmaradó kockázatok ismertek.')
        ) x(step_key,order_index,title,instruction)
        ON CONFLICT(service_key,step_key) DO NOTHING;

        CREATE TABLE IF NOT EXISTS resilience_recovery_sessions(
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          incident_id uuid NOT NULL UNIQUE REFERENCES major_incidents(id) ON DELETE CASCADE,
          status text NOT NULL DEFAULT 'open' CHECK(status IN('open','recovering','verifying','all_clear','closed')),
          location_id text,
          started_at timestamptz NOT NULL DEFAULT now(),
          recovery_started_at timestamptz,
          verification_started_at timestamptz,
          all_clear_at timestamptz,
          closed_at timestamptz,
          actual_rto_minutes numeric(12,2),
          max_observed_rpo_minutes numeric(12,2),
          all_clear_note text,
          all_clear_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
          created_by text NOT NULL DEFAULT 'system-resilience',
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS resilience_recovery_sessions_status_idx ON resilience_recovery_sessions(status,started_at DESC);

        CREATE TABLE IF NOT EXISTS resilience_recovery_service_state(
          session_id uuid NOT NULL REFERENCES resilience_recovery_sessions(id) ON DELETE CASCADE,
          service_key text NOT NULL REFERENCES resilience_service_profiles(service_key),
          state text NOT NULL DEFAULT 'impacted' CHECK(state IN('impacted','recovering','degraded','restored','verified')),
          impacted_at timestamptz NOT NULL DEFAULT now(),
          restored_at timestamptz,
          verified_at timestamptz,
          rpo_observed_minutes numeric(12,2),
          evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
          verification_note text,
          updated_by text,
          updated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY(session_id,service_key)
        );

        CREATE TABLE IF NOT EXISTS resilience_recovery_step_runs(
          session_id uuid NOT NULL REFERENCES resilience_recovery_sessions(id) ON DELETE CASCADE,
          service_key text NOT NULL,
          step_key text NOT NULL,
          status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','in_progress','completed','skipped')),
          owner_key text,
          started_at timestamptz,
          completed_at timestamptz,
          note text,
          evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
          updated_by text,
          updated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY(session_id,service_key,step_key),
          FOREIGN KEY(service_key,step_key) REFERENCES resilience_recovery_runbooks(service_key,step_key)
        );

        CREATE TABLE IF NOT EXISTS resilience_change_freezes(
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          incident_id uuid NOT NULL UNIQUE REFERENCES major_incidents(id) ON DELETE CASCADE,
          status text NOT NULL DEFAULT 'active' CHECK(status IN('active','lifted')),
          scope jsonb NOT NULL DEFAULT '{"software":true,"database":true,"configuration":true}'::jsonb,
          reason text NOT NULL,
          activated_at timestamptz NOT NULL DEFAULT now(),
          activated_by text NOT NULL DEFAULT 'system-resilience',
          lifted_at timestamptz,
          lifted_by text,
          lift_reason text,
          lift_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS resilience_change_freezes_active_idx ON resilience_change_freezes(status,activated_at DESC);

        CREATE TABLE IF NOT EXISTS resilience_emergency_change_overrides(
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          freeze_id uuid NOT NULL REFERENCES resilience_change_freezes(id) ON DELETE CASCADE,
          release_ref text NOT NULL,
          scope jsonb NOT NULL DEFAULT '{}'::jsonb,
          reason text NOT NULL,
          requested_by text NOT NULL,
          requested_at timestamptz NOT NULL DEFAULT now(),
          status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','approved','rejected','revoked','expired')),
          approved_by text,
          approved_at timestamptz,
          expires_at timestamptz NOT NULL,
          evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
          decision_note text,
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS resilience_override_release_idx ON resilience_emergency_change_overrides(release_ref,status,expires_at DESC);

        CREATE TABLE IF NOT EXISTS resilience_recovery_events(
          id bigserial PRIMARY KEY,
          session_id uuid REFERENCES resilience_recovery_sessions(id) ON DELETE CASCADE,
          incident_id uuid REFERENCES major_incidents(id) ON DELETE CASCADE,
          event_type text NOT NULL,
          actor_key text NOT NULL,
          message text NOT NULL,
          evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
          created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS resilience_recovery_events_session_idx ON resilience_recovery_events(session_id,created_at,id);
        CREATE OR REPLACE FUNCTION kleo_resilience_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'resilience_recovery_events is append-only'; END $$;
        DROP TRIGGER IF EXISTS trg_kleo_resilience_event_immutable ON resilience_recovery_events;
        CREATE TRIGGER trg_kleo_resilience_event_immutable BEFORE UPDATE OR DELETE ON resilience_recovery_events FOR EACH ROW EXECUTE FUNCTION kleo_resilience_event_immutable();

        CREATE OR REPLACE FUNCTION kleo_resilience_step_guard() RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE verify_required boolean;
        BEGIN
          IF NEW.status='completed' THEN
            SELECT verification_required INTO verify_required FROM resilience_recovery_runbooks WHERE service_key=NEW.service_key AND step_key=NEW.step_key;
            IF COALESCE(verify_required,true) AND length(trim(COALESCE(NEW.evidence->>'description',''))) < 5 THEN
              RAISE EXCEPTION 'Recovery step completion evidence is required' USING ERRCODE='23514';
            END IF;
          END IF;
          RETURN NEW;
        END $$;
        DROP TRIGGER IF EXISTS trg_kleo_resilience_step_guard ON resilience_recovery_step_runs;
        CREATE TRIGGER trg_kleo_resilience_step_guard BEFORE INSERT OR UPDATE OF status,evidence ON resilience_recovery_step_runs FOR EACH ROW EXECUTE FUNCTION kleo_resilience_step_guard();

        CREATE OR REPLACE FUNCTION kleo_resilience_override_guard() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.status='approved' THEN
            IF NEW.approved_by IS NULL OR lower(trim(NEW.approved_by))=lower(trim(NEW.requested_by)) THEN
              RAISE EXCEPTION 'Emergency override requires independent second-person approval' USING ERRCODE='23514';
            END IF;
            IF length(trim(COALESCE(NEW.evidence->>'description',''))) < 5 THEN
              RAISE EXCEPTION 'Emergency override approval evidence is required' USING ERRCODE='23514';
            END IF;
            IF NEW.expires_at<=now() OR NEW.expires_at>now()+interval '2 hours' THEN
              RAISE EXCEPTION 'Emergency override expiry must be within 2 hours' USING ERRCODE='23514';
            END IF;
          END IF;
          RETURN NEW;
        END $$;
        DROP TRIGGER IF EXISTS trg_kleo_resilience_override_guard ON resilience_emergency_change_overrides;
        CREATE TRIGGER trg_kleo_resilience_override_guard BEFORE INSERT OR UPDATE OF status,approved_by,evidence,expires_at ON resilience_emergency_change_overrides FOR EACH ROW EXECUTE FUNCTION kleo_resilience_override_guard();
      `);
    })().catch(error=>{schemaPromise=null;throw error});
  }
  return schemaPromise;
}

async function event(sessionId:string|null,incidentId:string|null,type:string,actor:string,message:string,evidence:any={}){
  await db.query(`INSERT INTO resilience_recovery_events(session_id,incident_id,event_type,actor_key,message,evidence) VALUES($1::uuid,$2::uuid,$3,$4,$5,$6::jsonb)`,[sessionId,incidentId,type,actor,message,JSON.stringify(evidence||{})]);
}

function impactedServices(sourcePayload:any){
  const set=new Set<string>(["vir-core","postgresql"]);
  const cats=Array.isArray(sourcePayload?.categories)?sourcePayload.categories:[];
  for(const category of cats)for(const key of SERVICE_MAP[String(category)]||[])set.add(key);
  return [...set];
}

async function seedSession(incident:any){
  let session=(await db.query(`SELECT * FROM resilience_recovery_sessions WHERE incident_id=$1::uuid`,[incident.id])).rows[0];
  if(!session){
    session=(await db.query(`INSERT INTO resilience_recovery_sessions(incident_id,location_id,status) VALUES($1::uuid,$2,'open') RETURNING *`,[incident.id,incident.location_id||null])).rows[0];
    await event(session.id,incident.id,"recovery_session_opened","system-resilience",`Recovery session automatikusan megnyitva ${incident.incident_no} Major Incidenthez.`,{severity:incident.severity,impact_score:incident.impact_score});
  }
  const services=impactedServices(incident.source_payload);
  for(const serviceKey of services){
    await db.query(`INSERT INTO resilience_recovery_service_state(session_id,service_key,state) VALUES($1::uuid,$2,'impacted') ON CONFLICT(session_id,service_key) DO NOTHING`,[session.id,serviceKey]);
    await db.query(`INSERT INTO resilience_recovery_step_runs(session_id,service_key,step_key)
      SELECT $1::uuid,r.service_key,r.step_key FROM resilience_recovery_runbooks r WHERE r.service_key=$2 AND r.active=true
      ON CONFLICT(session_id,service_key,step_key) DO NOTHING`,[session.id,serviceKey]);
  }
  const freeze=(await db.query(`INSERT INTO resilience_change_freezes(incident_id,reason)
    VALUES($1::uuid,$2) ON CONFLICT(incident_id) DO UPDATE SET status=CASE WHEN resilience_change_freezes.status='lifted' AND $3 THEN 'active' ELSE resilience_change_freezes.status END,updated_at=now() RETURNING *`,[
      incident.id,`${String(incident.severity).toUpperCase()} Major Incident automatikus change-freeze`,ACTIVE_INCIDENT_STATUSES.includes(String(incident.status))
    ])).rows[0];
  if(freeze.status==='active')await db.query(`UPDATE resilience_emergency_change_overrides SET status='expired',updated_at=now() WHERE freeze_id=$1::uuid AND status='approved' AND expires_at<=now()`,[freeze.id]);
  return{session,freeze,services};
}

export async function syncResilienceRecoveryControl(){
  if(syncPromise)return syncPromise;
  syncPromise=(async()=>{
    await ensureResilienceRecoverySchema();
    const incidents=(await db.query(`SELECT * FROM major_incidents WHERE severity IN('sev1','sev2') AND status=ANY($1::text[]) ORDER BY declared_at`,[ACTIVE_INCIDENT_STATUSES])).rows;
    let sessions=0,freezes=0,closed=0;
    for(const incident of incidents){const seeded=await seedSession(incident);sessions++;if(seeded.freeze.status==='active')freezes++;
      if(['mitigating'].includes(String(incident.status)))await db.query(`UPDATE resilience_recovery_sessions SET status=CASE WHEN status='open' THEN 'recovering' ELSE status END,recovery_started_at=COALESCE(recovery_started_at,now()),updated_at=now() WHERE id=$1::uuid`,[seeded.session.id]);
      if(['monitoring','resolved'].includes(String(incident.status)))await db.query(`UPDATE resilience_recovery_sessions SET status=CASE WHEN status IN('open','recovering') THEN 'verifying' ELSE status END,verification_started_at=COALESCE(verification_started_at,now()),updated_at=now() WHERE id=$1::uuid`,[seeded.session.id]);
    }
    const finished=(await db.query(`SELECT rs.id::text,rs.incident_id::text,mi.status incident_status FROM resilience_recovery_sessions rs JOIN major_incidents mi ON mi.id=rs.incident_id WHERE mi.status IN('postmortem_closed','dismissed') AND rs.status<>'closed'`)).rows;
    for(const row of finished){
      if(row.incident_status==='dismissed'){
        await db.query(`UPDATE resilience_recovery_sessions SET status='closed',closed_at=now(),updated_at=now() WHERE id=$1::uuid`,[row.id]);
        await db.query(`UPDATE resilience_change_freezes SET status='lifted',lifted_at=now(),lifted_by='system-resilience',lift_reason='Major Incident elutasítva.',lift_evidence='{"description":"Incidens elutasítása miatt automatikus freeze feloldás."}'::jsonb,updated_at=now() WHERE incident_id=$1::uuid AND status='active'`,[row.incident_id]);closed++;
      }else if((await db.query(`SELECT status FROM resilience_recovery_sessions WHERE id=$1::uuid`,[row.id])).rows[0]?.status==='all_clear'){
        await db.query(`UPDATE resilience_recovery_sessions SET status='closed',closed_at=now(),updated_at=now() WHERE id=$1::uuid`,[row.id]);closed++;
      }
    }
    await db.query(`UPDATE resilience_emergency_change_overrides SET status='expired',updated_at=now() WHERE status='approved' AND expires_at<=now()`);
    return{active_incidents:incidents.length,sessions,active_freezes:freezes,closed,generated_at:new Date().toISOString()};
  })().finally(()=>{syncPromise=null});
  return syncPromise;
}

export async function resilienceRecoverySummary(locationId:string|null=null){
  await ensureResilienceRecoverySchema();
  const row=(await db.query(`SELECT
      COUNT(*) FILTER(WHERE rs.status IN('open','recovering','verifying'))::int active_sessions,
      COUNT(*) FILTER(WHERE cf.status='active')::int active_freezes,
      COUNT(*) FILTER(WHERE rs.status IN('open','recovering','verifying') AND mi.incident_commander_key IS NULL)::int commander_missing,
      COUNT(*) FILTER(WHERE rs.status IN('open','recovering','verifying') AND now()>mi.declared_at+(sp.rto_minutes||' minutes')::interval AND ss.state<>'verified')::int rto_breaches,
      COUNT(*) FILTER(WHERE ss.rpo_observed_minutes IS NOT NULL AND ss.rpo_observed_minutes>sp.rpo_minutes)::int rpo_breaches,
      COUNT(*) FILTER(WHERE ss.state<>'verified' AND rs.status IN('open','recovering','verifying'))::int unverified_services
    FROM resilience_recovery_sessions rs
    JOIN major_incidents mi ON mi.id=rs.incident_id
    LEFT JOIN resilience_change_freezes cf ON cf.incident_id=mi.id
    LEFT JOIN resilience_recovery_service_state ss ON ss.session_id=rs.id
    LEFT JOIN resilience_service_profiles sp ON sp.service_key=ss.service_key
    WHERE ($1::text IS NULL OR rs.location_id=$1 OR rs.location_id IS NULL)`,[locationId])).rows[0]||{};
  const pending=Number((await db.query(`SELECT COUNT(*)::int count FROM resilience_emergency_change_overrides o JOIN resilience_change_freezes f ON f.id=o.freeze_id JOIN major_incidents mi ON mi.id=f.incident_id WHERE o.status='pending' AND ($1::text IS NULL OR mi.location_id=$1 OR mi.location_id IS NULL)`,[locationId])).rows[0]?.count||0);
  return{...row,pending_overrides:pending,generated_at:new Date().toISOString()};
}

export async function listRecoverySessions(filters:any={}){
  await ensureResilienceRecoverySchema();const params:any[]=[];const where:string[]=[];const add=(sql:string,v:any)=>{params.push(v);where.push(sql.replace('?',`$${params.length}`))};
  if(filters.location_id)add("(rs.location_id=? OR rs.location_id IS NULL)",safe(filters.location_id));
  if(filters.status&&filters.status!=="all")add("rs.status=?",safe(filters.status));
  params.push(Math.max(20,Math.min(200,num(filters.limit)||100)));
  return(await db.query(`SELECT rs.*,mi.incident_no,mi.severity,mi.impact_score,mi.status incident_status,mi.title incident_title,mi.incident_commander_key,mi.incident_commander_name,
      cf.id freeze_id,cf.status freeze_status,
      COUNT(DISTINCT ss.service_key)::int service_count,COUNT(DISTINCT ss.service_key) FILTER(WHERE ss.state='verified')::int verified_services,
      COUNT(DISTINCT sr.step_key||':'||sr.service_key)::int step_count,COUNT(DISTINCT sr.step_key||':'||sr.service_key) FILTER(WHERE sr.status='completed')::int completed_steps
    FROM resilience_recovery_sessions rs JOIN major_incidents mi ON mi.id=rs.incident_id
    LEFT JOIN resilience_change_freezes cf ON cf.incident_id=mi.id LEFT JOIN resilience_recovery_service_state ss ON ss.session_id=rs.id LEFT JOIN resilience_recovery_step_runs sr ON sr.session_id=rs.id
    ${where.length?`WHERE ${where.join(' AND ')}`:''}
    GROUP BY rs.id,mi.id,cf.id ORDER BY CASE mi.severity WHEN 'sev1' THEN 0 ELSE 1 END,rs.started_at DESC LIMIT $${params.length}`,params)).rows;
}

export async function getRecoverySession(id:string){
  await ensureResilienceRecoverySchema();
  const item=(await db.query(`SELECT rs.*,mi.incident_no,mi.severity,mi.impact_score,mi.status incident_status,mi.title incident_title,mi.summary incident_summary,mi.incident_commander_key,mi.incident_commander_name,mi.declared_at,cf.id freeze_id,cf.status freeze_status,cf.scope freeze_scope,cf.reason freeze_reason,cf.activated_at,cf.lifted_at
    FROM resilience_recovery_sessions rs JOIN major_incidents mi ON mi.id=rs.incident_id LEFT JOIN resilience_change_freezes cf ON cf.incident_id=mi.id WHERE rs.id=$1::uuid`,[id])).rows[0];
  if(!item)throw Object.assign(new Error("A recovery session nem található."),{status:404});
  const services=(await db.query(`SELECT ss.*,sp.name,sp.criticality,sp.rto_minutes,sp.rpo_minutes,sp.owner_team,
      ROUND(EXTRACT(EPOCH FROM (COALESCE(ss.verified_at,now())-ss.impacted_at))/60.0,1) elapsed_minutes
    FROM resilience_recovery_service_state ss JOIN resilience_service_profiles sp ON sp.service_key=ss.service_key WHERE ss.session_id=$1::uuid ORDER BY CASE sp.criticality WHEN 'tier1' THEN 0 WHEN 'tier2' THEN 1 ELSE 2 END,sp.name`,[id])).rows;
  const steps=(await db.query(`SELECT sr.*,r.order_index,r.title,r.instruction,r.mandatory,r.verification_required,sp.name service_name FROM resilience_recovery_step_runs sr JOIN resilience_recovery_runbooks r ON r.service_key=sr.service_key AND r.step_key=sr.step_key JOIN resilience_service_profiles sp ON sp.service_key=sr.service_key WHERE sr.session_id=$1::uuid ORDER BY sp.name,r.order_index`,[id])).rows;
  const overrides=item.freeze_id?(await db.query(`SELECT * FROM resilience_emergency_change_overrides WHERE freeze_id=$1::uuid ORDER BY requested_at DESC`,[item.freeze_id])).rows:[];
  const events=(await db.query(`SELECT * FROM resilience_recovery_events WHERE session_id=$1::uuid ORDER BY created_at,id`,[id])).rows;
  return{item,services,steps,overrides,events};
}

export async function updateRecoveryServiceState(sessionId:string,serviceKey:string,input:any,actor:string){
  await ensureResilienceRecoverySchema();const state=safe(input.state);if(!['impacted','recovering','degraded','restored','verified'].includes(state))throw Object.assign(new Error("Érvénytelen recovery service státusz."),{status:400});
  const note=safe(input.verification_note);const evidence=input.evidence||{};
  if(state==='verified'&&(note.length<10||safe(evidence.description).length<5))throw Object.assign(new Error("Verifikált szolgáltatáshoz legalább 10 karakteres jegyzet és konkrét bizonyíték szükséges."),{status:400});
  const row=(await db.query(`UPDATE resilience_recovery_service_state SET state=$3,rpo_observed_minutes=$4,evidence=$5::jsonb,verification_note=$6,restored_at=CASE WHEN $3 IN('restored','verified') THEN COALESCE(restored_at,now()) ELSE restored_at END,verified_at=CASE WHEN $3='verified' THEN now() ELSE verified_at END,updated_by=$7,updated_at=now() WHERE session_id=$1::uuid AND service_key=$2 RETURNING *`,[sessionId,serviceKey,state,input.rpo_observed_minutes==null?null:num(input.rpo_observed_minutes),JSON.stringify(evidence),note||null,actor])).rows[0];
  if(!row)throw Object.assign(new Error("A recovery szolgáltatás nem található."),{status:404});
  const incident=(await db.query(`SELECT incident_id::text FROM resilience_recovery_sessions WHERE id=$1::uuid`,[sessionId])).rows[0];await event(sessionId,incident?.incident_id||null,"service_state_changed",actor,`${serviceKey} recovery állapot: ${state}.`,{service_key:serviceKey,state,rpo_observed_minutes:row.rpo_observed_minutes,evidence});return row;
}

export async function updateRecoveryStep(sessionId:string,serviceKey:string,stepKey:string,input:any,actor:string){
  await ensureResilienceRecoverySchema();const status=safe(input.status);if(!['pending','in_progress','completed','skipped'].includes(status))throw Object.assign(new Error("Érvénytelen recovery step státusz."),{status:400});
  const evidence=input.evidence||{};if(status==='completed'&&safe(evidence.description).length<5)throw Object.assign(new Error("Recovery step lezárásához konkrét bizonyíték szükséges."),{status:400});
  const row=(await db.query(`UPDATE resilience_recovery_step_runs SET status=$4,owner_key=$5,note=$6,evidence=$7::jsonb,started_at=CASE WHEN $4='in_progress' THEN COALESCE(started_at,now()) ELSE started_at END,completed_at=CASE WHEN $4='completed' THEN now() ELSE completed_at END,updated_by=$8,updated_at=now() WHERE session_id=$1::uuid AND service_key=$2 AND step_key=$3 RETURNING *`,[sessionId,serviceKey,stepKey,status,safe(input.owner_key)||null,safe(input.note)||null,JSON.stringify(evidence),actor])).rows[0];
  if(!row)throw Object.assign(new Error("A recovery step nem található."),{status:404});const incident=(await db.query(`SELECT incident_id::text FROM resilience_recovery_sessions WHERE id=$1::uuid`,[sessionId])).rows[0];await event(sessionId,incident?.incident_id||null,"runbook_step_changed",actor,`${serviceKey}/${stepKey}: ${status}.`,{service_key:serviceKey,step_key:stepKey,status,evidence});return row;
}

export async function declareRecoveryAllClear(sessionId:string,input:any,actor:string){
  await ensureResilienceRecoverySchema();const detail=await getRecoverySession(sessionId);const note=safe(input.note),evidence=input.evidence||{};
  if(!safe(detail.item.incident_commander_key))throw Object.assign(new Error("All Clear csak kijelölt Incident Commander mellett adható."),{status:409});
  if(note.length<10||safe(evidence.description).length<5)throw Object.assign(new Error("All Clear indok és konkrét bizonyíték szükséges."),{status:400});
  const mandatoryOpen=Number((await db.query(`SELECT COUNT(*)::int count FROM resilience_recovery_step_runs sr JOIN resilience_recovery_runbooks r ON r.service_key=sr.service_key AND r.step_key=sr.step_key WHERE sr.session_id=$1::uuid AND r.mandatory=true AND sr.status<>'completed'`,[sessionId])).rows[0]?.count||0);
  const unverified=Number((await db.query(`SELECT COUNT(*)::int count FROM resilience_recovery_service_state WHERE session_id=$1::uuid AND state<>'verified'`,[sessionId])).rows[0]?.count||0);
  const openActions=Number((await db.query(`SELECT COUNT(*)::int count FROM major_incident_actions a WHERE a.incident_id=$1::uuid AND a.status IN('open','in_progress') AND a.priority IN('critical','high')`,[detail.item.incident_id])).rows[0]?.count||0);
  if(mandatoryOpen||unverified||openActions)throw Object.assign(new Error(`All Clear blokkolva: ${mandatoryOpen} kötelező recovery step, ${unverified} nem verifikált szolgáltatás és ${openActions} kritikus/magas War Room akció maradt.`),{status:409});
  const maxRpo=Number((await db.query(`SELECT COALESCE(MAX(rpo_observed_minutes),0) value FROM resilience_recovery_service_state WHERE session_id=$1::uuid`,[sessionId])).rows[0]?.value||0);
  const row=(await db.query(`UPDATE resilience_recovery_sessions SET status='all_clear',all_clear_at=now(),actual_rto_minutes=ROUND(EXTRACT(EPOCH FROM (now()-$2::timestamptz))/60.0,2),max_observed_rpo_minutes=$3,all_clear_note=$4,all_clear_evidence=$5::jsonb,updated_at=now() WHERE id=$1::uuid RETURNING *`,[sessionId,detail.item.declared_at,maxRpo,note,JSON.stringify(evidence)])).rows[0];
  await db.query(`UPDATE resilience_change_freezes SET status='lifted',lifted_at=now(),lifted_by=$2,lift_reason=$3,lift_evidence=$4::jsonb,updated_at=now() WHERE incident_id=$1::uuid AND status='active'`,[detail.item.incident_id,actor,note,JSON.stringify(evidence)]);
  await event(sessionId,detail.item.incident_id,"all_clear",actor,"Recovery All Clear jóváhagyva; change-freeze feloldva.",{note,evidence,actual_rto_minutes:row.actual_rto_minutes,max_observed_rpo_minutes:maxRpo});return row;
}

export async function listResilienceServiceProfiles(){await ensureResilienceRecoverySchema();return(await db.query(`SELECT * FROM resilience_service_profiles ORDER BY CASE criticality WHEN 'tier1' THEN 0 WHEN 'tier2' THEN 1 ELSE 2 END,name`)).rows}
export async function updateResilienceServiceProfile(serviceKey:string,input:any,actor:string){await ensureResilienceRecoverySchema();const rto=Math.max(1,num(input.rto_minutes)),rpo=Math.max(0,num(input.rpo_minutes));const row=(await db.query(`UPDATE resilience_service_profiles SET name=COALESCE(NULLIF($2,''),name),criticality=CASE WHEN $3=ANY(ARRAY['tier1','tier2','tier3']) THEN $3 ELSE criticality END,rto_minutes=$4,rpo_minutes=$5,owner_team=$6,enabled=COALESCE($7,enabled),updated_by=$8,updated_at=now() WHERE service_key=$1 RETURNING *`,[serviceKey,safe(input.name),safe(input.criticality),rto,rpo,safe(input.owner_team)||null,input.enabled===undefined?null:Boolean(input.enabled),actor])).rows[0];if(!row)throw Object.assign(new Error("A resilience szolgáltatás nem található."),{status:404});return row}

export async function requestEmergencyChangeOverride(freezeId:string,input:any,actor:string){
  await ensureResilienceRecoverySchema();const releaseRef=safe(input.release_ref),reason=safe(input.reason),evidence=input.evidence||{};const minutes=Math.max(15,Math.min(120,num(input.duration_minutes)||60));
  if(releaseRef.length<7||reason.length<10||safe(evidence.description).length<5)throw Object.assign(new Error("Emergency override kéréshez release ref, legalább 10 karakteres indok és konkrét evidence szükséges."),{status:400});
  const freeze=(await db.query(`SELECT * FROM resilience_change_freezes WHERE id=$1::uuid AND status='active'`,[freezeId])).rows[0];if(!freeze)throw Object.assign(new Error("Aktív change-freeze nem található."),{status:404});
  const row=(await db.query(`INSERT INTO resilience_emergency_change_overrides(freeze_id,release_ref,scope,reason,requested_by,expires_at,evidence) VALUES($1::uuid,$2,$3::jsonb,$4,$5,now()+($6::text||' minutes')::interval,$7::jsonb) RETURNING *`,[freezeId,releaseRef,JSON.stringify(input.scope||freeze.scope||{}),reason,actor,minutes,JSON.stringify(evidence)])).rows[0];
  const session=(await db.query(`SELECT rs.id::text,rs.incident_id::text FROM resilience_recovery_sessions rs JOIN resilience_change_freezes f ON f.incident_id=rs.incident_id WHERE f.id=$1::uuid`,[freezeId])).rows[0];await event(session?.id||null,session?.incident_id||null,"emergency_override_requested",actor,`Emergency change override kérve ${releaseRef} release-hez.`,{override_id:row.id,release_ref:releaseRef,expires_at:row.expires_at});return row;
}

export async function decideEmergencyChangeOverride(freezeId:string,overrideId:string,input:any,actor:string){
  await ensureResilienceRecoverySchema();const decision=safe(input.decision);if(!['approved','rejected'].includes(decision))throw Object.assign(new Error("A döntés approved vagy rejected lehet."),{status:400});const evidence=input.evidence||{};if(safe(input.note).length<5)throw Object.assign(new Error("A döntéshez legalább 5 karakteres indok szükséges."),{status:400});
  const before=(await db.query(`SELECT * FROM resilience_emergency_change_overrides WHERE id=$1::uuid AND freeze_id=$2::uuid`,[overrideId,freezeId])).rows[0];if(!before)throw Object.assign(new Error("Az override kérés nem található."),{status:404});if(before.status!=='pending')throw Object.assign(new Error("Az override kérés már elbírált."),{status:409});if(String(before.requested_by).toLowerCase()===actor.toLowerCase())throw Object.assign(new Error("A kérelmező nem hagyhatja jóvá a saját emergency override kérését."),{status:409});if(decision==='approved'&&safe(evidence.description).length<5)throw Object.assign(new Error("Jóváhagyáshoz konkrét approval evidence szükséges."),{status:400});
  const row=(await db.query(`UPDATE resilience_emergency_change_overrides SET status=$3,approved_by=CASE WHEN $3='approved' THEN $4 ELSE approved_by END,approved_at=CASE WHEN $3='approved' THEN now() ELSE approved_at END,evidence=CASE WHEN $3='approved' THEN $5::jsonb ELSE evidence END,decision_note=$6,updated_at=now() WHERE id=$1::uuid AND freeze_id=$2::uuid RETURNING *`,[overrideId,freezeId,decision,actor,JSON.stringify(evidence),safe(input.note)])).rows[0];
  const session=(await db.query(`SELECT rs.id::text,rs.incident_id::text FROM resilience_recovery_sessions rs JOIN resilience_change_freezes f ON f.incident_id=rs.incident_id WHERE f.id=$1::uuid`,[freezeId])).rows[0];await event(session?.id||null,session?.incident_id||null,"emergency_override_decided",actor,`Emergency change override ${decision}: ${before.release_ref}.`,{override_id:row.id,release_ref:before.release_ref,decision,evidence});return row;
}

export function startResilienceRecoveryScheduler(){if(started||process.env.EXCEPTION_CENTER_DISABLED==='1'||process.env.NODE_ENV==='test')return;started=true;cron.schedule('*/3 * * * *',()=>{void syncResilienceRecoveryControl().catch(error=>console.error('[resilience] scheduled sync failed',error))},{timezone:TZ});setTimeout(()=>void syncResilienceRecoveryControl().catch(error=>console.error('[resilience] initial sync failed',error)),90_000)}
