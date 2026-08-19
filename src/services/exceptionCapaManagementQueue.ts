import db from "../db";
import { sendEmail } from "../mailer";
import { ensureExceptionCapaImprovementRecommendationSchema } from "./exceptionCapaImprovementRecommendation";

let schemaPromise: Promise<void> | null = null;
const safe = (value: unknown) => String(value ?? "").trim();
const emailLike = (value: unknown) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(safe(value));

export type CapaManagementQueueFilters = {
  status?: string | null;
  severity?: string | null;
  owner?: string | null;
  q?: string | null;
  locationId?: string | null;
  onlyOverdue?: boolean;
  onlyUnassigned?: boolean;
  limit?: number;
};

export async function ensureExceptionCapaManagementQueueSchema() {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await ensureExceptionCapaImprovementRecommendationSchema();
      await db.query(`
        ALTER TABLE exception_capa_improvement_recommendations
          ADD COLUMN IF NOT EXISTS assigned_owner_key text,
          ADD COLUMN IF NOT EXISTS assigned_owner_team text,
          ADD COLUMN IF NOT EXISTS assigned_by text,
          ADD COLUMN IF NOT EXISTS assigned_at timestamptz,
          ADD COLUMN IF NOT EXISTS acknowledged_by text,
          ADD COLUMN IF NOT EXISTS acknowledged_at timestamptz,
          ADD COLUMN IF NOT EXISTS management_note text,
          ADD COLUMN IF NOT EXISTS last_management_notice_at timestamptz;
        CREATE INDEX IF NOT EXISTS exception_capa_improvement_assignment_idx
          ON exception_capa_improvement_recommendations(assigned_owner_key,acknowledged_at,suggested_due_at,score DESC);
        CREATE TABLE IF NOT EXISTS exception_capa_management_notifications(
          id bigserial PRIMARY KEY,
          capa_id uuid NOT NULL REFERENCES exception_capa_candidates(id) ON DELETE CASCADE,
          recipient text NOT NULL,
          notification_type text NOT NULL,
          status text NOT NULL CHECK(status IN('sent','failed','logged')),
          error_text text,
          created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS exception_capa_management_notifications_idx
          ON exception_capa_management_notifications(capa_id,notification_type,created_at DESC);
      `);
    })().catch(error => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

function normalizedLimit(value: unknown) {
  const parsed = Number(value ?? 100);
  if (!Number.isFinite(parsed)) return 100;
  return Math.max(1, Math.min(500, Math.floor(parsed)));
}

function buildWhere(locationIds: string[], filters: CapaManagementQueueFilters) {
  const params: any[] = [locationIds];
  const where = ["rc.location_id::text = ANY($1::text[])"];
  const add = (sql: string, value: any) => {
    params.push(value);
    where.push(sql.replace("?", `$${params.length}`));
  };
  const status = safe(filters.status).toLowerCase();
  const severity = safe(filters.severity).toLowerCase();
  const owner = safe(filters.owner).toLowerCase();
  const q = safe(filters.q);
  const locationId = safe(filters.locationId);
  if (status && status !== "all") add("r.status=?", status);
  if (severity && severity !== "all") add("lower(c.severity)=?", severity);
  if (owner) add("lower(COALESCE(r.assigned_owner_key,r.assigned_owner_team,'')) LIKE ?", `%${owner}%`);
  if (q) add("(c.title ILIKE ? OR rc.cluster_key ILIKE ? OR COALESCE(c.problem_statement,'') ILIKE ?)", `%${q}%`), params.push(`%${q}%`, `%${q}%`);
  if (locationId) add("rc.location_id::text=?", locationId);
  if (filters.onlyOverdue) where.push("r.suggested_due_at < now() AND l.project_id IS NULL AND r.status <> 'dismissed'");
  if (filters.onlyUnassigned) where.push("NULLIF(trim(COALESCE(r.assigned_owner_key,r.assigned_owner_team,'')),'') IS NULL");
  return { where: where.join(" AND "), params };
}

const queueSelect = `
  SELECT
    r.capa_id::text capa_id,
    r.status recommendation_status,
    r.score,
    r.reason_codes,
    r.suggested_due_at,
    r.suggested_owner_key,
    r.suggested_owner_team,
    r.suggested_kpi,
    r.assigned_owner_key,
    r.assigned_owner_team,
    r.assigned_by,
    r.assigned_at,
    r.acknowledged_by,
    r.acknowledged_at,
    r.management_note,
    r.last_evaluated_at,
    c.title,
    c.status capa_status,
    c.severity,
    c.problem_statement,
    c.root_cause_hypothesis,
    c.corrective_action,
    c.preventive_action,
    rc.cluster_key,
    rc.cluster_type,
    rc.location_id::text location_id,
    rc.case_count,
    rc.source_count,
    l.project_id::text project_id,
    p.code project_code,
    p.title project_title,
    p.status project_status,
    p.approval_state project_approval_state,
    (r.suggested_due_at < now() AND l.project_id IS NULL AND r.status <> 'dismissed') overdue,
    (NULLIF(trim(COALESCE(r.assigned_owner_key,r.assigned_owner_team,'')),'') IS NULL) unassigned,
    (c.status='approved' AND r.status='recommended' AND l.project_id IS NULL) ready_to_promote
  FROM exception_capa_improvement_recommendations r
  JOIN exception_capa_candidates c ON c.id=r.capa_id
  JOIN exception_root_cause_clusters rc ON rc.id=c.cluster_id
  LEFT JOIN exception_capa_improvement_links l ON l.capa_id=c.id
  LEFT JOIN management_improvement_projects p ON p.id=l.project_id
`;

export async function listExceptionCapaManagementQueue(locationIds: string[], filters: CapaManagementQueueFilters = {}) {
  await ensureExceptionCapaManagementQueueSchema();
  if (!locationIds.length) return { items: [], total: 0 };
  const { where, params } = buildWhere(locationIds, filters);
  params.push(normalizedLimit(filters.limit));
  const { rows } = await db.query(`${queueSelect}
    WHERE ${where}
    ORDER BY
      CASE WHEN lower(c.severity)='critical' THEN 4 WHEN lower(c.severity)='high' THEN 3 WHEN lower(c.severity)='medium' THEN 2 ELSE 1 END DESC,
      r.score DESC,
      CASE WHEN r.suggested_due_at < now() THEN 0 ELSE 1 END,
      r.suggested_due_at NULLS LAST,
      r.last_evaluated_at DESC
    LIMIT $${params.length}`, params);
  return { items: rows, total: rows.length };
}

export async function getExceptionCapaManagementQueueSummary(locationIds: string[]) {
  await ensureExceptionCapaManagementQueueSchema();
  if (!locationIds.length) return { total: 0, recommended: 0, monitoring: 0, dismissed: 0, critical: 0, high: 0, overdue: 0, unassigned: 0, needs_ack: 0, ready_to_promote: 0, linked_projects: 0 };
  const { rows } = await db.query(`
    SELECT
      count(*)::int total,
      count(*) FILTER(WHERE r.status='recommended')::int recommended,
      count(*) FILTER(WHERE r.status='monitoring')::int monitoring,
      count(*) FILTER(WHERE r.status='dismissed')::int dismissed,
      count(*) FILTER(WHERE lower(c.severity)='critical' AND r.status<>'dismissed')::int critical,
      count(*) FILTER(WHERE lower(c.severity)='high' AND r.status<>'dismissed')::int high,
      count(*) FILTER(WHERE r.suggested_due_at<now() AND l.project_id IS NULL AND r.status<>'dismissed')::int overdue,
      count(*) FILTER(WHERE NULLIF(trim(COALESCE(r.assigned_owner_key,r.assigned_owner_team,'')),'') IS NULL AND r.status='recommended' AND l.project_id IS NULL)::int unassigned,
      count(*) FILTER(WHERE NULLIF(trim(COALESCE(r.assigned_owner_key,r.assigned_owner_team,'')),'') IS NOT NULL AND r.acknowledged_at IS NULL AND r.status='recommended' AND l.project_id IS NULL)::int needs_ack,
      count(*) FILTER(WHERE c.status='approved' AND r.status='recommended' AND l.project_id IS NULL)::int ready_to_promote,
      count(*) FILTER(WHERE l.project_id IS NOT NULL)::int linked_projects
    FROM exception_capa_improvement_recommendations r
    JOIN exception_capa_candidates c ON c.id=r.capa_id
    JOIN exception_root_cause_clusters rc ON rc.id=c.cluster_id
    LEFT JOIN exception_capa_improvement_links l ON l.capa_id=c.id
    WHERE rc.location_id::text = ANY($1::text[])
  `, [locationIds]);
  return rows[0] || {};
}

async function managementEvent(capaId: string, eventType: string, actor: string, message: string, evidence: any) {
  await db.query(`INSERT INTO exception_capa_events(capa_id,event_type,actor_key,message,evidence) VALUES($1::uuid,$2,$3,$4,$5::jsonb)`, [capaId, eventType, actor, message, JSON.stringify(evidence || {})]);
}

async function recordNotification(capaId: string, recipient: string, type: string, status: "sent" | "failed" | "logged", error?: unknown) {
  await db.query(`INSERT INTO exception_capa_management_notifications(capa_id,recipient,notification_type,status,error_text) VALUES($1::uuid,$2,$3,$4,$5)`, [capaId, recipient, type, status, error ? String(error).slice(0, 1500) : null]);
}

async function notifyAssignedOwner(row: any) {
  const recipient = safe(row.assigned_owner_key);
  if (!emailLike(recipient)) return { attempted: false, sent: false, logged: false };
  const subject = `[VIR CAPA] Felelősi kijelölés – ${safe(row.title) || row.capa_id}`;
  const text = [
    "Új CAPA fejlesztési eszkaláció került hozzád kijelölésre.",
    "",
    `CAPA: ${safe(row.title) || row.capa_id}`,
    `Súlyosság: ${safe(row.severity)}`,
    `Kockázati pontszám: ${Number(row.score || 0)}/100`,
    `Telephely: ${safe(row.location_id) || '—'}`,
    `Határidő: ${row.suggested_due_at ? new Date(row.suggested_due_at).toISOString() : '—'}`,
    `Csapat: ${safe(row.assigned_owner_team) || '—'}`,
    "",
    "A feladatot a VIR Statisztika és VIR / CAPA vezetői munkasorban tudod visszaigazolni.",
  ].join("\n");
  try {
    const result: any = await sendEmail({ to: recipient, subject, text });
    const status: "sent" | "logged" = result?.sent ? "sent" : "logged";
    await recordNotification(String(row.capa_id), recipient, "assignment", status, result?.logged ? "SMTP nem küldött; az üzenet naplózásra került." : null);
    return { attempted: true, sent: Boolean(result?.sent), logged: Boolean(result?.logged) };
  } catch (error: any) {
    await recordNotification(String(row.capa_id), recipient, "assignment", "failed", error?.message || error);
    return { attempted: true, sent: false, logged: false, failed: true };
  }
}

export async function assignExceptionCapaManagementOwner(capaId: string, actor: string, input: { ownerKey?: unknown; ownerTeam?: unknown; note?: unknown }) {
  await ensureExceptionCapaManagementQueueSchema();
  const ownerKey = safe(input.ownerKey);
  const ownerTeam = safe(input.ownerTeam);
  const note = safe(input.note);
  if (!ownerKey && !ownerTeam) throw Object.assign(new Error("Felelős vagy felelős csapat megadása kötelező."), { status: 400 });
  if (note && note.length < 5) throw Object.assign(new Error("A vezetői megjegyzés legalább 5 karakter legyen."), { status: 400 });
  const row = (await db.query(`
    UPDATE exception_capa_improvement_recommendations r SET
      assigned_owner_key=NULLIF($2,''),assigned_owner_team=NULLIF($3,''),assigned_by=$4,assigned_at=now(),
      acknowledged_by=NULL,acknowledged_at=NULL,management_note=NULLIF($5,''),last_management_notice_at=now(),updated_at=now()
    FROM exception_capa_candidates c, exception_root_cause_clusters rc
    WHERE r.capa_id=$1::uuid AND c.id=r.capa_id AND rc.id=c.cluster_id
    RETURNING r.*,c.title,c.severity,rc.location_id::text location_id
  `, [capaId, ownerKey, ownerTeam, actor, note])).rows[0];
  if (!row) throw Object.assign(new Error("A CAPA fejlesztési javaslat nem található."), { status: 404 });
  await managementEvent(capaId, "improvement_owner_assigned", actor, "CAPA fejlesztési eszkaláció felelőse kijelölve.", { owner_key: ownerKey || null, owner_team: ownerTeam || null, note: note || null });
  const notification = await notifyAssignedOwner(row);
  return { ...row, notification };
}

export async function acknowledgeExceptionCapaManagementAssignment(capaId: string, actor: string, note?: unknown) {
  await ensureExceptionCapaManagementQueueSchema();
  const rationale = safe(note);
  const row = (await db.query(`
    UPDATE exception_capa_improvement_recommendations
    SET acknowledged_by=$2,acknowledged_at=now(),management_note=COALESCE(NULLIF($3,''),management_note),updated_at=now()
    WHERE capa_id=$1::uuid AND NULLIF(trim(COALESCE(assigned_owner_key,assigned_owner_team,'')),'') IS NOT NULL
    RETURNING *
  `, [capaId, actor, rationale])).rows[0];
  if (!row) throw Object.assign(new Error("A CAPA javaslat nincs felelőshöz rendelve vagy nem található."), { status: 409 });
  await managementEvent(capaId, "improvement_assignment_acknowledged", actor, "A CAPA fejlesztési eszkaláció felelősi kijelölése visszaigazolva.", { note: rationale || null });
  return row;
}
