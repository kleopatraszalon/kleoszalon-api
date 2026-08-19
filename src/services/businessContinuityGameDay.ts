import cron from "node-cron";
import db from "../db";
import {ensureResilienceRecoverySchema} from "./resilienceRecoveryControl";

const TZ="Europe/Budapest";
let schemaPromise:Promise<void>|null=null;
let schedulerStarted=false;
const safe=(v:unknown)=>String(v??"").trim();
const num=(v:unknown)=>{const n=Number(v??0);return Number.isFinite(n)?n:0};
const arr=(v:unknown)=>Array.isArray(v)?v.map(x=>safe(x)).filter(Boolean):[];

const DEFAULT_TEMPLATES=[
 {code:"backup_restore",name:"Backup / Restore GameDay",description:"Adatbázis-mentés, izolált restore, adatintegritás és üzleti verifikáció próbája.",services:["postgresql","vir-core"],frequency:90,injects:[{offset:0,title:"Restore indítás",instruction:"Indítsd el a jóváhagyott izolált restore-eljárást.",severity:"warning"},{offset:15,title:"Integritási ellenőrzés",instruction:"Bizonyítsd a helyreállított adatbázis konzisztenciáját reprezentatív üzleti adatokkal.",severity:"critical"}]},
 {code:"database_outage",name:"PostgreSQL kiesés GameDay",description:"Adatbázis-kiesés üzleti hatásának, helyreállításának és RTO/RPO céljainak gyakorlata.",services:["postgresql","vir-core","booking","cashier","finance-nav"],frequency:90,injects:[{offset:0,title:"DB unavailable",instruction:"Szimuláld az adatbázis elérhetetlenségét papíron; valódi szolgáltatást ne állíts le.",severity:"critical"},{offset:10,title:"Write safety",instruction:"Igazold a fail-closed és adatintegritási védelmi döntést.",severity:"critical"}]},
 {code:"finance_nav_degraded",name:"Pénzügy / NAV degradáció GameDay",description:"Számlázás, NAV queue és pénzügyi integritás degradált működésének gyakorlata.",services:["finance-nav","postgresql","vir-core","cashier"],frequency:120,injects:[{offset:0,title:"NAV kapcsolat hibás",instruction:"Szimuláld a NAV kommunikációs hibát és rögzítsd a kontrollált queue/fail-closed döntést.",severity:"critical"},{offset:20,title:"Újraküldés",instruction:"Mutasd be az idempotens újraküldési és auditlánc-ellenőrzést.",severity:"warning"}]},
 {code:"cashier_outage",name:"Pénztár kiesés GameDay",description:"Checkout/pénztári kiesés esetén szükséges üzleti folytonossági és visszaállási eljárás.",services:["cashier","vir-core","postgresql","finance-nav"],frequency:120,injects:[{offset:0,title:"Checkout unavailable",instruction:"Szimuláld a checkout kiesést és dokumentáld az engedélyezett fallback üzleti folyamatot.",severity:"critical"}]},
 {code:"booking_outage",name:"Foglalási rendszer kiesés GameDay",description:"Foglalás és munkalap szolgáltatás kiesési és helyreállítási gyakorlata.",services:["booking","vir-core","postgresql","communications"],frequency:120,injects:[{offset:0,title:"Foglalás elérhetetlen",instruction:"Szimuláld a foglalási front kiesést és rögzítsd az ügyfélkommunikációs tervet.",severity:"critical"}]},
 {code:"communications_outage",name:"Kommunikációs csatorna kiesés GameDay",description:"E-mail, push és panaszcsatorna kiesési helyzetének gyakorlata.",services:["communications","vir-core"],frequency:180,injects:[{offset:0,title:"Kommunikációs szolgáltató kiesés",instruction:"Szimuláld a szolgáltató kiesést és válassz alternatív vezetői/ügyfélkommunikációs csatornát.",severity:"warning"}]},
 {code:"full_continuity",name:"Teljes üzletmenet-folytonossági GameDay",description:"Tier-1 és kiválasztott Tier-2 szolgáltatások integrált, vezetői üzletmenet-folytonossági gyakorlata.",services:[],frequency:180,injects:[{offset:0,title:"Komplex szolgáltatásromlás",instruction:"Szimulált több-szolgáltatásos kiesés; Incident Commander szerepkör, prioritások és függőségek rögzítése.",severity:"critical"},{offset:20,title:"Másodlagos hiba",instruction:"Szimulálj kommunikációs vagy pénzügyi másodlagos hibát és rögzítsd a döntést.",severity:"warning"},{offset:40,title:"Recovery verification",instruction:"Kérj üzleti és technikai end-to-end verifikációt minden Tier-1 szolgáltatásra.",severity:"critical"}]}
];

export function ensureBusinessContinuityGameDaySchema(){
 if(!schemaPromise){schemaPromise=(async()=>{
  await ensureResilienceRecoverySchema();
  await db.query(`
   CREATE TABLE IF NOT EXISTS continuity_drill_templates(
    code text PRIMARY KEY,name text NOT NULL,description text NOT NULL,
    default_service_keys text[] NOT NULL DEFAULT '{}'::text[],injects jsonb NOT NULL DEFAULT '[]'::jsonb,
    frequency_days integer NOT NULL DEFAULT 180 CHECK(frequency_days BETWEEN 30 AND 730),active boolean NOT NULL DEFAULT true,
    updated_at timestamptz NOT NULL DEFAULT now()
   );
   CREATE TABLE IF NOT EXISTS continuity_service_drill_policy(
    service_key text PRIMARY KEY REFERENCES resilience_service_profiles(service_key) ON DELETE CASCADE,
    required boolean NOT NULL DEFAULT true,frequency_days integer NOT NULL CHECK(frequency_days BETWEEN 30 AND 730),
    updated_by text,updated_at timestamptz NOT NULL DEFAULT now()
   );
   INSERT INTO continuity_service_drill_policy(service_key,frequency_days)
   SELECT service_key,CASE criticality WHEN 'tier1' THEN 90 WHEN 'tier2' THEN 180 ELSE 365 END
   FROM resilience_service_profiles WHERE enabled=true ON CONFLICT(service_key) DO NOTHING;

   CREATE TABLE IF NOT EXISTS continuity_drills(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    drill_no text NOT NULL UNIQUE DEFAULT ('GD-'||to_char(now(),'YYYYMMDD-HH24MISS')||'-'||substr(gen_random_uuid()::text,1,6)),
    template_code text REFERENCES continuity_drill_templates(code),title text NOT NULL,objective text NOT NULL,
    location_id text,status text NOT NULL DEFAULT 'planned' CHECK(status IN('planned','running','verifying','completed','cancelled')),
    planned_start_at timestamptz NOT NULL,started_at timestamptz,verification_started_at timestamptz,completed_at timestamptz,cancelled_at timestamptz,
    owner_key text NOT NULL,approver_key text,overall_score numeric(5,2),result text CHECK(result IS NULL OR result IN('pass','conditional','fail')),
    completion_note text,completion_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,cancel_reason text,
    created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
   );
   CREATE INDEX IF NOT EXISTS continuity_drills_status_idx ON continuity_drills(status,planned_start_at DESC);

   CREATE TABLE IF NOT EXISTS continuity_drill_services(
    drill_id uuid NOT NULL REFERENCES continuity_drills(id) ON DELETE CASCADE,
    service_key text NOT NULL REFERENCES resilience_service_profiles(service_key),
    service_name text NOT NULL,criticality text NOT NULL,target_rto_minutes integer NOT NULL,target_rpo_minutes integer NOT NULL,
    observed_rto_minutes numeric(12,2),observed_rpo_minutes numeric(12,2),
    state text NOT NULL DEFAULT 'planned' CHECK(state IN('planned','impacted','recovering','restored','verified')),
    started_at timestamptz,restored_at timestamptz,verified_at timestamptz,verification_note text,evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_by text,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(drill_id,service_key)
   );

   CREATE TABLE IF NOT EXISTS continuity_drill_steps(
    drill_id uuid NOT NULL REFERENCES continuity_drills(id) ON DELETE CASCADE,service_key text NOT NULL,step_key text NOT NULL,
    order_index integer NOT NULL,title text NOT NULL,instruction text NOT NULL,mandatory boolean NOT NULL DEFAULT true,
    status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','in_progress','completed','skipped')),
    owner_key text,note text,evidence jsonb NOT NULL DEFAULT '{}'::jsonb,started_at timestamptz,completed_at timestamptz,updated_by text,updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(drill_id,service_key,step_key)
   );

   CREATE TABLE IF NOT EXISTS continuity_drill_injects(
    id bigserial PRIMARY KEY,drill_id uuid NOT NULL REFERENCES continuity_drills(id) ON DELETE CASCADE,sequence_no integer NOT NULL,
    scheduled_offset_minutes integer NOT NULL DEFAULT 0,title text NOT NULL,instruction text NOT NULL,
    severity text NOT NULL DEFAULT 'warning' CHECK(severity IN('info','warning','critical')),
    status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','released','acknowledged')),
    released_at timestamptz,acknowledged_at timestamptz,response_note text,evidence jsonb NOT NULL DEFAULT '{}'::jsonb,updated_by text,updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(drill_id,sequence_no)
   );

   CREATE TABLE IF NOT EXISTS continuity_drill_actions(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),drill_id uuid NOT NULL REFERENCES continuity_drills(id) ON DELETE CASCADE,
    source_key text NOT NULL,priority text NOT NULL CHECK(priority IN('critical','high','medium','low')),
    title text NOT NULL,description text NOT NULL,status text NOT NULL DEFAULT 'open' CHECK(status IN('open','in_progress','completed','accepted')),
    owner_key text,due_at timestamptz,completed_at timestamptz,accepted_at timestamptz,evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(drill_id,source_key)
   );

   CREATE TABLE IF NOT EXISTS continuity_drill_events(
    id bigserial PRIMARY KEY,drill_id uuid NOT NULL REFERENCES continuity_drills(id) ON DELETE CASCADE,
    event_type text NOT NULL,actor_key text NOT NULL,message text NOT NULL,evidence jsonb NOT NULL DEFAULT '{}'::jsonb,created_at timestamptz NOT NULL DEFAULT now()
   );
   CREATE INDEX IF NOT EXISTS continuity_drill_events_idx ON continuity_drill_events(drill_id,created_at,id);

   CREATE OR REPLACE FUNCTION kleo_continuity_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN RAISE EXCEPTION 'continuity_drill_events is append-only'; END $$;
   DROP TRIGGER IF EXISTS trg_kleo_continuity_event_immutable ON continuity_drill_events;
   CREATE TRIGGER trg_kleo_continuity_event_immutable BEFORE UPDATE OR DELETE ON continuity_drill_events FOR EACH ROW EXECUTE FUNCTION kleo_continuity_event_immutable();

   CREATE OR REPLACE FUNCTION kleo_continuity_step_guard() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
    IF NEW.status='completed' AND length(trim(COALESCE(NEW.evidence->>'description','')))<5 THEN
      RAISE EXCEPTION 'GameDay step completion evidence is required' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
   END $$;
   DROP TRIGGER IF EXISTS trg_kleo_continuity_step_guard ON continuity_drill_steps;
   CREATE TRIGGER trg_kleo_continuity_step_guard BEFORE INSERT OR UPDATE OF status,evidence ON continuity_drill_steps FOR EACH ROW EXECUTE FUNCTION kleo_continuity_step_guard();

   CREATE OR REPLACE FUNCTION kleo_continuity_service_guard() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
    IF NEW.state='verified' AND (length(trim(COALESCE(NEW.verification_note,'')))<10 OR length(trim(COALESCE(NEW.evidence->>'description','')))<5) THEN
      RAISE EXCEPTION 'GameDay service verification note and evidence are required' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
   END $$;
   DROP TRIGGER IF EXISTS trg_kleo_continuity_service_guard ON continuity_drill_services;
   CREATE TRIGGER trg_kleo_continuity_service_guard BEFORE INSERT OR UPDATE OF state,verification_note,evidence ON continuity_drill_services FOR EACH ROW EXECUTE FUNCTION kleo_continuity_service_guard();

   CREATE OR REPLACE FUNCTION kleo_continuity_completion_guard() RETURNS trigger LANGUAGE plpgsql AS $$
   DECLARE open_steps integer;unverified integer;unacked integer;
   BEGIN
    IF NEW.status='completed' THEN
      IF NULLIF(trim(COALESCE(NEW.approver_key,'')),'') IS NULL OR lower(trim(NEW.approver_key))=lower(trim(NEW.owner_key)) THEN
        RAISE EXCEPTION 'GameDay completion requires independent approver' USING ERRCODE='23514';
      END IF;
      IF length(trim(COALESCE(NEW.completion_note,'')))<10 OR length(trim(COALESCE(NEW.completion_evidence->>'description','')))<5 THEN
        RAISE EXCEPTION 'GameDay completion note and evidence are required' USING ERRCODE='23514';
      END IF;
      SELECT COUNT(*)::int INTO open_steps FROM continuity_drill_steps WHERE drill_id=NEW.id AND mandatory=true AND status<>'completed';
      SELECT COUNT(*)::int INTO unverified FROM continuity_drill_services WHERE drill_id=NEW.id AND state<>'verified';
      SELECT COUNT(*)::int INTO unacked FROM continuity_drill_injects WHERE drill_id=NEW.id AND status<>'acknowledged';
      IF open_steps>0 OR unverified>0 OR unacked>0 THEN RAISE EXCEPTION 'GameDay completion blocked: mandatory evidence remains' USING ERRCODE='23514'; END IF;
    END IF;
    RETURN NEW;
   END $$;
   DROP TRIGGER IF EXISTS trg_kleo_continuity_completion_guard ON continuity_drills;
   CREATE TRIGGER trg_kleo_continuity_completion_guard BEFORE UPDATE OF status,approver_key,completion_note,completion_evidence ON continuity_drills FOR EACH ROW EXECUTE FUNCTION kleo_continuity_completion_guard();
  `);
  for(const t of DEFAULT_TEMPLATES){await db.query(`INSERT INTO continuity_drill_templates(code,name,description,default_service_keys,injects,frequency_days) VALUES($1,$2,$3,$4::text[],$5::jsonb,$6) ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,default_service_keys=EXCLUDED.default_service_keys,injects=EXCLUDED.injects,frequency_days=EXCLUDED.frequency_days,active=true,updated_at=now()`,[t.code,t.name,t.description,t.services,JSON.stringify(t.injects),t.frequency])}
 })().catch(error=>{schemaPromise=null;throw error})}
 return schemaPromise;
}

async function event(drillId:string,type:string,actor:string,message:string,evidence:any={}){await db.query(`INSERT INTO continuity_drill_events(drill_id,event_type,actor_key,message,evidence) VALUES($1::uuid,$2,$3,$4,$5::jsonb)`,[drillId,type,actor,message,JSON.stringify(evidence||{})])}

export async function listGameDayTemplates(){await ensureBusinessContinuityGameDaySchema();return(await db.query(`SELECT * FROM continuity_drill_templates WHERE active=true ORDER BY name`)).rows}
export async function listGameDayPolicies(){await ensureBusinessContinuityGameDaySchema();return(await db.query(`SELECT p.*,sp.name,sp.criticality,sp.rto_minutes,sp.rpo_minutes,
 (SELECT MAX(d.completed_at) FROM continuity_drills d JOIN continuity_drill_services s ON s.drill_id=d.id WHERE s.service_key=p.service_key AND d.status='completed' AND d.result='pass') last_pass_at
 FROM continuity_service_drill_policy p JOIN resilience_service_profiles sp ON sp.service_key=p.service_key WHERE sp.enabled=true ORDER BY CASE sp.criticality WHEN 'tier1' THEN 0 WHEN 'tier2' THEN 1 ELSE 2 END,sp.name`)).rows.map((x:any)=>{const last=x.last_pass_at?new Date(x.last_pass_at):null;const due=last?new Date(last.getTime()+Number(x.frequency_days)*86400000):null;const days=due?Math.ceil((due.getTime()-Date.now())/86400000):null;return{...x,next_due_at:due?.toISOString()||null,days_until_due:days,readiness:!x.required?'optional':!last?'never':(days!<0?'overdue':days!<=30?'due':'ok')}})}

export async function gameDaySummary(locationId:string|null=null){await ensureBusinessContinuityGameDaySchema();const row=(await db.query(`SELECT
 COUNT(*) FILTER(WHERE status='planned')::int planned,
 COUNT(*) FILTER(WHERE status IN('running','verifying'))::int active,
 COUNT(*) FILTER(WHERE status='planned' AND planned_start_at<now())::int overdue_planned,
 COUNT(*) FILTER(WHERE status='completed' AND completed_at>=now()-interval '90 days')::int completed_90d,
 ROUND(AVG(overall_score) FILTER(WHERE status='completed' AND completed_at>=now()-interval '90 days'),1) avg_score_90d,
 ROUND(100.0*COUNT(*) FILTER(WHERE status='completed' AND result='pass' AND completed_at>=now()-interval '90 days')/NULLIF(COUNT(*) FILTER(WHERE status='completed' AND completed_at>=now()-interval '90 days'),0),1) pass_rate_90d
 FROM continuity_drills WHERE ($1::text IS NULL OR location_id=$1 OR location_id IS NULL)`,[locationId])).rows[0]||{};const actions=Number((await db.query(`SELECT COUNT(*)::int count FROM continuity_drill_actions a JOIN continuity_drills d ON d.id=a.drill_id WHERE a.status IN('open','in_progress') AND ($1::text IS NULL OR d.location_id=$1 OR d.location_id IS NULL)`,[locationId])).rows[0]?.count||0);const policies=await listGameDayPolicies();return{...row,open_actions:actions,overdue_services:policies.filter((x:any)=>x.readiness==='overdue'||x.readiness==='never').length,due_services:policies.filter((x:any)=>x.readiness==='due').length,generated_at:new Date().toISOString()}}

export async function createGameDay(input:any,actor:string){await ensureBusinessContinuityGameDaySchema();const templateCode=safe(input.template_code);const template=(await db.query(`SELECT * FROM continuity_drill_templates WHERE code=$1 AND active=true`,[templateCode])).rows[0];if(!template)throw Object.assign(new Error("A GameDay sablon nem található."),{status:400});const title=safe(input.title)||template.name;const objective=safe(input.objective);const owner=safe(input.owner_key)||actor;if(objective.length<10)throw Object.assign(new Error("A GameDay célját legalább 10 karakterben rögzíteni kell."),{status:400});const planned=new Date(input.planned_start_at||Date.now());if(Number.isNaN(planned.getTime()))throw Object.assign(new Error("Érvénytelen tervezett kezdési idő."),{status:400});let services=arr(input.service_keys);if(!services.length)services=Array.isArray(template.default_service_keys)?template.default_service_keys:[];if(!services.length)services=(await db.query(`SELECT service_key FROM resilience_service_profiles WHERE enabled=true AND criticality IN('tier1','tier2') ORDER BY criticality,service_key`)).rows.map((x:any)=>x.service_key);const profiles=(await db.query(`SELECT * FROM resilience_service_profiles WHERE enabled=true AND service_key=ANY($1::text[])`,[services])).rows;if(!profiles.length)throw Object.assign(new Error("A GameDay-hez nincs érvényes szolgáltatás."),{status:400});const drill=(await db.query(`INSERT INTO continuity_drills(template_code,title,objective,location_id,planned_start_at,owner_key,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[templateCode,title,objective,safe(input.location_id)||null,planned.toISOString(),owner,actor])).rows[0];for(const p of profiles){await db.query(`INSERT INTO continuity_drill_services(drill_id,service_key,service_name,criticality,target_rto_minutes,target_rpo_minutes) VALUES($1::uuid,$2,$3,$4,$5,$6)`,[drill.id,p.service_key,p.name,p.criticality,p.rto_minutes,p.rpo_minutes]);await db.query(`INSERT INTO continuity_drill_steps(drill_id,service_key,step_key,order_index,title,instruction,mandatory)
 SELECT $1::uuid,r.service_key,r.step_key,r.order_index,r.title,r.instruction,r.mandatory FROM resilience_recovery_runbooks r WHERE r.service_key=$2 AND r.active=true`,[drill.id,p.service_key])}const injects=Array.isArray(template.injects)?template.injects:[];for(let i=0;i<injects.length;i++){const x=injects[i]||{};await db.query(`INSERT INTO continuity_drill_injects(drill_id,sequence_no,scheduled_offset_minutes,title,instruction,severity) VALUES($1::uuid,$2,$3,$4,$5,$6)`,[drill.id,i+1,Math.max(0,num(x.offset)),safe(x.title)||`Inject ${i+1}`,safe(x.instruction)||"Szimulációs inject",['info','warning','critical'].includes(safe(x.severity))?safe(x.severity):'warning'])}await event(drill.id,"drill_planned",actor,`${drill.drill_no} GameDay megtervezve.`,{template_code:templateCode,services:profiles.map((x:any)=>x.service_key),planned_start_at:drill.planned_start_at,simulation_only:true});return getGameDay(drill.id)}

export async function listGameDays(filters:any={}){await ensureBusinessContinuityGameDaySchema();const params:any[]=[];const where:string[]=[];const add=(sql:string,v:any)=>{params.push(v);where.push(sql.replace('?',`$${params.length}`))};if(filters.location_id)add("(d.location_id=? OR d.location_id IS NULL)",safe(filters.location_id));if(filters.status&&filters.status!=='all')add("d.status=?",safe(filters.status));params.push(Math.max(20,Math.min(200,num(filters.limit)||100)));return(await db.query(`SELECT d.*,t.name template_name,COUNT(DISTINCT s.service_key)::int service_count,COUNT(DISTINCT s.service_key) FILTER(WHERE s.state='verified')::int verified_services,COUNT(DISTINCT a.id) FILTER(WHERE a.status IN('open','in_progress'))::int open_actions FROM continuity_drills d LEFT JOIN continuity_drill_templates t ON t.code=d.template_code LEFT JOIN continuity_drill_services s ON s.drill_id=d.id LEFT JOIN continuity_drill_actions a ON a.drill_id=d.id ${where.length?`WHERE ${where.join(' AND ')}`:''} GROUP BY d.id,t.name ORDER BY CASE d.status WHEN 'running' THEN 0 WHEN 'verifying' THEN 1 WHEN 'planned' THEN 2 ELSE 3 END,d.planned_start_at DESC LIMIT $${params.length}`,params)).rows}

export async function getGameDay(id:string){await ensureBusinessContinuityGameDaySchema();const item=(await db.query(`SELECT d.*,t.name template_name,t.description template_description FROM continuity_drills d LEFT JOIN continuity_drill_templates t ON t.code=d.template_code WHERE d.id=$1::uuid`,[id])).rows[0];if(!item)throw Object.assign(new Error("A GameDay nem található."),{status:404});const services=(await db.query(`SELECT * FROM continuity_drill_services WHERE drill_id=$1::uuid ORDER BY CASE criticality WHEN 'tier1' THEN 0 WHEN 'tier2' THEN 1 ELSE 2 END,service_name`,[id])).rows;const steps=(await db.query(`SELECT * FROM continuity_drill_steps WHERE drill_id=$1::uuid ORDER BY service_key,order_index`,[id])).rows;const injects=(await db.query(`SELECT * FROM continuity_drill_injects WHERE drill_id=$1::uuid ORDER BY sequence_no`,[id])).rows;const actions=(await db.query(`SELECT * FROM continuity_drill_actions WHERE drill_id=$1::uuid ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,created_at`,[id])).rows;const events=(await db.query(`SELECT * FROM continuity_drill_events WHERE drill_id=$1::uuid ORDER BY created_at,id`,[id])).rows;return{item,services,steps,injects,actions,events}}

export async function startGameDay(id:string,actor:string){await ensureBusinessContinuityGameDaySchema();const row=(await db.query(`UPDATE continuity_drills SET status='running',started_at=COALESCE(started_at,now()),updated_at=now() WHERE id=$1::uuid AND status='planned' RETURNING *`,[id])).rows[0];if(!row)throw Object.assign(new Error("Csak tervezett GameDay indítható."),{status:409});await db.query(`UPDATE continuity_drill_services SET state='impacted',started_at=COALESCE(started_at,now()),updated_by=$2,updated_at=now() WHERE drill_id=$1::uuid`,[id,actor]);await event(id,"drill_started",actor,"GameDay szimuláció elindítva.",{simulation_only:true});return getGameDay(id)}
export async function beginGameDayVerification(id:string,actor:string){await ensureBusinessContinuityGameDaySchema();const pending=Number((await db.query(`SELECT COUNT(*)::int count FROM continuity_drill_injects WHERE drill_id=$1::uuid AND status='pending'`,[id])).rows[0]?.count||0);if(pending)throw Object.assign(new Error(`A verifikáció előtt ${pending} inject még nincs kiadva.`),{status:409});const row=(await db.query(`UPDATE continuity_drills SET status='verifying',verification_started_at=COALESCE(verification_started_at,now()),updated_at=now() WHERE id=$1::uuid AND status='running' RETURNING *`,[id])).rows[0];if(!row)throw Object.assign(new Error("Csak futó GameDay vihető verifikációba."),{status:409});await event(id,"verification_started",actor,"GameDay verifikáció megkezdve.");return getGameDay(id)}

export async function updateGameDayService(id:string,serviceKey:string,input:any,actor:string){await ensureBusinessContinuityGameDaySchema();const state=safe(input.state);if(!['planned','impacted','recovering','restored','verified'].includes(state))throw Object.assign(new Error("Érvénytelen GameDay service állapot."),{status:400});const note=safe(input.verification_note),evidence=input.evidence||{};if(state==='verified'&&(note.length<10||safe(evidence.description).length<5))throw Object.assign(new Error("Verifikációhoz legalább 10 karakteres jegyzet és konkrét evidence szükséges."),{status:400});const row=(await db.query(`UPDATE continuity_drill_services SET state=$3,observed_rto_minutes=$4,observed_rpo_minutes=$5,verification_note=$6,evidence=$7::jsonb,restored_at=CASE WHEN $3 IN('restored','verified') THEN COALESCE(restored_at,now()) ELSE restored_at END,verified_at=CASE WHEN $3='verified' THEN now() ELSE verified_at END,updated_by=$8,updated_at=now() WHERE drill_id=$1::uuid AND service_key=$2 RETURNING *`,[id,serviceKey,state,input.observed_rto_minutes==null?null:num(input.observed_rto_minutes),input.observed_rpo_minutes==null?null:num(input.observed_rpo_minutes),note||null,JSON.stringify(evidence),actor])).rows[0];if(!row)throw Object.assign(new Error("A GameDay szolgáltatás nem található."),{status:404});await event(id,"service_state_changed",actor,`${serviceKey}: ${state}.`,{service_key:serviceKey,state,observed_rto_minutes:row.observed_rto_minutes,observed_rpo_minutes:row.observed_rpo_minutes,evidence});return row}

export async function updateGameDayStep(id:string,serviceKey:string,stepKey:string,input:any,actor:string){await ensureBusinessContinuityGameDaySchema();const status=safe(input.status);if(!['pending','in_progress','completed','skipped'].includes(status))throw Object.assign(new Error("Érvénytelen GameDay step állapot."),{status:400});const evidence=input.evidence||{};if(status==='completed'&&safe(evidence.description).length<5)throw Object.assign(new Error("Step lezárásához konkrét evidence szükséges."),{status:400});const row=(await db.query(`UPDATE continuity_drill_steps SET status=$4,owner_key=$5,note=$6,evidence=$7::jsonb,started_at=CASE WHEN $4='in_progress' THEN COALESCE(started_at,now()) ELSE started_at END,completed_at=CASE WHEN $4='completed' THEN now() ELSE completed_at END,updated_by=$8,updated_at=now() WHERE drill_id=$1::uuid AND service_key=$2 AND step_key=$3 RETURNING *`,[id,serviceKey,stepKey,status,safe(input.owner_key)||actor,safe(input.note)||null,JSON.stringify(evidence),actor])).rows[0];if(!row)throw Object.assign(new Error("A GameDay step nem található."),{status:404});await event(id,"runbook_step_changed",actor,`${serviceKey}/${stepKey}: ${status}.`,{service_key:serviceKey,step_key:stepKey,status,evidence});return row}

export async function releaseGameDayInject(id:string,injectId:string,actor:string){await ensureBusinessContinuityGameDaySchema();const drill=(await db.query(`SELECT status FROM continuity_drills WHERE id=$1::uuid`,[id])).rows[0];if(drill?.status!=='running')throw Object.assign(new Error("Inject csak futó GameDay alatt adható ki."),{status:409});const row=(await db.query(`UPDATE continuity_drill_injects SET status='released',released_at=COALESCE(released_at,now()),updated_by=$3,updated_at=now() WHERE drill_id=$1::uuid AND id=$2::bigint AND status='pending' RETURNING *`,[id,injectId,actor])).rows[0];if(!row)throw Object.assign(new Error("Az inject nem kiadható vagy már kiadásra került."),{status:409});await event(id,"inject_released",actor,`Inject #${row.sequence_no}: ${row.title}`,{inject_id:row.id,severity:row.severity});return row}
export async function acknowledgeGameDayInject(id:string,injectId:string,input:any,actor:string){await ensureBusinessContinuityGameDaySchema();const note=safe(input.response_note),evidence=input.evidence||{};if(note.length<10||safe(evidence.description).length<5)throw Object.assign(new Error("Inject kezeléséhez legalább 10 karakteres válasz és evidence szükséges."),{status:400});const row=(await db.query(`UPDATE continuity_drill_injects SET status='acknowledged',acknowledged_at=now(),response_note=$3,evidence=$4::jsonb,updated_by=$5,updated_at=now() WHERE drill_id=$1::uuid AND id=$2::bigint AND status='released' RETURNING *`,[id,injectId,note,JSON.stringify(evidence),actor])).rows[0];if(!row)throw Object.assign(new Error("Az inject nem acknowledgement állapotú."),{status:409});await event(id,"inject_acknowledged",actor,`Inject #${row.sequence_no} kezelve.`,{inject_id:row.id,evidence});return row}

async function generateImprovementActions(id:string){const services=(await db.query(`SELECT * FROM continuity_drill_services WHERE drill_id=$1::uuid`,[id])).rows;for(const s of services){if(s.observed_rto_minutes!=null&&Number(s.observed_rto_minutes)>Number(s.target_rto_minutes)){await db.query(`INSERT INTO continuity_drill_actions(drill_id,source_key,priority,title,description,due_at) VALUES($1::uuid,$2,$3,$4,$5,now()+interval '30 days') ON CONFLICT(drill_id,source_key) DO NOTHING`,[id,`rto:${s.service_key}`,s.criticality==='tier1'?'high':'medium',`${s.service_name}: RTO javítás`,`Mért RTO ${s.observed_rto_minutes} perc, cél ${s.target_rto_minutes} perc. Runbook, függőségek és automatizálás felülvizsgálata szükséges.`])}if(s.observed_rpo_minutes!=null&&Number(s.observed_rpo_minutes)>Number(s.target_rpo_minutes)){await db.query(`INSERT INTO continuity_drill_actions(drill_id,source_key,priority,title,description,due_at) VALUES($1::uuid,$2,$3,$4,$5,now()+interval '30 days') ON CONFLICT(drill_id,source_key) DO NOTHING`,[id,`rpo:${s.service_key}`,s.criticality==='tier1'?'critical':'high',`${s.service_name}: RPO javítás`,`Mért RPO ${s.observed_rpo_minutes} perc, cél ${s.target_rpo_minutes} perc. Backup/replikáció/adat-helyreállítási kontroll felülvizsgálata szükséges.`])}}
}

export async function completeGameDay(id:string,input:any,actor:string){await ensureBusinessContinuityGameDaySchema();const detail=await getGameDay(id);if(detail.item.status!=='verifying')throw Object.assign(new Error("Csak verifikáció alatt lévő GameDay zárható."),{status:409});const approver=safe(input.approver_key)||actor;if(approver.toLowerCase()===safe(detail.item.owner_key).toLowerCase())throw Object.assign(new Error("A GameDay tulajdonosa nem lehet a saját gyakorlatának független jóváhagyója."),{status:409});const note=safe(input.note),evidence=input.evidence||{};if(note.length<10||safe(evidence.description).length<5)throw Object.assign(new Error("Lezáráshoz részletes megjegyzés és evidence szükséges."),{status:400});const mandatory=detail.steps.filter((x:any)=>x.mandatory),stepRate=mandatory.length?mandatory.filter((x:any)=>x.status==='completed').length/mandatory.length:1;const serviceRate=detail.services.length?detail.services.filter((x:any)=>x.state==='verified').length/detail.services.length:1;const injectRate=detail.injects.length?detail.injects.filter((x:any)=>x.status==='acknowledged').length/detail.injects.length:1;const withRto=detail.services.filter((x:any)=>x.observed_rto_minutes!=null),withRpo=detail.services.filter((x:any)=>x.observed_rpo_minutes!=null);const rtoRate=withRto.length?withRto.filter((x:any)=>Number(x.observed_rto_minutes)<=Number(x.target_rto_minutes)).length/withRto.length:0;const rpoRate=withRpo.length?withRpo.filter((x:any)=>Number(x.observed_rpo_minutes)<=Number(x.target_rpo_minutes)).length/withRpo.length:0;const score=Math.round((stepRate*20+serviceRate*15+injectRate*10+rtoRate*30+rpoRate*20+5)*100)/100;const criticalBreach=detail.services.some((x:any)=>x.criticality==='tier1'&&((x.observed_rto_minutes==null||Number(x.observed_rto_minutes)>Number(x.target_rto_minutes))||(x.observed_rpo_minutes==null||Number(x.observed_rpo_minutes)>Number(x.target_rpo_minutes))));const result=criticalBreach||score<70?'fail':score<85?'conditional':'pass';const row=(await db.query(`UPDATE continuity_drills SET status='completed',completed_at=now(),approver_key=$2,overall_score=$3,result=$4,completion_note=$5,completion_evidence=$6::jsonb,updated_at=now() WHERE id=$1::uuid RETURNING *`,[id,approver,score,result,note,JSON.stringify(evidence)])).rows[0];await generateImprovementActions(id);if(result!=='pass')await db.query(`INSERT INTO continuity_drill_actions(drill_id,source_key,priority,title,description,due_at) VALUES($1::uuid,'scorecard',CASE WHEN $2='fail' THEN 'high' ELSE 'medium' END,'GameDay scorecard javítóprogram',$3,now()+interval '30 days') ON CONFLICT(drill_id,source_key) DO NOTHING`,[id,result,`A GameDay ${score}/100 eredménnyel ${result.toUpperCase()} minősítést kapott. A scorecard gyenge pontjait és recovery függőségeit vezetői szinten felül kell vizsgálni.`]);await event(id,"drill_completed",actor,`GameDay lezárva: ${result.toUpperCase()}, ${score}/100.`,{result,score,approver_key:approver,evidence});return{...await getGameDay(id),scorecard:{score,result,rto_rate:rtoRate,rpo_rate:rpoRate,step_rate:stepRate,service_rate:serviceRate,inject_rate:injectRate,critical_breach:criticalBreach}}}

export async function cancelGameDay(id:string,input:any,actor:string){await ensureBusinessContinuityGameDaySchema();const reason=safe(input.reason),evidence=input.evidence||{};if(reason.length<10||safe(evidence.description).length<5)throw Object.assign(new Error("GameDay megszakításához indok és evidence szükséges."),{status:400});const row=(await db.query(`UPDATE continuity_drills SET status='cancelled',cancelled_at=now(),cancel_reason=$2,completion_evidence=$3::jsonb,updated_at=now() WHERE id=$1::uuid AND status IN('planned','running','verifying') RETURNING *`,[id,reason,JSON.stringify(evidence)])).rows[0];if(!row)throw Object.assign(new Error("A GameDay már nem megszakítható."),{status:409});await event(id,"drill_cancelled",actor,"GameDay megszakítva.",{reason,evidence});return row}

export async function updateGameDayAction(id:string,actionId:string,input:any,actor:string){await ensureBusinessContinuityGameDaySchema();const status=safe(input.status);if(!['open','in_progress','completed','accepted'].includes(status))throw Object.assign(new Error("Érvénytelen javítóakció-státusz."),{status:400});const evidence=input.evidence||{};if(['completed','accepted'].includes(status)&&safe(evidence.description).length<5)throw Object.assign(new Error("Javítóakció lezárásához evidence szükséges."),{status:400});const row=(await db.query(`UPDATE continuity_drill_actions SET status=$3,owner_key=COALESCE(NULLIF($4,''),owner_key),due_at=COALESCE($5::timestamptz,due_at),evidence=CASE WHEN $6::jsonb='{}'::jsonb THEN evidence ELSE $6::jsonb END,completed_at=CASE WHEN $3='completed' THEN now() ELSE completed_at END,accepted_at=CASE WHEN $3='accepted' THEN now() ELSE accepted_at END,updated_at=now() WHERE drill_id=$1::uuid AND id=$2::uuid RETURNING *`,[id,actionId,status,safe(input.owner_key),input.due_at||null,JSON.stringify(evidence)])).rows[0];if(!row)throw Object.assign(new Error("A javítóakció nem található."),{status:404});await event(id,"improvement_action_changed",actor,`${row.title}: ${status}.`,{action_id:row.id,status,evidence});return row}

export async function runGameDayGovernanceCycle(){await ensureBusinessContinuityGameDaySchema();const overdue=(await db.query(`SELECT id::text,drill_no FROM continuity_drills WHERE status='planned' AND planned_start_at<now()-interval '24 hours' ORDER BY planned_start_at`)).rows;for(const d of overdue)await db.query(`INSERT INTO continuity_drill_actions(drill_id,source_key,priority,title,description,due_at) VALUES($1::uuid,'overdue-start','medium','Elmaradt GameDay indítás',$2,now()+interval '7 days') ON CONFLICT(drill_id,source_key) DO NOTHING`,[d.id,`${d.drill_no} tervezett indítása több mint 24 órája lejárt. Új időpont vagy formális megszakítás szükséges.`]);return{overdue_planned:overdue.length,policies:await listGameDayPolicies(),generated_at:new Date().toISOString()}}
export function startGameDayScheduler(){if(schedulerStarted||process.env.EXCEPTION_CENTER_DISABLED==='1'||process.env.NODE_ENV==='test')return;schedulerStarted=true;cron.schedule('10 7 * * *',()=>{void runGameDayGovernanceCycle().catch(error=>console.error('[gameday] governance cycle failed',error))},{timezone:TZ});setTimeout(()=>void runGameDayGovernanceCycle().catch(error=>console.error('[gameday] initial governance cycle failed',error)),120_000)}
