import db from "../db";
import { ensureExceptionCapaImprovementRecommendationSchema } from "./exceptionCapaImprovementRecommendation";

const safe=(value:unknown)=>String(value??"").trim();
const n=(value:unknown)=>{const parsed=Number(value??0);return Number.isFinite(parsed)?parsed:0};

function locationClause(locationId:string|null,paramIndex:number){
  return locationId?` AND rc.location_id=$${paramIndex}::text`:"";
}

export async function exceptionCapaImprovementQueueSummary(tenantId:string,locationId:string|null=null){
  await ensureExceptionCapaImprovementRecommendationSchema();
  const params:any[]=[tenantId];
  if(locationId)params.push(locationId);
  const row=(await db.query(`SELECT
      COUNT(*)::int total,
      COUNT(*) FILTER(WHERE r.status='recommended')::int recommended,
      COUNT(*) FILTER(WHERE r.status='monitoring')::int monitoring,
      COUNT(*) FILTER(WHERE r.status='dismissed')::int dismissed,
      COUNT(*) FILTER(WHERE r.score>=80)::int high_risk,
      COUNT(*) FILTER(WHERE c.severity='critical' AND c.status NOT IN('verified','rejected'))::int critical_open,
      COUNT(*) FILTER(WHERE r.suggested_due_at<now() AND c.status NOT IN('verified','rejected') AND l.project_id IS NULL)::int overdue,
      COUNT(*) FILTER(WHERE COALESCE(NULLIF(trim(c.owner_key),''),NULLIF(trim(c.owner_team),'')) IS NULL AND c.status NOT IN('verified','rejected'))::int owner_missing,
      COUNT(*) FILTER(WHERE r.status='recommended' AND c.status='approved' AND l.project_id IS NULL)::int ready_to_promote,
      COUNT(*) FILTER(WHERE l.project_id IS NOT NULL)::int project_created,
      COALESCE(ROUND(AVG(r.score)::numeric,1),0)::numeric average_score
    FROM exception_capa_improvement_recommendations r
    JOIN exception_capa_candidates c ON c.id=r.capa_id
    JOIN exception_root_cause_clusters rc ON rc.id=c.cluster_id
    JOIN locations tenant_location ON tenant_location.id::text=rc.location_id AND tenant_location.tenant_id=$1::bigint
    LEFT JOIN exception_capa_improvement_links l ON l.capa_id=c.id AND l.tenant_id=$1::bigint
    WHERE 1=1${locationClause(locationId,2)}`,[...params])).rows[0]||{};
  return{...row,location_id:locationId,generated_at:new Date().toISOString()};
}

export async function listExceptionCapaImprovementQueue(tenantId:string,filters:any={}){
  await ensureExceptionCapaImprovementRecommendationSchema();
  const params:any[]=[tenantId];
  const where:string[]=[];
  const add=(sql:string,value:any)=>{params.push(value);where.push(sql.replace("?",`$${params.length}`))};
  const locationId=safe(filters.location_id);
  if(locationId)add("rc.location_id=?::text",locationId);
  const status=safe(filters.status).toLowerCase();
  if(status&&status!=="all"&&["recommended","monitoring","dismissed"].includes(status))add("r.status=?::text",status);
  const capaStatus=safe(filters.capa_status).toLowerCase();
  if(capaStatus&&capaStatus!=="all")add("c.status=?::text",capaStatus);
  const risk=safe(filters.risk).toLowerCase();
  if(risk==="critical")where.push("r.score>=80");
  else if(risk==="high")where.push("r.score>=50 AND r.score<80");
  else if(risk==="normal")where.push("r.score<50");
  const owner=safe(filters.owner).toLowerCase();
  if(owner==="missing")where.push("COALESCE(NULLIF(trim(c.owner_key),''),NULLIF(trim(c.owner_team),'')) IS NULL");
  else if(owner==="assigned")where.push("COALESCE(NULLIF(trim(c.owner_key),''),NULLIF(trim(c.owner_team),'')) IS NOT NULL");
  const project=safe(filters.project).toLowerCase();
  if(project==="created")where.push("l.project_id IS NOT NULL");
  else if(project==="pending")where.push("l.project_id IS NULL");
  if(String(filters.overdue||"")==="1")where.push("r.suggested_due_at<now() AND c.status NOT IN('verified','rejected') AND l.project_id IS NULL");
  if(String(filters.ready_to_promote||"")==="1")where.push("r.status='recommended' AND c.status='approved' AND l.project_id IS NULL");
  const q=safe(filters.q);
  if(q){params.push(`%${q}%`);const p=params.length;where.push(`(c.title ILIKE $${p} OR c.problem_statement ILIKE $${p} OR rc.cluster_key ILIKE $${p} OR COALESCE(c.owner_key,'') ILIKE $${p} OR COALESCE(c.owner_team,'') ILIKE $${p})`)}
  const limit=Math.max(20,Math.min(300,n(filters.limit)||150));params.push(limit);const limitParam=params.length;
  return(await db.query(`SELECT
      r.capa_id::text capa_id,r.status recommendation_status,r.score,r.reason_codes,r.suggested_due_at,
      r.suggested_owner_key,r.suggested_owner_team,r.suggested_kpi,r.recommended_at,r.dismissed_at,r.dismissed_by,r.dismissed_note,r.last_evaluated_at,
      c.status capa_status,c.severity,c.title,c.problem_statement,c.root_cause_hypothesis,c.owner_team,c.owner_key,c.due_at capa_due_at,c.approved_at,
      rc.cluster_key,rc.cluster_type,rc.location_id,rc.case_count,rc.source_count,
      l.project_id::text project_id,p.code project_code,p.title project_title,p.status project_status,p.approval_state,
      (r.suggested_due_at<now() AND c.status NOT IN('verified','rejected') AND l.project_id IS NULL) overdue,
      (COALESCE(NULLIF(trim(c.owner_key),''),NULLIF(trim(c.owner_team),'')) IS NULL) owner_missing,
      (r.status='recommended' AND c.status='approved' AND l.project_id IS NULL) ready_to_promote
    FROM exception_capa_improvement_recommendations r
    JOIN exception_capa_candidates c ON c.id=r.capa_id
    JOIN exception_root_cause_clusters rc ON rc.id=c.cluster_id
    JOIN locations tenant_location ON tenant_location.id::text=rc.location_id AND tenant_location.tenant_id=$1::bigint
    LEFT JOIN exception_capa_improvement_links l ON l.capa_id=c.id AND l.tenant_id=$1::bigint
    LEFT JOIN management_improvement_projects p ON p.id=l.project_id
    ${where.length?`WHERE ${where.join(" AND ")}`:""}
    ORDER BY
      CASE WHEN l.project_id IS NOT NULL THEN 4 WHEN r.status='recommended' AND c.status='approved' THEN 0 WHEN r.status='recommended' THEN 1 WHEN r.status='monitoring' THEN 2 ELSE 3 END,
      r.score DESC,r.suggested_due_at NULLS LAST,r.last_evaluated_at DESC
    LIMIT $${limitParam}`,params)).rows;
}
