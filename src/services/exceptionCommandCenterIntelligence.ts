import cron from "node-cron";
import db from "../db";
import { sendEmail } from "../mailer";
import { getApmAdminRecipients } from "./apmAlertDelivery";
import { ensureExceptionCommandCenterSchema, exceptionCenterSummary } from "./exceptionCommandCenter";

const TZ="Europe/Budapest";
const ACTIVE_STATUSES=["open","acknowledged","in_progress","waiting","snoozed"];
let schemaPromise:Promise<void>|null=null;
let started=false;
let cyclePromise:Promise<any>|null=null;

type Severity="critical"|"high"|"medium"|"low";
type ClusterType="trace"|"entity"|"outbreak"|"recurrence";
type ExceptionCase={
  id:string;exception_key:string;source_type:string;source_key:string;category:string;severity:Severity;status:string;sla_state:string;
  sla_minutes:number;title:string;detail:string;location_id?:string|null;entity_type?:string|null;entity_id?:string|null;trace_id?:string|null;
  team_key?:string|null;owner_key?:string|null;owner_name?:string|null;first_detected_at:string;last_detected_at:string;due_at?:string|null;
  acknowledged_at?:string|null;resolved_at?:string|null;occurrence_count:number;
};

type ClusterCandidate={
  key:string;type:ClusterType;title:string;summary:string;location_id:string|null;cases:ExceptionCase[];reason:string;
};

const n=(v:unknown)=>{const x=Number(v??0);return Number.isFinite(x)?x:0};
const safe=(v:unknown)=>String(v??"").trim();
const severityRank=(v:string)=>v==="critical"?4:v==="high"?3:v==="medium"?2:1;
const severityMax=(rows:ExceptionCase[]):Severity=>rows.reduce<Severity>((best,row)=>severityRank(row.severity)>severityRank(best)?row.severity:best,"low");
const minutesSince=(value:unknown)=>Math.max(0,(Date.now()-new Date(String(value)).getTime())/60000);
const minutesPast=(value:unknown)=>Math.max(0,(Date.now()-new Date(String(value)).getTime())/60000);
const unique=<T,>(items:T[])=>[...new Set(items)];
function budapestDate(){return new Intl.DateTimeFormat("en-CA",{timeZone:TZ,year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date())}

export function ensureExceptionIntelligenceSchema(){
  if(!schemaPromise){
    schemaPromise=(async()=>{
      await ensureExceptionCommandCenterSchema();
      await db.query(`
        CREATE TABLE IF NOT EXISTS exception_escalation_rules(
          severity text PRIMARY KEY CHECK(severity IN('critical','high','medium','low')),
          level1_after_minutes integer NOT NULL,
          level2_after_minutes integer NOT NULL,
          level3_after_minutes integer NOT NULL,
          active boolean NOT NULL DEFAULT true,
          updated_by text,
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS exception_case_escalations(
          id bigserial PRIMARY KEY,
          case_id uuid NOT NULL REFERENCES exception_cases(id) ON DELETE CASCADE,
          occurrence_no bigint NOT NULL,
          escalation_level integer NOT NULL CHECK(escalation_level BETWEEN 1 AND 3),
          trigger_code text NOT NULL,
          recipient text NOT NULL,
          status text NOT NULL CHECK(status IN('sent','failed','logged')),
          detail text,
          created_at timestamptz NOT NULL DEFAULT now(),
          UNIQUE(case_id,occurrence_no,escalation_level,recipient)
        );
        CREATE INDEX IF NOT EXISTS exception_case_escalations_case_idx ON exception_case_escalations(case_id,created_at DESC);
        CREATE INDEX IF NOT EXISTS exception_case_escalations_time_idx ON exception_case_escalations(created_at DESC,escalation_level);

        CREATE TABLE IF NOT EXISTS exception_root_cause_clusters(
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          cluster_key text NOT NULL UNIQUE,
          cluster_type text NOT NULL CHECK(cluster_type IN('trace','entity','outbreak','recurrence')),
          severity text NOT NULL CHECK(severity IN('critical','high','medium','low')),
          title text NOT NULL,
          summary text NOT NULL,
          status text NOT NULL DEFAULT 'active' CHECK(status IN('active','resolved')),
          location_id text,
          case_count integer NOT NULL DEFAULT 0,
          source_count integer NOT NULL DEFAULT 0,
          first_seen_at timestamptz NOT NULL DEFAULT now(),
          last_seen_at timestamptz NOT NULL DEFAULT now(),
          resolved_at timestamptz,
          evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS exception_root_cause_clusters_active_idx ON exception_root_cause_clusters(status,severity,last_seen_at DESC);
        CREATE TABLE IF NOT EXISTS exception_root_cause_cluster_cases(
          cluster_id uuid NOT NULL REFERENCES exception_root_cause_clusters(id) ON DELETE CASCADE,
          case_id uuid NOT NULL REFERENCES exception_cases(id) ON DELETE CASCADE,
          reason text NOT NULL,
          linked_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY(cluster_id,case_id)
        );

        CREATE TABLE IF NOT EXISTS exception_intelligence_snapshots(
          bucket_at timestamptz PRIMARY KEY,
          payload jsonb NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS exception_intelligence_snapshots_time_idx ON exception_intelligence_snapshots(bucket_at DESC);

        CREATE TABLE IF NOT EXISTS exception_executive_brief_deliveries(
          id bigserial PRIMARY KEY,
          business_date date NOT NULL,
          brief_type text NOT NULL,
          recipient text NOT NULL,
          status text NOT NULL CHECK(status IN('sent','failed','logged')),
          error_text text,
          payload jsonb NOT NULL DEFAULT '{}'::jsonb,
          created_at timestamptz NOT NULL DEFAULT now(),
          UNIQUE(business_date,brief_type,recipient)
        );

        INSERT INTO exception_escalation_rules(severity,level1_after_minutes,level2_after_minutes,level3_after_minutes) VALUES
          ('critical',15,30,60),
          ('high',60,120,240),
          ('medium',240,480,960),
          ('low',720,1440,2880)
        ON CONFLICT(severity) DO NOTHING;
      `);
    })().catch(error=>{schemaPromise=null;throw error});
  }
  return schemaPromise;
}

async function activeCases(locationId:string|null=null):Promise<ExceptionCase[]>{
  await ensureExceptionIntelligenceSchema();
  const rows=(await db.query(`SELECT id::text,exception_key,source_type,source_key,category,severity,status,sla_state,sla_minutes,title,detail,
      location_id,entity_type,entity_id,trace_id,team_key,owner_key,owner_name,first_detected_at,last_detected_at,due_at,acknowledged_at,resolved_at,occurrence_count
    FROM exception_cases
    WHERE status=ANY($1::text[]) AND ($2::text IS NULL OR location_id=$2)
    ORDER BY first_detected_at`,[ACTIVE_STATUSES,locationId])).rows;
  return rows as ExceptionCase[];
}

async function writeCaseNotification(caseId:string,key:string,recipient:string,status:"sent"|"failed"|"logged",error?:string|null){
  await db.query(`INSERT INTO exception_case_notifications(notification_key,case_id,recipient,status,error_text) VALUES($1,$2::uuid,$3,$4,$5)`,[key,caseId,recipient,status,error?String(error).slice(0,1500):null]);
}

function escalationTarget(row:any){
  const age=minutesSince(row.first_detected_at),overdue=row.due_at?minutesPast(row.due_at):0;
  let level=0,trigger="";
  if(!row.acknowledged_at&&age>=n(row.level1_after_minutes)){level=1;trigger="acknowledgement_overdue"}
  if(age>=n(row.level2_after_minutes)||row.sla_state==="breached"){level=2;trigger=row.sla_state==="breached"?"sla_breached":"age_level2"}
  if(age>=n(row.level3_after_minutes)||(row.sla_state==="breached"&&overdue>=Math.max(30,n(row.sla_minutes)))){level=3;trigger="executive_escalation"}
  return{level,trigger,age_minutes:Math.round(age),overdue_minutes:Math.round(overdue)};
}

async function deliverEscalation(row:any,level:number,trigger:string,ageMinutes:number,overdueMinutes:number){
  const admins=await getApmAdminRecipients();
  const ownerEmail=safe(row.owner_key).includes("@")?safe(row.owner_key).toLowerCase():"";
  const recipients=level===1&&ownerEmail?[ownerEmail]:unique([...(ownerEmail?[ownerEmail]:[]),...admins]);
  const effectiveRecipients=recipients.length?recipients:["unconfigured-admin-recipient"];
  const notificationKey=`exception-escalation:${row.id}:${row.occurrence_count}:L${level}`;
  const subject=`[L${level} ${String(row.severity).toUpperCase()}] VIR Exception – ${row.title}`;
  const text=[
    `Exception Command Center automatikus L${level} eszkaláció.`,"",
    `Ügy: ${row.title}`,
    `Kategória: ${row.category}`,
    `Súlyosság: ${row.severity}`,
    `Státusz: ${row.status}`,
    `SLA: ${row.sla_state} (${row.sla_minutes} perc)`,
    `Nyitva: ${ageMinutes} perc`,
    `SLA túllépés: ${overdueMinutes} perc`,
    `Felelős: ${row.owner_name||row.owner_key||"nincs kiosztva"}`,
    `Csapat: ${row.team_key||"nincs"}`,
    `Részlet: ${row.detail}`,"",
    "VIR → Statisztika és VIR → Exception Command Center"
  ].join("\n");
  let sent=0,failed=0,logged=0;
  for(const recipient of effectiveRecipients){
    let status:"sent"|"failed"|"logged"="logged",errorText:string|null=null;
    if(recipient!=="unconfigured-admin-recipient"){
      try{const result:any=await sendEmail({to:recipient,subject,text});status=result?.sent?"sent":"logged";if(result?.logged)errorText="SMTP nem küldött; naplózva."}
      catch(error:any){status="failed";errorText=error?.message||String(error)}
    }else errorText="Nincs konfigurált admin vagy e-mail formátumú felelős.";
    await db.query(`INSERT INTO exception_case_escalations(case_id,occurrence_no,escalation_level,trigger_code,recipient,status,detail)
      VALUES($1::uuid,$2,$3,$4,$5,$6,$7) ON CONFLICT(case_id,occurrence_no,escalation_level,recipient) DO NOTHING`,[row.id,row.occurrence_count,level,trigger,recipient,status,errorText]);
    await writeCaseNotification(String(row.id),notificationKey,recipient,status,errorText);
    if(status==="sent")sent++;else if(status==="failed")failed++;else logged++;
  }
  await db.query(`INSERT INTO exception_case_events(case_id,event_type,actor_key,message,evidence)
    SELECT $1::uuid,'escalated','system-intelligence',$2,$3::jsonb
    WHERE NOT EXISTS(SELECT 1 FROM exception_case_events WHERE case_id=$1::uuid AND event_type='escalated' AND evidence->>'occurrence_no'=$4 AND evidence->>'level'=$5)`,[
      row.id,`Automatikus L${level} eszkaláció: ${trigger}.`,JSON.stringify({level,trigger,occurrence_no:String(row.occurrence_count),age_minutes:ageMinutes,overdue_minutes:overdueMinutes,recipients:effectiveRecipients}),String(row.occurrence_count),String(level)
    ]);
  return{sent,failed,logged,recipients:effectiveRecipients.length};
}

export async function runExceptionEscalations(){
  await ensureExceptionIntelligenceSchema();
  const rows=(await db.query(`SELECT c.*,r.level1_after_minutes,r.level2_after_minutes,r.level3_after_minutes
    FROM exception_cases c JOIN exception_escalation_rules r ON r.severity=c.severity AND r.active=true
    WHERE c.status IN('open','acknowledged','in_progress','waiting') ORDER BY c.first_detected_at`)).rows;
  let escalated=0,sent=0,failed=0,logged=0;
  for(const row of rows){
    const target=escalationTarget(row);if(!target.level)continue;
    const current=n((await db.query(`SELECT COALESCE(MAX(escalation_level),0)::int level FROM exception_case_escalations WHERE case_id=$1::uuid AND occurrence_no=$2`,[row.id,row.occurrence_count])).rows[0]?.level);
    if(target.level<=current)continue;
    const delivery=await deliverEscalation(row,target.level,target.trigger,target.age_minutes,target.overdue_minutes);escalated++;sent+=delivery.sent;failed+=delivery.failed;logged+=delivery.logged;
  }
  return{escalated,sent,failed,logged,checked:rows.length,generated_at:new Date().toISOString()};
}

function buildClusterCandidates(rows:ExceptionCase[]){
  const groups=new Map<string,ClusterCandidate>();
  const add=(key:string,type:ClusterType,title:string,summary:string,locationId:string|null,reason:string,row:ExceptionCase)=>{
    const current=groups.get(key)||{key,type,title,summary,location_id:locationId,cases:[],reason};current.cases.push(row);groups.set(key,current);
  };
  for(const row of rows){
    if(row.trace_id)add(`trace:${row.trace_id}`,"trace",`Többmodulos trace eltérés · ${row.trace_id}`,"Azonos tranzakció-életúthoz több Exception jelzés kapcsolódik.",row.location_id||null,"Azonos trace_id",row);
    if(row.entity_type&&row.entity_id)add(`entity:${row.entity_type}:${row.entity_id}`,"entity",`Közös üzleti entitás · ${row.entity_type} ${row.entity_id}`,"Ugyanazt az üzleti entitást több kontrollréteg is érinti.",row.location_id||null,"Azonos entity_type + entity_id",row);
    if(row.location_id)add(`outbreak:${row.location_id}:${row.category}`,"outbreak",`Telephelyi eltéréshalmozódás · ${row.category}`,"Azonos telephelyen és kategóriában több aktív eltérés halmozódik.",row.location_id,"Azonos telephely + kategória",row);
    if(n(row.occurrence_count)>=3)add(`recurrence:${row.exception_key}`,"recurrence",`Visszatérő eltérés · ${row.title}`,"Ugyanaz az Exception ismételten újranyílik vagy újra észlelhető.",row.location_id||null,"Occurrence count >= 3",row);
  }
  return[...groups.values()].filter(group=>{
    if(group.type==="recurrence")return true;
    if(group.type==="outbreak")return group.cases.length>=3;
    return group.cases.length>=2&&unique(group.cases.map(x=>x.source_type)).length>=2;
  });
}

function rootCauseAdvice(type:ClusterType){
  if(type==="trace")return"A legkorábbi hibás trace eseményt azonosítsd, majd onnan haladj downstream irányban; nagy valószínűséggel egy közös tranzakciós gyökérok több modulban jelenik meg.";
  if(type==="entity")return"Az entitás forrásadatát, kulcskapcsolatait és az utolsó módosítás auditját vizsgáld; több modul egyidejű jelzése közös adat- vagy integrációs hibára utalhat.";
  if(type==="outbreak")return"Telephelyi közös okot keress: infrastruktúra, jogosultság, helyi folyamatváltozás, készlet- vagy eszközprobléma. Ne külön-külön kezeld a tüneteket.";
  return"CAPA/root-cause vizsgálat szükséges: a korábbi lezárás nem szüntette meg tartósan a kiváltó okot. Ellenőrizd a korábbi resolution evidence-t és a visszatérés időpontját.";
}

export async function rebuildExceptionRootCauseClusters(){
  await ensureExceptionIntelligenceSchema();const rows=await activeCases();const candidates=buildClusterCandidates(rows);const seen:string[]=[];
  for(const group of candidates){
    seen.push(group.key);const sources=unique(group.cases.map(x=>x.source_type));const first=new Date(Math.min(...group.cases.map(x=>new Date(x.first_detected_at).getTime())));const last=new Date(Math.max(...group.cases.map(x=>new Date(x.last_detected_at).getTime())));
    const evidence={case_ids:group.cases.map(x=>x.id),sources,reason:group.reason,recommendation:rootCauseAdvice(group.type),occurrences:group.cases.reduce((sum,x)=>sum+n(x.occurrence_count),0)};
    const cluster=(await db.query(`INSERT INTO exception_root_cause_clusters(cluster_key,cluster_type,severity,title,summary,status,location_id,case_count,source_count,first_seen_at,last_seen_at,evidence)
      VALUES($1,$2,$3,$4,$5,'active',$6,$7,$8,$9,$10,$11::jsonb)
      ON CONFLICT(cluster_key) DO UPDATE SET severity=EXCLUDED.severity,title=EXCLUDED.title,summary=EXCLUDED.summary,status='active',location_id=EXCLUDED.location_id,
        case_count=EXCLUDED.case_count,source_count=EXCLUDED.source_count,first_seen_at=LEAST(exception_root_cause_clusters.first_seen_at,EXCLUDED.first_seen_at),last_seen_at=EXCLUDED.last_seen_at,
        resolved_at=NULL,evidence=EXCLUDED.evidence,updated_at=now() RETURNING id::text`,[
        group.key,group.type,severityMax(group.cases),group.title,group.summary,group.location_id,group.cases.length,sources.length,first,last,JSON.stringify(evidence)
      ])).rows[0];
    for(const item of group.cases)await db.query(`INSERT INTO exception_root_cause_cluster_cases(cluster_id,case_id,reason) VALUES($1::uuid,$2::uuid,$3) ON CONFLICT(cluster_id,case_id) DO UPDATE SET reason=EXCLUDED.reason`,[cluster.id,item.id,group.reason]);
  }
  if(seen.length)await db.query(`UPDATE exception_root_cause_clusters SET status='resolved',resolved_at=COALESCE(resolved_at,now()),updated_at=now() WHERE status='active' AND NOT(cluster_key=ANY($1::text[]))`,[seen]);
  else await db.query(`UPDATE exception_root_cause_clusters SET status='resolved',resolved_at=COALESCE(resolved_at,now()),updated_at=now() WHERE status='active'`);
  return{active_clusters:candidates.length,linked_cases:candidates.reduce((sum,x)=>sum+x.cases.length,0),generated_at:new Date().toISOString()};
}

export async function takeExceptionIntelligenceSnapshot(){
  await ensureExceptionIntelligenceSchema();const summary=await exceptionCenterSummary(null);
  const clusters=n((await db.query(`SELECT COUNT(*)::int count FROM exception_root_cause_clusters WHERE status='active'`)).rows[0]?.count);
  const escalated=n((await db.query(`SELECT COUNT(DISTINCT case_id)::int count FROM exception_case_escalations WHERE created_at>=now()-interval '24 hours'`)).rows[0]?.count);
  const recurring=n((await db.query(`SELECT COUNT(*)::int count FROM exception_cases WHERE status=ANY($1::text[]) AND occurrence_count>=3`,[ACTIVE_STATUSES])).rows[0]?.count);
  const payload={...summary,active_clusters:clusters,escalated_24h:escalated,recurring_open:recurring};
  await db.query(`INSERT INTO exception_intelligence_snapshots(bucket_at,payload)
    VALUES(date_trunc('hour',now())+floor(extract(minute from now())/15)*interval '15 minutes',$1::jsonb)
    ON CONFLICT(bucket_at) DO UPDATE SET payload=EXCLUDED.payload,updated_at=now()`,[JSON.stringify(payload)]);
  return payload;
}

function withSlaCompliance(rows:any[]){return rows.map(row=>{const total=n(row.total),breached=n(row.breached);return{...row,sla_compliance_pct:total?Math.round((1-breached/total)*1000)/10:100}})}

export async function getExceptionIntelligenceDashboard(days=30,locationId:string|null=null){
  await ensureExceptionIntelligenceSchema();const d=Math.max(1,Math.min(180,n(days)||30));const summary=await exceptionCenterSummary(locationId);
  const trend=(await db.query(`WITH dates AS(SELECT generate_series((CURRENT_DATE-($1::int-1)),CURRENT_DATE,interval '1 day')::date day)
    SELECT d.day::text,
      COUNT(c.id) FILTER(WHERE (c.first_detected_at AT TIME ZONE '${TZ}')::date=d.day)::int created,
      COUNT(c.id) FILTER(WHERE c.severity='critical' AND (c.first_detected_at AT TIME ZONE '${TZ}')::date=d.day)::int critical_created,
      COUNT(c.id) FILTER(WHERE c.resolved_at IS NOT NULL AND (c.resolved_at AT TIME ZONE '${TZ}')::date=d.day)::int resolved,
      COUNT(c.id) FILTER(WHERE c.breached_at IS NOT NULL AND (c.breached_at AT TIME ZONE '${TZ}')::date=d.day)::int breached
    FROM dates d LEFT JOIN exception_cases c ON ($2::text IS NULL OR c.location_id=$2)
      AND ((c.first_detected_at AT TIME ZONE '${TZ}')::date=d.day OR (c.resolved_at AT TIME ZONE '${TZ}')::date=d.day OR (c.breached_at AT TIME ZONE '${TZ}')::date=d.day)
    GROUP BY d.day ORDER BY d.day`,[d,locationId])).rows;
  const category=(await db.query(`SELECT category,COUNT(*)::int total,COUNT(*) FILTER(WHERE status=ANY($2::text[]))::int active,
      COUNT(*) FILTER(WHERE severity='critical')::int critical,COUNT(*) FILTER(WHERE breached_at IS NOT NULL)::int breached,
      COALESCE(SUM(GREATEST(occurrence_count-1,0)),0)::bigint recurrence_events
    FROM exception_cases WHERE first_detected_at>=now()-($1::text||' days')::interval AND ($3::text IS NULL OR location_id=$3)
    GROUP BY category ORDER BY total DESC`,[d,ACTIVE_STATUSES,locationId])).rows;
  const teams=withSlaCompliance((await db.query(`SELECT COALESCE(team_key,'unassigned') team_key,COUNT(*)::int total,
      COUNT(*) FILTER(WHERE status=ANY($2::text[]))::int active,COUNT(*) FILTER(WHERE resolved_at IS NOT NULL)::int resolved,
      COUNT(*) FILTER(WHERE breached_at IS NOT NULL)::int breached,
      ROUND(AVG(EXTRACT(EPOCH FROM (acknowledged_at-first_detected_at))/60) FILTER(WHERE acknowledged_at IS NOT NULL),1) avg_ack_minutes,
      ROUND(AVG(EXTRACT(EPOCH FROM (resolved_at-first_detected_at))/60) FILTER(WHERE resolved_at IS NOT NULL),1) avg_resolution_minutes
    FROM exception_cases WHERE first_detected_at>=now()-($1::text||' days')::interval AND ($3::text IS NULL OR location_id=$3)
    GROUP BY COALESCE(team_key,'unassigned') ORDER BY total DESC`,[d,ACTIVE_STATUSES,locationId])).rows);
  const owners=withSlaCompliance((await db.query(`SELECT owner_key,MAX(owner_name) owner_name,COUNT(*)::int total,
      COUNT(*) FILTER(WHERE status=ANY($2::text[]))::int active,COUNT(*) FILTER(WHERE resolved_at IS NOT NULL)::int resolved,
      COUNT(*) FILTER(WHERE breached_at IS NOT NULL)::int breached,
      ROUND(AVG(EXTRACT(EPOCH FROM (acknowledged_at-first_detected_at))/60) FILTER(WHERE acknowledged_at IS NOT NULL),1) avg_ack_minutes,
      ROUND(AVG(EXTRACT(EPOCH FROM (resolved_at-first_detected_at))/60) FILTER(WHERE resolved_at IS NOT NULL),1) avg_resolution_minutes
    FROM exception_cases WHERE owner_key IS NOT NULL AND first_detected_at>=now()-($1::text||' days')::interval AND ($3::text IS NULL OR location_id=$3)
    GROUP BY owner_key ORDER BY total DESC LIMIT 50`,[d,ACTIVE_STATUSES,locationId])).rows);
  const recurring=(await db.query(`SELECT id::text,exception_key,title,category,severity,status,location_id,owner_name,occurrence_count,last_detected_at,resolution_note
    FROM exception_cases WHERE occurrence_count>=2 AND first_detected_at>=now()-($1::text||' days')::interval AND ($2::text IS NULL OR location_id=$2)
    ORDER BY occurrence_count DESC,last_detected_at DESC LIMIT 50`,[d,locationId])).rows;
  const clusters=(await db.query(`SELECT c.*,COALESCE(json_agg(json_build_object('case_id',cc.case_id::text,'reason',cc.reason)) FILTER(WHERE cc.case_id IS NOT NULL),'[]'::json) linked_cases
    FROM exception_root_cause_clusters c LEFT JOIN exception_root_cause_cluster_cases cc ON cc.cluster_id=c.id
    WHERE c.status='active' AND ($1::text IS NULL OR c.location_id=$1 OR c.location_id IS NULL)
    GROUP BY c.id ORDER BY CASE c.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,c.case_count DESC,c.last_seen_at DESC LIMIT 50`,[locationId])).rows;
  const escalations=(await db.query(`SELECT e.id,e.case_id::text,e.occurrence_no,e.escalation_level,e.trigger_code,e.recipient,e.status,e.detail,e.created_at,c.title,c.category,c.severity,c.location_id,c.owner_name
    FROM exception_case_escalations e JOIN exception_cases c ON c.id=e.case_id
    WHERE e.created_at>=now()-($1::text||' days')::interval AND ($2::text IS NULL OR c.location_id=$2)
    ORDER BY e.created_at DESC LIMIT 100`,[d,locationId])).rows;
  const hotspots=(await db.query(`SELECT COALESCE(location_id,'__all__') location_id,category,COUNT(*)::int active,
      COUNT(*) FILTER(WHERE severity='critical')::int critical,COUNT(*) FILTER(WHERE sla_state='breached')::int breached
    FROM exception_cases WHERE status=ANY($1::text[]) AND ($2::text IS NULL OR location_id=$2)
    GROUP BY COALESCE(location_id,'__all__'),category HAVING COUNT(*)>=2
    ORDER BY critical DESC,breached DESC,active DESC LIMIT 30`,[ACTIVE_STATUSES,locationId])).rows;
  const snapshots=(await db.query(`SELECT bucket_at,payload FROM exception_intelligence_snapshots WHERE bucket_at>=now()-($1::text||' days')::interval ORDER BY bucket_at`,[Math.min(d,14)])).rows;
  const active=n(summary.open),critical=n(summary.critical),breached=n(summary.breached),unassigned=n(summary.unassigned);
  const recurrenceTotal=recurring.reduce((sum:any,row:any)=>sum+Math.max(0,n(row.occurrence_count)-1),0);
  const score=Math.max(0,Math.round(100-Math.min(35,critical*10)-Math.min(30,breached*6)-Math.min(15,unassigned*2)-Math.min(20,clusters.length*3)));
  const recommendations:string[]=[];
  if(critical)recommendations.push(`${critical} kritikus ügy aktív: azonnali vezetői triage és felelőskiosztás szükséges.`);
  if(breached)recommendations.push(`${breached} SLA-sértett ügy van: vizsgáld felül a kapacitást, routingot és az eszkalációs szinteket.`);
  if(unassigned)recommendations.push(`${unassigned} ügy kiosztatlan: a routing csapat mellé konkrét felelős szükséges.`);
  if(clusters.length)recommendations.push(`${clusters.length} aktív root-cause klaszter látható: a klasztert egyben kezeld, ne külön tünetekként.`);
  if(recurrenceTotal)recommendations.push(`${recurrenceTotal} ismétlődési esemény látható: a visszatérő ügyeknél CAPA/root-cause ellenőrzés javasolt.`);
  if(!recommendations.length)recommendations.push("Nincs kiemelt Exception Intelligence beavatkozási jelzés.");
  return{period_days:d,location_id:locationId,generated_at:new Date().toISOString(),health:{score,status:score<60?"critical":score<80?"warning":"ok",active,critical,breached,unassigned,active_clusters:clusters.length,recurrence_events:recurrenceTotal},summary,trend,category,teams,owners,recurring,clusters,escalations,hotspots,snapshots,recommendations};
}

export async function listExceptionEscalationRules(){await ensureExceptionIntelligenceSchema();return(await db.query(`SELECT * FROM exception_escalation_rules ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`)).rows}
export async function updateExceptionEscalationRule(severity:string,input:any,actor:string){
  await ensureExceptionIntelligenceSchema();const sev=safe(severity);const current=(await db.query(`SELECT * FROM exception_escalation_rules WHERE severity=$1`,[sev])).rows[0];if(!current)throw Object.assign(new Error("Ismeretlen eszkalációs súlyosság."),{status:404});
  const value=(name:string,fallback:number)=>Math.max(5,Math.min(43200,n(input[name]??fallback)));
  const l1=value("level1_after_minutes",current.level1_after_minutes),l2=value("level2_after_minutes",current.level2_after_minutes),l3=value("level3_after_minutes",current.level3_after_minutes);
  if(!(l1<l2&&l2<l3))throw Object.assign(new Error("Az eszkalációs idők sorrendje kötelező: L1 < L2 < L3."),{status:400});
  return(await db.query(`UPDATE exception_escalation_rules SET level1_after_minutes=$2,level2_after_minutes=$3,level3_after_minutes=$4,active=$5,updated_by=$6,updated_at=now() WHERE severity=$1 RETURNING *`,[sev,l1,l2,l3,input.active===undefined?current.active:Boolean(input.active),actor])).rows[0];
}

export async function runExceptionIntelligenceCycle(){
  if(cyclePromise)return cyclePromise;
  cyclePromise=(async()=>{await ensureExceptionIntelligenceSchema();const escalations=await runExceptionEscalations();const clusters=await rebuildExceptionRootCauseClusters();const snapshot=await takeExceptionIntelligenceSnapshot();return{ok:true,escalations,clusters,snapshot,generated_at:new Date().toISOString()}})().finally(()=>{cyclePromise=null});
  return cyclePromise;
}

export async function sendExceptionExecutiveBrief(briefType:"morning"|"evening"){
  await ensureExceptionIntelligenceSchema();const businessDate=budapestDate();const dashboard=await getExceptionIntelligenceDashboard(7,null);const recipients=await getApmAdminRecipients();
  const effective=recipients.length?recipients:["unconfigured-admin-recipient"];let sent=0,failed=0,logged=0;
  const topClusters=(dashboard.clusters as any[]).slice(0,5).map((x:any,i:number)=>`${i+1}. [${String(x.severity).toUpperCase()}] ${x.title} · ${x.case_count} ügy`).join("\n")||"Nincs aktív root-cause klaszter.";
  const text=[
    `VIR Exception Command Center ${briefType==="morning"?"reggeli":"esti"} vezetői brief.`,"",
    `Health score: ${dashboard.health.score}/100 (${dashboard.health.status})`,
    `Aktív: ${dashboard.health.active}`,
    `Kritikus: ${dashboard.health.critical}`,
    `SLA-sértett: ${dashboard.health.breached}`,
    `Kiosztatlan: ${dashboard.health.unassigned}`,
    `Root-cause klaszter: ${dashboard.health.active_clusters}`,
    `Ismétlődési esemény: ${dashboard.health.recurrence_events}`,"",
    "Kiemelt klaszterek:",topClusters,"",
    "Javaslatok:",...(dashboard.recommendations as string[]).map((x:string)=>`- ${x}`),"",
    "VIR → Statisztika és VIR → Exception Intelligence"
  ].join("\n");
  const subject=`[EXECUTIVE ${briefType.toUpperCase()}] VIR Exception Intelligence · ${dashboard.health.score}/100`;
  for(const recipient of effective){
    const exists=(await db.query(`SELECT 1 FROM exception_executive_brief_deliveries WHERE business_date=$1::date AND brief_type=$2 AND recipient=$3`,[businessDate,briefType,recipient])).rows[0];if(exists)continue;
    let status:"sent"|"failed"|"logged"="logged",errorText:string|null=null;
    if(recipient!=="unconfigured-admin-recipient"){
      try{const result:any=await sendEmail({to:recipient,subject,text});status=result?.sent?"sent":"logged";if(result?.logged)errorText="SMTP nem küldött; naplózva."}
      catch(error:any){status="failed";errorText=error?.message||String(error)}
    }else errorText="Nincs konfigurált admin e-mail cím.";
    await db.query(`INSERT INTO exception_executive_brief_deliveries(business_date,brief_type,recipient,status,error_text,payload) VALUES($1::date,$2,$3,$4,$5,$6::jsonb) ON CONFLICT DO NOTHING`,[businessDate,briefType,recipient,status,errorText,JSON.stringify({health:dashboard.health,recommendations:dashboard.recommendations})]);
    if(status==="sent")sent++;else if(status==="failed")failed++;else logged++;
  }
  return{business_date:businessDate,brief_type:briefType,recipients:effective.length,sent,failed,logged};
}

export function startExceptionCommandCenterIntelligenceScheduler(){
  if(started||process.env.EXCEPTION_CENTER_DISABLED==="1"||process.env.NODE_ENV==="test")return;started=true;
  cron.schedule("4-59/5 * * * *",()=>{void runExceptionIntelligenceCycle().catch(error=>console.error("[exception-intelligence] scheduled cycle failed",error))},{timezone:TZ});
  cron.schedule("0 8 * * *",()=>{void sendExceptionExecutiveBrief("morning").catch(error=>console.error("[exception-intelligence] morning brief failed",error))},{timezone:TZ});
  cron.schedule("30 19 * * *",()=>{void sendExceptionExecutiveBrief("evening").catch(error=>console.error("[exception-intelligence] evening brief failed",error))},{timezone:TZ});
  const timer=setTimeout(()=>{void runExceptionIntelligenceCycle().catch(error=>console.error("[exception-intelligence] initial cycle failed",error))},95_000);timer.unref?.();
  console.log("[exception-intelligence] escalation, root-cause correlation and snapshots scheduled Europe/Budapest");
}
