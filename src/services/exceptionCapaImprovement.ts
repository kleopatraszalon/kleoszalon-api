import db from "../db";
import ensureManagementImprovement from "../management/ensureManagementImprovement";
import { ensureExceptionCapaSchema } from "./exceptionCapa";

let schemaPromise: Promise<void> | null = null;
const text = (value: unknown) => String(value ?? "").trim();

function httpError(message: string, status: number) {
  return Object.assign(new Error(message), { status });
}

export async function ensureExceptionCapaImprovementBridge() {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await ensureExceptionCapaSchema();
      await ensureManagementImprovement();
      await db.query(`
        CREATE TABLE IF NOT EXISTS exception_capa_improvement_links(
          capa_id uuid NOT NULL REFERENCES exception_capa_candidates(id) ON DELETE RESTRICT,
          tenant_id bigint NOT NULL,
          project_id uuid NOT NULL REFERENCES management_improvement_projects(id) ON DELETE RESTRICT,
          source_status text NOT NULL,
          source_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
          created_by text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY(capa_id,tenant_id),
          UNIQUE(project_id)
        );
        CREATE INDEX IF NOT EXISTS exception_capa_improvement_tenant_idx
          ON exception_capa_improvement_links(tenant_id,created_at DESC);
      `);
    })().catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

function improvementCode(capaId: string) {
  return `CI-CAPA-${capaId.replace(/-/g, "").slice(0, 12).toUpperCase()}`;
}

function projectPriority(severity: string) {
  if (severity === "critical") return "critical";
  if (severity === "high") return "high";
  if (severity === "low") return "low";
  return "normal";
}

function sourceEvidence(capa: any) {
  const captured = capa.approved_at || capa.updated_at || capa.created_at || new Date().toISOString();
  return {
    id: `exception-capa-${capa.id}`,
    kind: "record",
    title: "Exception CAPA forrásrekord",
    reference: `CAPA:${capa.id}`,
    captured_at: String(captured).slice(0, 10),
    notes: `Exception Intelligence klaszter: ${capa.cluster_key || capa.cluster_id}; státusz: ${capa.status}; súlyosság: ${capa.severity}.`,
  };
}

export async function getExceptionCapaImprovementLink(capaId: string, tenantId: string) {
  await ensureExceptionCapaImprovementBridge();
  return (await db.query(
    `SELECT l.*,p.code project_code,p.title project_title,p.status project_status,p.approval_state
       FROM exception_capa_improvement_links l
       JOIN management_improvement_projects p ON p.id=l.project_id
      WHERE l.capa_id=$1::uuid AND l.tenant_id=$2::bigint`,
    [capaId, tenantId],
  )).rows[0] || null;
}

export async function promoteExceptionCapaToImprovement(input: {
  capaId: string;
  tenantId: string;
  actor: string;
  actorUserId?: string | null;
  requestIp?: string | null;
  locationId?: string | null;
}) {
  await ensureExceptionCapaImprovementBridge();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${input.tenantId}:${input.capaId}`]);
    const existing = (await client.query(
      `SELECT l.*,p.code project_code,p.title project_title,p.status project_status,p.approval_state
         FROM exception_capa_improvement_links l
         JOIN management_improvement_projects p ON p.id=l.project_id
        WHERE l.capa_id=$1::uuid AND l.tenant_id=$2::bigint
        FOR UPDATE OF l`,
      [input.capaId, input.tenantId],
    )).rows[0];
    if (existing) {
      await client.query("COMMIT");
      return { created: false, project: { id: existing.project_id, code: existing.project_code, title: existing.project_title, status: existing.project_status, approval_state: existing.approval_state }, link: existing };
    }

    const capa = (await client.query(
      `SELECT c.*,rc.cluster_key,rc.cluster_type,rc.location_id,rc.case_count,rc.source_count,rc.evidence cluster_evidence
         FROM exception_capa_candidates c
         JOIN exception_root_cause_clusters rc ON rc.id=c.cluster_id
        WHERE c.id=$1::uuid
        FOR UPDATE OF c`,
      [input.capaId],
    )).rows[0];
    if (!capa) throw httpError("A CAPA rekord nem található.", 404);
    if (!["approved", "in_progress", "verification", "verified"].includes(String(capa.status))) {
      throw httpError("Fejlesztési projekt csak ember által jóváhagyott CAPA rekordból indítható.", 409);
    }

    const sourceLocation = text(capa.location_id) || null;
    const requestedLocation = text(input.locationId) || null;
    if (sourceLocation && requestedLocation && sourceLocation !== requestedLocation) {
      throw httpError("A fejlesztési projekt telephelye nem térhet el a forrás CAPA telephelyétől.", 409);
    }
    const projectLocation = sourceLocation || requestedLocation;
    const code = improvementCode(String(capa.id));
    const ownerName = text(capa.owner_key) || text(capa.owner_team) || null;
    const dueDate = capa.due_at ? String(capa.due_at).slice(0, 10) : null;
    const evidence = sourceEvidence(capa);
    const analysisData = {
      summary: `A projekt az Exception Intelligence által azonosított ${capa.cluster_type || "root-cause"} klaszter jóváhagyott CAPA rekordjából indult.`,
      lessons_learned: "",
      evidence: [evidence],
      integration: {
        source: "exception-capa",
        capa_id: capa.id,
        cluster_id: capa.cluster_id,
        cluster_key: capa.cluster_key,
        cluster_type: capa.cluster_type,
        severity: capa.severity,
        source_status: capa.status,
        approved_by: capa.approved_by || null,
        approved_at: capa.approved_at || null,
        case_count: Number(capa.case_count || 0),
        source_count: Number(capa.source_count || 0),
      },
    };
    const project = (await client.query(
      `INSERT INTO management_improvement_projects(
        tenant_id,location_id,code,title,problem_statement,objective,methodology,analysis_data,
        owner_employee_id,owner_name,priority,status,start_date,due_date,created_by
      ) VALUES(
        $1::bigint,$2,$3,$4,$5,$6,$7::text[],$8::jsonb,
        NULL,$9,$10,'active',CURRENT_DATE,$11::date,$12
      ) RETURNING *`,
      [
        input.tenantId,
        projectLocation,
        code,
        `Exception CAPA fejlesztés · ${String(capa.title || "Fejlesztési projekt").replace(/^CAPA\s*·\s*/i, "")}`,
        `${capa.problem_statement}\n\nGyökérok-hipotézis: ${capa.root_cause_hypothesis}`,
        `Javító intézkedés: ${capa.corrective_action}\n\nMegelőző intézkedés: ${capa.preventive_action}`,
        ["CAPA", "PDCA", "Exception Intelligence", "Root Cause Analysis"],
        JSON.stringify(analysisData),
        ownerName,
        projectPriority(String(capa.severity)),
        dueDate,
        input.actor,
      ],
    )).rows[0];

    const actionRows = [
      {
        type: "corrective",
        title: "Javító intézkedés",
        description: String(capa.corrective_action || ""),
        rootCause: String(capa.root_cause_hypothesis || ""),
        criteria: "A kiváltó ok megszűnését és az érintett Exception folyamat helyreállását igazolni kell.",
      },
      {
        type: "preventive",
        title: "Megelőző intézkedés",
        description: String(capa.preventive_action || ""),
        rootCause: String(capa.root_cause_hypothesis || ""),
        criteria: "A megelőző kontroll bevezetését és a visszatérés elleni eredményességét igazolni kell.",
      },
    ];
    for (const action of actionRows) {
      const row = (await client.query(
        `INSERT INTO management_improvement_actions(
          project_id,tenant_id,action_type,title,description,root_cause,owner_employee_id,owner_name,due_date,status,effectiveness_criteria,created_by
        ) VALUES($1::uuid,$2::bigint,$3,$4,$5,$6,NULL,$7,$8::date,'open',$9,$10) RETURNING *`,
        [project.id, input.tenantId, action.type, action.title, action.description, action.rootCause, ownerName, dueDate, action.criteria, input.actor],
      )).rows[0];
      await client.query(
        `INSERT INTO management_improvement_audit(project_id,tenant_id,entity_type,entity_id,action,actor_user_id,actor,changes,request_ip)
         VALUES($1::uuid,$2::bigint,'action',$3,'action.created_from_exception_capa',$4,$5,$6::jsonb,$7)`,
        [project.id, input.tenantId, row.id, input.actorUserId || null, input.actor, JSON.stringify({ after: row, source_capa_id: capa.id }), input.requestIp || null],
      );
    }

    const kpi = (await client.query(
      `INSERT INTO management_improvement_kpis(
        project_id,tenant_id,metric_key,name,unit,direction,before_value,target_value,before_at,source,notes,created_by
      ) VALUES($1::uuid,$2::bigint,'exception_case_count','Kapcsolt Exception case-ek száma','db','lower_better',$3::numeric,0,now(),$4,$5,$6)
      RETURNING *`,
      [project.id, input.tenantId, Number(capa.case_count || 0), "Exception Intelligence root-cause klaszter", `Forrás CAPA: ${capa.id}; klaszter: ${capa.cluster_key || capa.cluster_id}.`, input.actor],
    )).rows[0];

    const snapshot = {
      id: capa.id,
      cluster_id: capa.cluster_id,
      cluster_key: capa.cluster_key,
      cluster_type: capa.cluster_type,
      status: capa.status,
      severity: capa.severity,
      title: capa.title,
      problem_statement: capa.problem_statement,
      root_cause_hypothesis: capa.root_cause_hypothesis,
      corrective_action: capa.corrective_action,
      preventive_action: capa.preventive_action,
      owner_team: capa.owner_team,
      owner_key: capa.owner_key,
      due_at: capa.due_at,
      approved_by: capa.approved_by,
      approved_at: capa.approved_at,
      case_count: Number(capa.case_count || 0),
      source_count: Number(capa.source_count || 0),
    };
    const link = (await client.query(
      `INSERT INTO exception_capa_improvement_links(capa_id,tenant_id,project_id,source_status,source_snapshot,created_by)
       VALUES($1::uuid,$2::bigint,$3::uuid,$4,$5::jsonb,$6) RETURNING *`,
      [capa.id, input.tenantId, project.id, capa.status, JSON.stringify(snapshot), input.actor],
    )).rows[0];

    await client.query(
      `INSERT INTO management_improvement_audit(project_id,tenant_id,entity_type,entity_id,action,actor_user_id,actor,changes,request_ip)
       VALUES($1::uuid,$2::bigint,'integration',$3,'exception_capa.promoted',$4,$5,$6::jsonb,$7)`,
      [project.id, input.tenantId, String(capa.id), input.actorUserId || null, input.actor, JSON.stringify({ source: snapshot, project_id: project.id, project_code: project.code, kpi_id: kpi.id }), input.requestIp || null],
    );
    await client.query(
      `INSERT INTO exception_capa_events(capa_id,event_type,actor_key,message,evidence)
       VALUES($1::uuid,'improvement_project_created',$2,$3,$4::jsonb)`,
      [capa.id, input.actor, `Fejlesztési projekt létrehozva: ${project.code}.`, JSON.stringify({ tenant_id: input.tenantId, project_id: project.id, project_code: project.code, location_id: projectLocation })],
    );

    await client.query("COMMIT");
    return { created: true, project, link, kpi };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
