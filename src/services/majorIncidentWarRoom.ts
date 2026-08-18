import cron from "node-cron";
import db from "../db";
import { sendEmail } from "../mailer";
import { getApmAdminRecipients } from "./apmAlertDelivery";
import { ensureExceptionIntelligenceSchema } from "./exceptionCommandCenterIntelligence";

const TZ="Europe/Budapest";
let schemaPromise:Promise<void>|null=null;
let schedulerStarted=false;
let syncPromise:Promise<any>|null=null;
const ACTIVE_INCIDENT_STATUSES=["open","mitigating","monitoring","resolved"];
const ACTIVE_CASE_STATUSES=["open","acknowledged","in_progress","waiting","snoozed"];
const safe=(v:unknown)=>String(v??"").trim();
const num=(v:unknown)=>{const n=Number(v??0);return Number.isFinite(n)?n:0};

type IncidentSeverity="sev1"|"sev2"|"sev3";
type IncidentStatus="open"|"mitigating"|"monitoring"|"resolved"|"postmortem_closed"|"dismissed";

export function ensureMajorIncidentSchema(){
  if(!schemaPromise){
    schemaPromise=(async()=>{
      await ensureExceptionIntelligenceSchema();
      await db.query(`
        CREATE EXTENSION IF NOT EXISTS pgcrypto;
        CREATE TABLE IF NOT EXISTS major_incidents(
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          incident_no text NOT NULL UNIQUE,
          source_fingerprint text NOT NULL,
          recurrence_no integer NOT NULL DEFAULT 1,
          source_cluster_id uuid REFERENCES exception_root_cause_clusters(id) ON DELETE SET NULL,
          severity text NOT NULL CHECK(severity IN('sev1','sev2','sev3')),
          impact_score integer NOT NULL CHECK(impact_score BETWEEN 0 AND 100),
          status text NOT NULL DEFAULT 'open' CHECK(status IN('open','mitigating','monitoring','resolved','postmortem_closed','dismissed')),
          title text NOT NULL,
          summary text NOT NULL,
          location_id text,
          incident_commander_key text,
          incident_commander_name text,
          technical_lead_key text,
          technical_lead_name text,
          communications_lead_key text,
          communications_lead_name text,
          customer_impact text,
          operational_impact text,
          financial_impact text,
          declared_at timestamptz NOT NULL DEFAULT now(),
          acknowledged_at timestamptz,
          mitigation_started_at timestamptz,
          monitoring_started_at timestamptz,
          resolved_at timestamptz,
          postmortem_closed_at timestamptz,
          last_detected_at timestamptz NOT NULL DEFAULT now(),
          resolution_note text,
          resolution_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
          postmortem jsonb NOT NULL DEFAULT '{}'::jsonb,
          source_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
          created_by text NOT NULL DEFAULT 'system-war-room',
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          UNIQUE(source_fingerprint,recurrence_no)
        );
        CREATE INDEX IF NOT EXISTS major_incidents_active_idx ON major_incidents(status,severity,impact_score DESC,declared_at DESC);
        CREATE INDEX IF NOT EXISTS major_incidents_location_idx ON major_incidents(location_id,status,declared_at DESC);

        CREATE TABLE IF NOT EXISTS major_incident_cases(
          incident_id uuid NOT NULL REFERENCES major_incidents(id) ON DELETE CASCADE,
          case_id uuid NOT NULL REFERENCES exception_cases(id) ON DELETE CASCADE,
          reason text NOT NULL,
          linked_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY(incident_id,case_id)
        );

        CREATE TABLE IF NOT EXISTS major_incident_events(
          id bigserial PRIMARY KEY,
          incident_id uuid NOT NULL REFERENCES major_incidents(id) ON DELETE CASCADE,
          event_type text NOT NULL,
          actor_key text NOT NULL DEFAULT 'system-war-room',
          from_status text,
          to_status text,
          message text NOT NULL,
          evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
          created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS major_incident_events_incident_idx ON major_incident_events(incident_id,created_at,id);
        CREATE OR REPLACE FUNCTION kleo_major_incident_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'major_incident_events is append-only'; END $$;
        DROP TRIGGER IF EXISTS trg_major_incident_events_immutable ON major_incident_events;
        CREATE TRIGGER trg_major_incident_events_immutable BEFORE UPDATE OR DELETE ON major_incident_events
        FOR EACH ROW EXECUTE FUNCTION kleo_major_incident_event_immutable();

        CREATE TABLE IF NOT EXISTS major_incident_actions(
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          incident_id uuid NOT NULL REFERENCES major_incidents(id) ON DELETE CASCADE,
          title text NOT NULL,
          detail text,
          priority text NOT NULL DEFAULT 'high' CHECK(priority IN('critical','high','medium','low')),
          status text NOT NULL DEFAULT 'open' CHECK(status IN('open','in_progress','done','cancelled')),
          owner_key text,
          owner_name text,
          due_at timestamptz,
          completed_at timestamptz,
          completion_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
          created_by text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS major_incident_actions_work_idx ON major_incident_actions(incident_id,status,priority,due_at);

        CREATE TABLE IF NOT EXISTS major_incident_updates(
          id bigserial PRIMARY KEY,
          incident_id uuid NOT NULL REFERENCES major_incidents(id) ON DELETE CASCADE,
          update_type text NOT NULL CHECK(update_type IN('status','decision','observation','communication')),
          audience text NOT NULL DEFAULT 'internal' CHECK(audience IN('internal','executive','stakeholder')),
          message text NOT NULL,
          actor_key text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS major_incident_updates_incident_idx ON major_incident_updates(incident_id,created_at,id);
        CREATE OR REPLACE FUNCTION kleo_major_incident_update_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'major_incident_updates is append-only'; END $$;
        DROP TRIGGER IF EXISTS trg_major_incident_updates_immutable ON major_incident_updates;
        CREATE TRIGGER trg_major_incident_updates_immutable BEFORE UPDATE OR DELETE ON major_incident_updates
        FOR EACH ROW EXECUTE FUNCTION kleo_major_incident_update_immutable();

        CREATE TABLE IF NOT EXISTS major_incident_notifications(
          id bigserial PRIMARY KEY,
          incident_id uuid REFERENCES major_incidents(id) ON DELETE SET NULL,
          notification_key text NOT NULL,
          recipient text NOT NULL,
          status text NOT NULL CHECK(status IN('sent','failed','logged')),
          error_text text,
          created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS major_incident_notifications_key_idx ON major_incident_notifications(notification_key,created_at DESC);

        CREATE OR REPLACE FUNCTION kleo_major_incident_state_guard() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.status IN ('mitigating','monitoring','resolved','postmortem_closed') AND NULLIF(trim(COALESCE(NEW.incident_commander_key,'')),'') IS NULL THEN
            RAISE EXCEPTION 'Incident commander is required before status %', NEW.status USING ERRCODE='23514';
          END IF;
          IF NEW.status IN ('resolved','postmortem_closed') THEN
            IF length(trim(COALESCE(NEW.resolution_note,''))) < 10 OR length(trim(COALESCE(NEW.resolution_evidence->>'description',''))) < 5 THEN
              RAISE EXCEPTION 'Major incident resolution requires note and evidence' USING ERRCODE='23514';
            END IF;
          END IF;
          IF NEW.status='postmortem_closed' THEN
            IF length(trim(COALESCE(NEW.postmortem->>'root_cause',''))) < 10
               OR length(trim(COALESCE(NEW.postmortem->>'impact_summary',''))) < 10
               OR length(trim(COALESCE(NEW.postmortem->>'lessons_learned',''))) < 10
               OR length(trim(COALESCE(NEW.postmortem->>'follow_up_actions',''))) < 10 THEN
              RAISE EXCEPTION 'Post-mortem root cause, impact, lessons and follow-up actions are required' USING ERRCODE='23514';
            END IF;
          END IF;
          RETURN NEW;
        END $$;
        DROP TRIGGER IF EXISTS trg_kleo_major_incident_state_guard ON major_incidents;
        CREATE TRIGGER trg_kleo_major_incident_state_guard
          BEFORE INSERT OR UPDATE OF status,incident_commander_key,resolution_note,resolution_evidence,postmortem
          ON major_incidents FOR EACH ROW EXECUTE FUNCTION kleo_major_incident_state_guard();
      `);
    })().catch(error=>{schemaPromise=null;throw error});
  }
  return schemaPromise;
}

async function incidentEvent(id:string,type:string,actor:string,message:string,fromStatus?:string|null,toStatus?:string|null,evidence:any={}){
  await db.query(`INSERT INTO major_incident_events(incident_id,event_type,actor_key,from_status,to_status,message,evidence) VALUES($1::uuid,$2,$3,$4,$5,$6,$7::jsonb)`,[id,type,actor,fromStatus||null,toStatus||null,message,JSON.stringify(evidence||{})]);
}

function scoreCluster(row:any){
  const categories:Array<string>=Array.isArray(row.categories)?row.categories:[];
  let score=row.severity==='critical'?55:35;
  score+=Math.min(24,num(row.case_count)*6);
  score+=Math.min(24,num(row.source_count)*8);
  if(row.cluster_type==='recurrence')score+=10;
  if(row.cluster_type==='outbreak')score+=8;
  if(categories.some(x=>['finance','nav','cashier','trace','system','process'].includes(String(x))))score+=5;
  return Math.max(0,Math.min(100,Math.round(score)));
}
function severityFromScore(score:number):IncidentSeverity{return score>=80?'sev1':score>=60?'sev2':'sev3'}
function severityRank(s:string){return s==='sev1'?3:s==='sev2'?2:1}
function incidentNumber(){return `MI-${new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()).replace(/-/g,'')}-${Math.random().toString(36).slice(2,8).toUpperCase()}`}

async function notifyDeclaration(incident:any,kind:'declared'|'escalated'){
  const recipients=await getApmAdminRecipients();
  const key=`major-incident:${incident.id}:${kind}:${incident.severity}`;
  const subject=`[${String(incident.severity).toUpperCase()}] VIR Major Incident · ${incident.incident_no} · ${incident.title}`;
  const text=[
    kind==='declared'?'Automatikusan deklarált VIR Major Incident / War Room.':'A VIR Major Incident súlyossága emelkedett.',
    '',`Azonosító: ${incident.incident_no}`,`Súlyosság: ${incident.severity}`,`Impact score: ${incident.impact_score}/100`,
    `Telephely: ${incident.location_id||'globális'}`,`Állapot: ${incident.status}`,`Összefoglaló: ${incident.summary}`,'',
    'VIR → Statisztika és VIR → Major Incident / War Room','A rendszer nem küld automatikusan külső ügyfélkommunikációt; stakeholder kommunikáció vezetői döntés.'
  ].join('\n');
  if(!recipients.length){await db.query(`INSERT INTO major_incident_notifications(incident_id,notification_key,recipient,status,error_text) VALUES($1::uuid,$2,'unconfigured-admin-recipient','logged','Nincs konfigurált admin e-mail cím.')`,[incident.id,key]);return}
  for(const recipient of recipients){
    try{const result:any=await sendEmail({to:recipient,subject,text});await db.query(`INSERT INTO major_incident_notifications(incident_id,notification_key,recipient,status,error_text) VALUES($1::uuid,$2,$3,$4,$5)`,[incident.id,key,recipient,result?.sent?'sent':'logged',result?.logged?'SMTP nem küldött; naplózva.':null])}
    catch(error:any){await db.query(`INSERT INTO major_incident_notifications(incident_id,notification_key,recipient,status,error_text) VALUES($1::uuid,$2,$3,'failed',$4)`,[incident.id,key,recipient,String(error?.message||error).slice(0,1500)])}
  }
}

async function clusterCandidates(){
  await ensureMajorIncidentSchema();
  return(await db.query(`SELECT rc.id::text,rc.cluster_key,rc.cluster_type,rc.severity,rc.title,rc.summary,rc.location_id,rc.case_count,rc.source_count,rc.first_seen_at,rc.last_seen_at,rc.evidence,
      COALESCE(array_agg(DISTINCT ec.category) FILTER(WHERE ec.category IS NOT NULL),'{}') categories
    FROM exception_root_cause_clusters rc
    LEFT JOIN exception_root_cause_cluster_cases cc ON cc.cluster_id=rc.id
    LEFT JOIN exception_cases ec ON ec.id=cc.case_id
    WHERE rc.status='active' AND rc.severity IN('critical','high')
    GROUP BY rc.id ORDER BY rc.last_seen_at DESC`)).rows;
}

export async function syncMajorIncidentWarRooms(){
  if(syncPromise)return syncPromise;
  syncPromise=(async()=>{
    await ensureMajorIncidentSchema();const clusters=await clusterCandidates();let created=0,updated=0,escalated=0,monitoring=0;
    for(const cluster of clusters){
      const impact=scoreCluster(cluster);if(impact<60)continue;
      const severity=severityFromScore(impact),fingerprint=`cluster:${cluster.cluster_key}`;
      let incident=(await db.query(`SELECT * FROM major_incidents WHERE source_fingerprint=$1 AND status<>ALL($2::text[]) ORDER BY recurrence_no DESC LIMIT 1`,[fingerprint,['postmortem_closed','dismissed']])).rows[0];
      if(!incident){
        const previous=num((await db.query(`SELECT COALESCE(MAX(recurrence_no),0)::int n FROM major_incidents WHERE source_fingerprint=$1`,[fingerprint])).rows[0]?.n);
        incident=(await db.query(`INSERT INTO major_incidents(incident_no,source_fingerprint,recurrence_no,source_cluster_id,severity,impact_score,title,summary,location_id,source_payload)
          VALUES($1,$2,$3,$4::uuid,$5,$6,$7,$8,$9,$10::jsonb) RETURNING *`,[incidentNumber(),fingerprint,previous+1,cluster.id,severity,impact,cluster.title,cluster.summary,cluster.location_id||null,JSON.stringify({cluster_key:cluster.cluster_key,cluster_type:cluster.cluster_type,categories:cluster.categories,case_count:cluster.case_count,source_count:cluster.source_count,evidence:cluster.evidence})])).rows[0];
        await db.query(`INSERT INTO major_incident_cases(incident_id,case_id,reason) SELECT $1::uuid,cc.case_id,$2 FROM exception_root_cause_cluster_cases cc WHERE cc.cluster_id=$3::uuid ON CONFLICT DO NOTHING`,[incident.id,`Automatikus War Room korreláció: ${cluster.cluster_type}`,cluster.id]);
        await incidentEvent(incident.id,'declared','system-war-room',`Major Incident automatikusan deklarálva ${severity.toUpperCase()} szinten, impact score ${impact}/100.`,null,'open',{cluster_key:cluster.cluster_key,impact_score:impact,severity});
        await notifyDeclaration(incident,'declared');created++;
      }else{
        const oldSeverity=String(incident.severity),newSeverity=severityRank(severity)>severityRank(oldSeverity)?severity:oldSeverity;
        const oldScore=num(incident.impact_score);
        incident=(await db.query(`UPDATE major_incidents SET severity=$2,impact_score=GREATEST(impact_score,$3),title=$4,summary=$5,location_id=COALESCE($6,location_id),last_detected_at=now(),source_payload=$7::jsonb,updated_at=now() WHERE id=$1::uuid RETURNING *`,[incident.id,newSeverity,impact,cluster.title,cluster.summary,cluster.location_id||null,JSON.stringify({cluster_key:cluster.cluster_key,cluster_type:cluster.cluster_type,categories:cluster.categories,case_count:cluster.case_count,source_count:cluster.source_count,evidence:cluster.evidence})])).rows[0];
        await db.query(`INSERT INTO major_incident_cases(incident_id,case_id,reason) SELECT $1::uuid,cc.case_id,$2 FROM exception_root_cause_cluster_cases cc WHERE cc.cluster_id=$3::uuid ON CONFLICT DO NOTHING`,[incident.id,`War Room korreláció frissítve: ${cluster.cluster_type}`,cluster.id]);
        if(newSeverity!==oldSeverity){await incidentEvent(incident.id,'severity_escalated','system-war-room',`Major Incident súlyosság ${oldSeverity.toUpperCase()} → ${newSeverity.toUpperCase()}.`,null,null,{previous_score:oldScore,impact_score:impact});await notifyDeclaration(incident,'escalated');escalated++}
        updated++;
      }
    }
    const recovered=(await db.query(`SELECT mi.id::text,mi.status,mi.incident_no,rc.status cluster_status FROM major_incidents mi JOIN exception_root_cause_clusters rc ON rc.id=mi.source_cluster_id WHERE mi.status IN('open','mitigating') AND rc.status='resolved'`)).rows;
    for(const row of recovered){const changed=(await db.query(`UPDATE major_incidents SET status='monitoring',monitoring_started_at=COALESCE(monitoring_started_at,now()),updated_at=now() WHERE id=$1::uuid AND status IN('open','mitigating') RETURNING id`,[row.id])).rows[0];if(changed){await incidentEvent(row.id,'source_recovered_monitoring','system-war-room','A forrásklaszter megszűnt; az incidens automatikusan monitoring állapotba került. Emberi feloldás továbbra is kötelező.',row.status,'monitoring',{source_cluster_status:'resolved'});monitoring++}}
    return{ok:true,clusters_scanned:clusters.length,created,updated,escalated,auto_monitoring:monitoring,generated_at:new Date().toISOString()};
  })().finally(()=>{syncPromise=null});
  return syncPromise;
}

export async function majorIncidentSummary(locationId:string|null=null){
  await ensureMajorIncidentSchema();
  const row=(await db.query(`SELECT COUNT(*)::int total,
      COUNT(*) FILTER(WHERE status=ANY($2::text[]))::int active,
      COUNT(*) FILTER(WHERE severity='sev1' AND status=ANY($2::text[]))::int sev1,
      COUNT(*) FILTER(WHERE severity='sev2' AND status=ANY($2::text[]))::int sev2,
      COUNT(*) FILTER(WHERE status=ANY($2::text[]) AND incident_commander_key IS NULL)::int commander_missing,
      COUNT(*) FILTER(WHERE status='monitoring')::int monitoring,
      COUNT(*) FILTER(WHERE status='resolved')::int awaiting_postmortem,
      ROUND(AVG(EXTRACT(EPOCH FROM(resolved_at-declared_at))/60) FILTER(WHERE resolved_at IS NOT NULL AND resolved_at>=now()-interval '30 days'),1) avg_resolution_minutes
    FROM major_incidents WHERE ($1::text IS NULL OR location_id=$1 OR location_id IS NULL)`,[locationId,ACTIVE_INCIDENT_STATUSES])).rows[0]||{};
  const actions=(await db.query(`SELECT COUNT(*)::int open_actions,COUNT(*) FILTER(WHERE a.status<>'done' AND a.status<>'cancelled' AND a.due_at<now())::int overdue_actions FROM major_incident_actions a JOIN major_incidents mi ON mi.id=a.incident_id WHERE mi.status=ANY($2::text[]) AND ($1::text IS NULL OR mi.location_id=$1 OR mi.location_id IS NULL)`,[locationId,ACTIVE_INCIDENT_STATUSES])).rows[0]||{};
  return{...row,...actions,generated_at:new Date().toISOString()};
}

export async function listMajorIncidents(filters:any={}){
  await ensureMajorIncidentSchema();const params:any[]=[];const where:string[]=[];const add=(expr:string,v:any)=>{params.push(v);where.push(expr.replace('?',`$${params.length}`))};
  if(filters.status&&filters.status!=='all')add('mi.status=?',safe(filters.status));
  else if(filters.status!=='all')where.push(`mi.status=ANY(ARRAY['open','mitigating','monitoring','resolved'])`);
  if(filters.severity&&filters.severity!=='all')add('mi.severity=?',safe(filters.severity));
  if(filters.location_id){params.push(safe(filters.location_id));where.push(`(mi.location_id=$${params.length} OR mi.location_id IS NULL)`)}
  if(filters.q){params.push(`%${safe(filters.q)}%`);const p=params.length;where.push(`(mi.incident_no ILIKE $${p} OR mi.title ILIKE $${p} OR mi.summary ILIKE $${p})`)}
  const limit=Math.max(20,Math.min(200,num(filters.limit)||100));params.push(limit);
  return(await db.query(`SELECT mi.*,
      (SELECT COUNT(*)::int FROM major_incident_cases mic WHERE mic.incident_id=mi.id) linked_cases,
      (SELECT COUNT(*)::int FROM major_incident_actions a WHERE a.incident_id=mi.id AND a.status NOT IN('done','cancelled')) open_actions,
      (SELECT COUNT(*)::int FROM major_incident_actions a WHERE a.incident_id=mi.id AND a.status NOT IN('done','cancelled') AND a.due_at<now()) overdue_actions
    FROM major_incidents mi ${where.length?`WHERE ${where.join(' AND ')}`:''}
    ORDER BY CASE mi.severity WHEN 'sev1' THEN 0 WHEN 'sev2' THEN 1 ELSE 2 END,mi.impact_score DESC,mi.declared_at DESC LIMIT $${params.length}`,params)).rows;
}

export async function getMajorIncident(id:string){
  await ensureMajorIncidentSchema();const item=(await db.query(`SELECT * FROM major_incidents WHERE id=$1::uuid`,[id])).rows[0];if(!item)throw Object.assign(new Error('A Major Incident nem található.'),{status:404});
  const [cases,events,actions,updates,notifications,capa]=await Promise.all([
    db.query(`SELECT ec.id::text,ec.title,ec.category,ec.severity,ec.status,ec.sla_state,ec.owner_name,ec.location_id,ec.source_route,mic.reason FROM major_incident_cases mic JOIN exception_cases ec ON ec.id=mic.case_id WHERE mic.incident_id=$1::uuid ORDER BY ec.priority_score DESC,ec.last_detected_at DESC`,[id]),
    db.query(`SELECT * FROM major_incident_events WHERE incident_id=$1::uuid ORDER BY created_at,id`,[id]),
    db.query(`SELECT * FROM major_incident_actions WHERE incident_id=$1::uuid ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,due_at NULLS LAST,created_at`,[id]),
    db.query(`SELECT * FROM major_incident_updates WHERE incident_id=$1::uuid ORDER BY created_at,id`,[id]),
    db.query(`SELECT * FROM major_incident_notifications WHERE incident_id=$1::uuid ORDER BY created_at DESC LIMIT 100`,[id]),
    db.query(`SELECT c.id::text,c.status,c.severity,c.title,c.due_at FROM exception_capa_candidates c WHERE c.cluster_id=$1::uuid ORDER BY c.created_at DESC LIMIT 1`,[item.source_cluster_id]).catch(()=>({rows:[]} as any))
  ]);
  return{item,cases:cases.rows,events:events.rows,actions:actions.rows,updates:updates.rows,notifications:notifications.rows,capa:capa.rows[0]||null};
}

const transitions:Record<IncidentStatus,IncidentStatus[]>={open:['mitigating','dismissed'],mitigating:['monitoring','open'],monitoring:['resolved','mitigating'],resolved:['postmortem_closed','monitoring'],postmortem_closed:[],dismissed:['open']};
export async function updateMajorIncident(id:string,input:any,actor:string){
  await ensureMajorIncidentSchema();const before=(await db.query(`SELECT * FROM major_incidents WHERE id=$1::uuid`,[id])).rows[0];if(!before)throw Object.assign(new Error('A Major Incident nem található.'),{status:404});
  const requested=(input.status?safe(input.status):before.status) as IncidentStatus;
  if(requested!==before.status&&!transitions[before.status as IncidentStatus]?.includes(requested))throw Object.assign(new Error(`Érvénytelen Major Incident státuszváltás: ${before.status} → ${requested}.`),{status:409});
  const commanderKey=input.incident_commander_key===undefined?before.incident_commander_key:(safe(input.incident_commander_key)||null);
  const resolutionNote=input.resolution_note===undefined?before.resolution_note:(safe(input.resolution_note)||null);
  const resolutionEvidence=input.resolution_evidence===undefined?(before.resolution_evidence||{}):input.resolution_evidence;
  const postmortem=input.postmortem===undefined?(before.postmortem||{}):input.postmortem;
  if(['mitigating','monitoring','resolved','postmortem_closed'].includes(requested)&&!commanderKey)throw Object.assign(new Error('Incident commander kijelölése kötelező.'),{status:400});
  if(['resolved','postmortem_closed'].includes(requested)&&(safe(resolutionNote).length<10||safe(resolutionEvidence?.description).length<5))throw Object.assign(new Error('Feloldáshoz legalább 10 karakteres indok és konkrét bizonyíték szükséges.'),{status:400});
  if(requested==='postmortem_closed'&&['root_cause','impact_summary','lessons_learned','follow_up_actions'].some(k=>safe(postmortem?.[k]).length<10))throw Object.assign(new Error('A post-mortemhez gyökérok, hatás, tanulságok és követő intézkedések szükségesek.'),{status:400});
  const row=(await db.query(`UPDATE major_incidents SET status=$2,
      incident_commander_key=$3,incident_commander_name=$4,technical_lead_key=$5,technical_lead_name=$6,communications_lead_key=$7,communications_lead_name=$8,
      customer_impact=$9,operational_impact=$10,financial_impact=$11,
      acknowledged_at=CASE WHEN $3 IS NOT NULL THEN COALESCE(acknowledged_at,now()) ELSE acknowledged_at END,
      mitigation_started_at=CASE WHEN $2='mitigating' THEN COALESCE(mitigation_started_at,now()) ELSE mitigation_started_at END,
      monitoring_started_at=CASE WHEN $2='monitoring' THEN COALESCE(monitoring_started_at,now()) ELSE monitoring_started_at END,
      resolved_at=CASE WHEN $2='resolved' THEN COALESCE(resolved_at,now()) WHEN $2 IN('open','mitigating','monitoring') THEN NULL ELSE resolved_at END,
      postmortem_closed_at=CASE WHEN $2='postmortem_closed' THEN COALESCE(postmortem_closed_at,now()) ELSE postmortem_closed_at END,
      resolution_note=$12,resolution_evidence=$13::jsonb,postmortem=$14::jsonb,updated_at=now() WHERE id=$1::uuid RETURNING *`,[
      id,requested,commanderKey,input.incident_commander_name===undefined?before.incident_commander_name:(safe(input.incident_commander_name)||null),
      input.technical_lead_key===undefined?before.technical_lead_key:(safe(input.technical_lead_key)||null),input.technical_lead_name===undefined?before.technical_lead_name:(safe(input.technical_lead_name)||null),
      input.communications_lead_key===undefined?before.communications_lead_key:(safe(input.communications_lead_key)||null),input.communications_lead_name===undefined?before.communications_lead_name:(safe(input.communications_lead_name)||null),
      input.customer_impact===undefined?before.customer_impact:(safe(input.customer_impact)||null),input.operational_impact===undefined?before.operational_impact:(safe(input.operational_impact)||null),input.financial_impact===undefined?before.financial_impact:(safe(input.financial_impact)||null),
      resolutionNote,JSON.stringify(resolutionEvidence||{}),JSON.stringify(postmortem||{})
    ])).rows[0];
  if(requested!==before.status)await incidentEvent(id,'status_changed',actor,safe(input.note)||`Major Incident státusz: ${before.status} → ${requested}.`,before.status,requested,{resolution_evidence:['resolved','postmortem_closed'].includes(requested)?resolutionEvidence:undefined,postmortem:requested==='postmortem_closed'?postmortem:undefined});
  if(commanderKey!==before.incident_commander_key||row.technical_lead_key!==before.technical_lead_key||row.communications_lead_key!==before.communications_lead_key)await incidentEvent(id,'command_team_updated',actor,'War Room command team frissítve.',null,null,{incident_commander_key:row.incident_commander_key,technical_lead_key:row.technical_lead_key,communications_lead_key:row.communications_lead_key});
  return row;
}

export async function addMajorIncidentAction(id:string,input:any,actor:string){
  await ensureMajorIncidentSchema();const title=safe(input.title);if(title.length<5)throw Object.assign(new Error('Az akció megnevezése túl rövid.'),{status:400});
  const exists=(await db.query(`SELECT 1 FROM major_incidents WHERE id=$1::uuid`,[id])).rows[0];if(!exists)throw Object.assign(new Error('A Major Incident nem található.'),{status:404});
  const row=(await db.query(`INSERT INTO major_incident_actions(incident_id,title,detail,priority,owner_key,owner_name,due_at,created_by) VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[id,title,safe(input.detail)||null,['critical','high','medium','low'].includes(safe(input.priority))?safe(input.priority):'high',safe(input.owner_key)||null,safe(input.owner_name)||null,safe(input.due_at)||null,actor])).rows[0];
  await incidentEvent(id,'action_created',actor,`War Room akció létrehozva: ${title}.`,null,null,{action_id:row.id,priority:row.priority,owner_key:row.owner_key,due_at:row.due_at});return row;
}

export async function updateMajorIncidentAction(incidentId:string,actionId:string,input:any,actor:string){
  await ensureMajorIncidentSchema();const before=(await db.query(`SELECT * FROM major_incident_actions WHERE id=$1::uuid AND incident_id=$2::uuid`,[actionId,incidentId])).rows[0];if(!before)throw Object.assign(new Error('A War Room akció nem található.'),{status:404});
  const status=input.status===undefined?before.status:safe(input.status);if(!['open','in_progress','done','cancelled'].includes(status))throw Object.assign(new Error('Érvénytelen akció státusz.'),{status:400});
  const evidence=input.completion_evidence===undefined?(before.completion_evidence||{}):input.completion_evidence;if(status==='done'&&safe(evidence?.description).length<5)throw Object.assign(new Error('Akció lezárásához konkrét végrehajtási bizonyíték szükséges.'),{status:400});
  const row=(await db.query(`UPDATE major_incident_actions SET title=$3,detail=$4,priority=$5,status=$6,owner_key=$7,owner_name=$8,due_at=$9,completed_at=CASE WHEN $6='done' THEN COALESCE(completed_at,now()) ELSE NULL END,completion_evidence=$10::jsonb,updated_at=now() WHERE id=$1::uuid AND incident_id=$2::uuid RETURNING *`,[actionId,incidentId,safe(input.title??before.title),safe(input.detail??before.detail)||null,['critical','high','medium','low'].includes(safe(input.priority))?safe(input.priority):before.priority,status,input.owner_key===undefined?before.owner_key:(safe(input.owner_key)||null),input.owner_name===undefined?before.owner_name:(safe(input.owner_name)||null),input.due_at===undefined?before.due_at:(safe(input.due_at)||null),JSON.stringify(evidence||{})])).rows[0];
  await incidentEvent(incidentId,'action_updated',actor,`War Room akció frissítve: ${row.title} · ${row.status}.`,null,null,{action_id:row.id,status:row.status,completion_evidence:row.status==='done'?evidence:undefined});return row;
}

export async function addMajorIncidentUpdate(id:string,input:any,actor:string){
  await ensureMajorIncidentSchema();const message=safe(input.message);if(message.length<5)throw Object.assign(new Error('A War Room update túl rövid.'),{status:400});
  const type=['status','decision','observation','communication'].includes(safe(input.update_type))?safe(input.update_type):'status';const audience=['internal','executive','stakeholder'].includes(safe(input.audience))?safe(input.audience):'internal';
  const row=(await db.query(`INSERT INTO major_incident_updates(incident_id,update_type,audience,message,actor_key) VALUES($1::uuid,$2,$3,$4,$5) RETURNING *`,[id,type,audience,message,actor])).rows[0];
  await incidentEvent(id,'war_room_update',actor,`War Room update (${audience}/${type}): ${message}`,null,null,{update_id:row.id,audience,type});return row;
}

export function startMajorIncidentWarRoomScheduler(){
  if(schedulerStarted||process.env.EXCEPTION_CENTER_DISABLED==='1'||process.env.NODE_ENV==='test')return;schedulerStarted=true;
  cron.schedule('*/3 * * * *',()=>{void syncMajorIncidentWarRooms().catch(error=>console.error('[major-incident] scheduled sync failed',error))},{timezone:TZ});
  const timer=setTimeout(()=>{void syncMajorIncidentWarRooms().catch(error=>console.error('[major-incident] initial sync failed',error))},95_000);timer.unref?.();
  console.log('[major-incident] automatic War Room detection scheduled every 3 minutes Europe/Budapest');
}
