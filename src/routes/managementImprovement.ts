import { Router } from "express";
import db from "../db";
import type { AuthRequest } from "../middleware/auth";
import { locationBelongsToTenant, resolveTenantIdentity } from "../saas/tenantAccess";
import ensureManagementImprovement from "../management/ensureManagementImprovement";

const router = Router();
const projectStatuses = new Set(["draft", "active", "review", "approved", "closed", "cancelled"]);
const priorities = new Set(["low", "normal", "high", "critical"]);
const actionTypes = new Set(["correction", "corrective", "preventive", "improvement"]);
const actionStatuses = new Set(["open", "in_progress", "completed", "verified", "cancelled"]);
const directions = new Set(["higher_better", "lower_better", "target"]);

const text = (value: unknown) => String(value ?? "").trim();
const actor = (req: AuthRequest) => text(req.user?.email) || text(req.user?.id) || "manager";
const actorId = (req: AuthRequest) => text(req.user?.id) || null;
const requestIp = (req: AuthRequest) => text(req.ip || req.socket?.remoteAddress) || null;
const roleList = (req: AuthRequest) => {
  const raw = req.user?.role;
  return (Array.isArray(raw) ? raw : String(raw ?? "").split(",")).map(String).map((x) => x.toLowerCase().trim());
};
const isAdmin = (req: AuthRequest) => roleList(req).some((role) => ["admin", "administrator", "superadmin", "super_admin", "rendszergazda"].includes(role));

function httpError(message: string, status: number) {
  return Object.assign(new Error(message), { status });
}
function fail(res: any, error: any) {
  const status = Number(error?.status || 500);
  return res.status(status >= 400 && status < 600 ? status : 500).json({ message: String(error?.message || "A művelet sikertelen.") });
}
async function tenantId(req: AuthRequest) {
  const tenant = await resolveTenantIdentity(req);
  if (!tenant) throw httpError("A tenant nem azonosítható.", 403);
  return tenant.id;
}
async function scopedLocation(req: AuthRequest, tenant: string, locationId: unknown) {
  const value = text(locationId);
  if (!value) return null;
  if (!(await locationBelongsToTenant(value, tenant))) throw httpError("A kiválasztott telephely nem tartozik ehhez a tenanthez.", 403);
  return value;
}
async function employeeForTenant(client: any, tenant: string, employeeId: unknown) {
  const id = text(employeeId);
  if (!id) return null;
  const row = (await client.query(
    `SELECT e.id::text id,COALESCE(e.full_name,concat_ws(' ',e.first_name,e.last_name)) full_name,
            COALESCE(to_jsonb(e)->>'location_id','') location_id
       FROM employees e
       LEFT JOIN locations l ON l.id::text=(to_jsonb(e)->>'location_id')
      WHERE e.id::text=$1 AND COALESCE(e.active,true)=true
        AND (l.tenant_id=$2::bigint OR NULLIF(to_jsonb(e)->>'tenant_id','')::bigint=$2::bigint)
      LIMIT 1`,
    [id, tenant],
  )).rows[0];
  if (!row) throw httpError("A felelős munkatárs nem található ebben a vállalatban vagy inaktív.", 400);
  return row;
}
function projectCode() {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  return `CI-${stamp}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}
async function audit(client: any, req: AuthRequest, tenant: string, projectId: string, entityType: string, entityId: string, action: string, changes: unknown = {}) {
  await client.query(
    `INSERT INTO management_improvement_audit(project_id,tenant_id,entity_type,entity_id,action,actor_user_id,actor,changes,request_ip)
     VALUES($1,$2::bigint,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
    [projectId, tenant, entityType, entityId, action, actorId(req), actor(req), JSON.stringify(changes || {}), requestIp(req)],
  );
}
async function projectRow(client: any, tenant: string, id: string) {
  return (await client.query(
    `SELECT p.*,
            (SELECT count(*)::int FROM management_improvement_actions a WHERE a.project_id=p.id AND a.status NOT IN ('verified','cancelled')) open_actions,
            (SELECT count(*)::int FROM management_improvement_actions a WHERE a.project_id=p.id AND a.action_type IN ('correction','corrective','preventive')) capa_actions,
            (SELECT count(*)::int FROM management_improvement_kpis k WHERE k.project_id=p.id) kpi_count
       FROM management_improvement_projects p
      WHERE p.id=$1::uuid AND p.tenant_id=$2::bigint`,
    [id, tenant],
  )).rows[0];
}

router.use(async (_req, _res, next) => {
  try { await ensureManagementImprovement(); next(); }
  catch (error) { next(error); }
});

router.get("/employees", async (req: AuthRequest, res) => {
  try {
    const tenant = await tenantId(req);
    const rows = (await db.query(
      `SELECT e.id::text id,COALESCE(e.full_name,concat_ws(' ',e.first_name,e.last_name)) full_name,
              COALESCE(to_jsonb(e)->>'position_id','') position_id,COALESCE(to_jsonb(e)->>'location_id','') location_id
         FROM employees e
         LEFT JOIN locations l ON l.id::text=(to_jsonb(e)->>'location_id')
        WHERE COALESCE(e.active,true)=true
          AND (l.tenant_id=$1::bigint OR NULLIF(to_jsonb(e)->>'tenant_id','')::bigint=$1::bigint)
        ORDER BY 2`,
      [tenant],
    )).rows;
    res.json(rows);
  } catch (error) { return fail(res, error); }
});

router.get("/dashboard", async (req: AuthRequest, res) => {
  try {
    const tenant = await tenantId(req);
    const projects = (await db.query(
      `SELECT count(*)::int total,
              count(*) FILTER(WHERE status IN ('active','review'))::int active,
              count(*) FILTER(WHERE approval_state='pending')::int awaiting_approval,
              count(*) FILTER(WHERE due_date<CURRENT_DATE AND status NOT IN ('closed','cancelled'))::int overdue,
              count(*) FILTER(WHERE status='closed')::int closed
         FROM management_improvement_projects WHERE tenant_id=$1::bigint`, [tenant])).rows[0];
    const actions = (await db.query(
      `SELECT count(*) FILTER(WHERE action_type IN ('correction','corrective','preventive') AND status NOT IN ('verified','cancelled'))::int open_capa,
              count(*) FILTER(WHERE due_date<CURRENT_DATE AND status NOT IN ('completed','verified','cancelled'))::int overdue_actions
         FROM management_improvement_actions WHERE tenant_id=$1::bigint`, [tenant])).rows[0];
    res.json({ ...projects, ...actions });
  } catch (error) { return fail(res, error); }
});

router.get("/projects", async (req: AuthRequest, res) => {
  try {
    const tenant = await tenantId(req);
    const status = text(req.query.status);
    const location = text(req.query.location_id);
    if (status && !projectStatuses.has(status)) throw httpError("Érvénytelen projektállapot szűrő.", 400);
    if (location) await scopedLocation(req, tenant, location);
    const params: any[] = [tenant];
    let where = "p.tenant_id=$1::bigint";
    if (status) { params.push(status); where += ` AND p.status=$${params.length}`; }
    if (location) { params.push(location); where += ` AND p.location_id=$${params.length}`; }
    const rows = (await db.query(
      `SELECT p.*,
              (SELECT count(*)::int FROM management_improvement_actions a WHERE a.project_id=p.id AND a.status NOT IN ('verified','cancelled')) open_actions,
              (SELECT count(*)::int FROM management_improvement_actions a WHERE a.project_id=p.id AND a.action_type IN ('correction','corrective','preventive')) capa_actions,
              (SELECT count(*)::int FROM management_improvement_kpis k WHERE k.project_id=p.id) kpi_count,
              (SELECT count(*)::int FROM management_improvement_actions a WHERE a.project_id=p.id AND a.due_date<CURRENT_DATE AND a.status NOT IN ('verified','completed','cancelled')) overdue_actions
         FROM management_improvement_projects p WHERE ${where}
        ORDER BY CASE p.priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,p.due_date NULLS LAST,p.updated_at DESC`, params)).rows;
    res.json(rows);
  } catch (error) { return fail(res, error); }
});

router.post("/projects", async (req: AuthRequest, res) => {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const tenant = await tenantId(req);
    const body = req.body || {};
    const title = text(body.title);
    if (!title) throw httpError("A projekt megnevezése kötelező.", 400);
    const location = await scopedLocation(req, tenant, body.location_id);
    const priority = priorities.has(text(body.priority)) ? text(body.priority) : "normal";
    const status = projectStatuses.has(text(body.status)) ? text(body.status) : "draft";
    const owner = await employeeForTenant(client, tenant, body.owner_employee_id);
    const code = text(body.code) || projectCode();
    const row = (await client.query(
      `INSERT INTO management_improvement_projects(
        tenant_id,location_id,code,title,problem_statement,objective,methodology,analysis_data,
        owner_employee_id,owner_name,priority,status,start_date,due_date,created_by
      ) VALUES($1::bigint,$2,$3,$4,$5,$6,$7::text[],$8::jsonb,$9,$10,$11,$12,COALESCE($13::date,CURRENT_DATE),$14::date,$15)
      RETURNING *`,
      [tenant, location, code, title, text(body.problem_statement) || null, text(body.objective) || null,
       Array.isArray(body.methodology) ? body.methodology.map(String) : [], JSON.stringify(body.analysis_data || {}),
       owner?.id || null, owner?.full_name || text(body.owner_name) || null, priority, status, body.start_date || null, body.due_date || null, actor(req)],
    )).rows[0];
    await audit(client, req, tenant, row.id, "project", row.id, "project.created", { after: row });
    await client.query("COMMIT");
    res.status(201).json(row);
  } catch (error) {
    await client.query("ROLLBACK");
    return fail(res, error);
  } finally { client.release(); }
});

router.get("/projects/:id", async (req: AuthRequest, res) => {
  try {
    const tenant = await tenantId(req);
    const project = await projectRow(db, tenant, req.params.id);
    if (!project) return res.status(404).json({ message: "A fejlesztési projekt nem található." });
    const [actions, kpis, approvals, auditRows] = await Promise.all([
      db.query(`SELECT * FROM management_improvement_actions WHERE project_id=$1::uuid AND tenant_id=$2::bigint ORDER BY CASE status WHEN 'open' THEN 1 WHEN 'in_progress' THEN 2 WHEN 'completed' THEN 3 WHEN 'verified' THEN 4 ELSE 5 END,due_date NULLS LAST,created_at`, [project.id, tenant]),
      db.query(`SELECT *,CASE WHEN before_value IS NULL OR after_value IS NULL THEN NULL WHEN direction='lower_better' THEN before_value-after_value WHEN direction='higher_better' THEN after_value-before_value ELSE -abs(COALESCE(target_value,after_value)-after_value) END improvement_value FROM management_improvement_kpis WHERE project_id=$1::uuid AND tenant_id=$2::bigint ORDER BY created_at`, [project.id, tenant]),
      db.query(`SELECT * FROM management_improvement_approvals WHERE project_id=$1::uuid AND tenant_id=$2::bigint ORDER BY requested_at DESC`, [project.id, tenant]),
      db.query(`SELECT * FROM management_improvement_audit WHERE project_id=$1::uuid AND tenant_id=$2::bigint ORDER BY created_at DESC,id DESC LIMIT 250`, [project.id, tenant]),
    ]);
    res.json({ project, actions: actions.rows, kpis: kpis.rows, approvals: approvals.rows, audit: auditRows.rows });
  } catch (error) { return fail(res, error); }
});

router.patch("/projects/:id", async (req: AuthRequest, res) => {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const tenant = await tenantId(req);
    const body = req.body || {};
    const current = await projectRow(client, tenant, req.params.id);
    if (!current) throw httpError("A projekt nem található.", 404);
    if (current.status === "closed") throw httpError("Lezárt projekt nem módosítható.", 409);
    const location = body.location_id === undefined ? current.location_id : await scopedLocation(req, tenant, body.location_id);
    const status = body.status === undefined ? current.status : text(body.status);
    const priority = body.priority === undefined ? current.priority : text(body.priority);
    if (!projectStatuses.has(status)) throw httpError("Érvénytelen projektállapot.", 400);
    if (!priorities.has(priority)) throw httpError("Érvénytelen prioritás.", 400);
    const title = body.title === undefined ? current.title : text(body.title);
    if (!title) throw httpError("A projekt megnevezése kötelező.", 400);
    let ownerId = current.owner_employee_id;
    let ownerName = current.owner_name;
    if (body.owner_employee_id !== undefined) {
      const owner = await employeeForTenant(client, tenant, body.owner_employee_id);
      ownerId = owner?.id || null;
      ownerName = owner?.full_name || text(body.owner_name) || null;
    } else if (body.owner_name !== undefined) ownerName = text(body.owner_name) || null;
    const row = (await client.query(
      `UPDATE management_improvement_projects SET
        location_id=$3,title=$4,problem_statement=$5,objective=$6,methodology=$7::text[],analysis_data=$8::jsonb,
        owner_employee_id=$9,owner_name=$10,priority=$11,status=$12,start_date=$13::date,due_date=$14::date,updated_at=now()
       WHERE id=$1::uuid AND tenant_id=$2::bigint RETURNING *`,
      [current.id, tenant, location, title,
       body.problem_statement === undefined ? current.problem_statement : text(body.problem_statement) || null,
       body.objective === undefined ? current.objective : text(body.objective) || null,
       body.methodology === undefined ? current.methodology : (Array.isArray(body.methodology) ? body.methodology.map(String) : []),
       JSON.stringify(body.analysis_data === undefined ? current.analysis_data : (body.analysis_data || {})), ownerId, ownerName,
       priority, status, body.start_date === undefined ? current.start_date : (body.start_date || null),
       body.due_date === undefined ? current.due_date : (body.due_date || null)],
    )).rows[0];
    await audit(client, req, tenant, row.id, "project", row.id, "project.updated", { before: current, after: row });
    await client.query("COMMIT");
    res.json(row);
  } catch (error) {
    await client.query("ROLLBACK");
    return fail(res, error);
  } finally { client.release(); }
});

router.post("/projects/:id/actions", async (req: AuthRequest, res) => {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const tenant = await tenantId(req);
    const project = await projectRow(client, tenant, req.params.id);
    if (!project) throw httpError("A projekt nem található.", 404);
    if (["closed", "cancelled"].includes(project.status)) throw httpError("Lezárt projektben új intézkedés nem rögzíthető.", 409);
    const body = req.body || {};
    const title = text(body.title);
    if (!title) throw httpError("Az intézkedés megnevezése kötelező.", 400);
    const actionType = actionTypes.has(text(body.action_type)) ? text(body.action_type) : "improvement";
    const owner = await employeeForTenant(client, tenant, body.owner_employee_id);
    const row = (await client.query(
      `INSERT INTO management_improvement_actions(
        project_id,tenant_id,action_type,title,description,root_cause,owner_employee_id,owner_name,due_date,status,effectiveness_criteria,created_by
      ) VALUES($1::uuid,$2::bigint,$3,$4,$5,$6,$7,$8,$9::date,'open',$10,$11) RETURNING *`,
      [project.id, tenant, actionType, title, text(body.description) || null, text(body.root_cause) || null,
       owner?.id || null, owner?.full_name || text(body.owner_name) || null, body.due_date || null, text(body.effectiveness_criteria) || null, actor(req)],
    )).rows[0];
    await client.query(`UPDATE management_improvement_projects SET status=CASE WHEN status='draft' THEN 'active' ELSE status END,updated_at=now() WHERE id=$1`, [project.id]);
    await audit(client, req, tenant, project.id, "action", row.id, "action.created", { after: row });
    await client.query("COMMIT");
    res.status(201).json(row);
  } catch (error) {
    await client.query("ROLLBACK");
    return fail(res, error);
  } finally { client.release(); }
});

router.patch("/projects/:id/actions/:actionId", async (req: AuthRequest, res) => {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const tenant = await tenantId(req);
    const body = req.body || {};
    const current = (await client.query(`SELECT * FROM management_improvement_actions WHERE id=$1::uuid AND project_id=$2::uuid AND tenant_id=$3::bigint`, [req.params.actionId, req.params.id, tenant])).rows[0];
    if (!current) throw httpError("Az intézkedés nem található.", 404);
    const status = body.status === undefined ? current.status : text(body.status);
    if (!actionStatuses.has(status)) throw httpError("Érvénytelen intézkedésállapot.", 400);
    if (status === "verified" && !text(body.effectiveness_result) && !current.effectiveness_result) throw httpError("Ellenőrzéshez az eredményesség értékelése kötelező.", 409);
    let ownerId = current.owner_employee_id;
    let ownerName = current.owner_name;
    if (body.owner_employee_id !== undefined) {
      const owner = await employeeForTenant(client, tenant, body.owner_employee_id);
      ownerId = owner?.id || null;
      ownerName = owner?.full_name || text(body.owner_name) || null;
    } else if (body.owner_name !== undefined) ownerName = text(body.owner_name) || null;
    const row = (await client.query(
      `UPDATE management_improvement_actions SET
        title=$4,description=$5,root_cause=$6,owner_employee_id=$7,owner_name=$8,due_date=$9::date,status=$10,
        effectiveness_criteria=$11,effectiveness_result=$12,
        completed_at=CASE WHEN $10='completed' AND completed_at IS NULL THEN now() WHEN $10 IN ('open','in_progress') THEN NULL ELSE completed_at END,
        verified_by=CASE WHEN $10='verified' THEN $13 WHEN $10<>'verified' THEN NULL ELSE verified_by END,
        verified_at=CASE WHEN $10='verified' THEN now() WHEN $10<>'verified' THEN NULL ELSE verified_at END,updated_at=now()
       WHERE id=$1::uuid AND project_id=$2::uuid AND tenant_id=$3::bigint RETURNING *`,
      [current.id, req.params.id, tenant, body.title === undefined ? current.title : text(body.title),
       body.description === undefined ? current.description : text(body.description) || null,
       body.root_cause === undefined ? current.root_cause : text(body.root_cause) || null, ownerId, ownerName,
       body.due_date === undefined ? current.due_date : (body.due_date || null), status,
       body.effectiveness_criteria === undefined ? current.effectiveness_criteria : text(body.effectiveness_criteria) || null,
       body.effectiveness_result === undefined ? current.effectiveness_result : text(body.effectiveness_result) || null, actor(req)],
    )).rows[0];
    await audit(client, req, tenant, req.params.id, "action", row.id, "action.updated", { before: current, after: row });
    await client.query("COMMIT");
    res.json(row);
  } catch (error) {
    await client.query("ROLLBACK");
    return fail(res, error);
  } finally { client.release(); }
});

router.delete("/projects/:id/actions/:actionId", async (req: AuthRequest, res) => {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const tenant = await tenantId(req);
    const row = (await client.query(`DELETE FROM management_improvement_actions WHERE id=$1::uuid AND project_id=$2::uuid AND tenant_id=$3::bigint RETURNING *`, [req.params.actionId, req.params.id, tenant])).rows[0];
    if (!row) throw httpError("Az intézkedés nem található.", 404);
    await audit(client, req, tenant, req.params.id, "action", row.id, "action.deleted", { before: row });
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (error) {
    await client.query("ROLLBACK");
    return fail(res, error);
  } finally { client.release(); }
});

router.post("/projects/:id/kpis", async (req: AuthRequest, res) => {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const tenant = await tenantId(req);
    const project = await projectRow(client, tenant, req.params.id);
    if (!project) throw httpError("A projekt nem található.", 404);
    const body = req.body || {};
    const name = text(body.name);
    if (!name) throw httpError("A KPI megnevezése kötelező.", 400);
    const direction = directions.has(text(body.direction)) ? text(body.direction) : "higher_better";
    const row = (await client.query(
      `INSERT INTO management_improvement_kpis(
        project_id,tenant_id,metric_key,name,unit,direction,before_value,target_value,after_value,before_at,after_at,source,notes,created_by
      ) VALUES($1::uuid,$2::bigint,$3,$4,$5,$6,$7::numeric,$8::numeric,$9::numeric,$10::timestamptz,$11::timestamptz,$12,$13,$14) RETURNING *`,
      [project.id, tenant, text(body.metric_key) || null, name, text(body.unit) || null, direction, body.before_value ?? null,
       body.target_value ?? null, body.after_value ?? null, body.before_at || null, body.after_at || null,
       text(body.source) || null, text(body.notes) || null, actor(req)],
    )).rows[0];
    await audit(client, req, tenant, project.id, "kpi", row.id, "kpi.created", { after: row });
    await client.query("COMMIT");
    res.status(201).json(row);
  } catch (error) {
    await client.query("ROLLBACK");
    return fail(res, error);
  } finally { client.release(); }
});

router.patch("/projects/:id/kpis/:kpiId", async (req: AuthRequest, res) => {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const tenant = await tenantId(req);
    const body = req.body || {};
    const current = (await client.query(`SELECT * FROM management_improvement_kpis WHERE id=$1::uuid AND project_id=$2::uuid AND tenant_id=$3::bigint`, [req.params.kpiId, req.params.id, tenant])).rows[0];
    if (!current) throw httpError("A KPI nem található.", 404);
    const direction = body.direction === undefined ? current.direction : text(body.direction);
    if (!directions.has(direction)) throw httpError("Érvénytelen KPI irány.", 400);
    const name = body.name === undefined ? current.name : text(body.name);
    if (!name) throw httpError("A KPI megnevezése kötelező.", 400);
    const row = (await client.query(
      `UPDATE management_improvement_kpis SET metric_key=$4,name=$5,unit=$6,direction=$7,before_value=$8::numeric,target_value=$9::numeric,
        after_value=$10::numeric,before_at=$11::timestamptz,after_at=$12::timestamptz,source=$13,notes=$14,updated_at=now()
       WHERE id=$1::uuid AND project_id=$2::uuid AND tenant_id=$3::bigint RETURNING *`,
      [current.id, req.params.id, tenant, body.metric_key === undefined ? current.metric_key : text(body.metric_key) || null, name,
       body.unit === undefined ? current.unit : text(body.unit) || null, direction,
       body.before_value === undefined ? current.before_value : body.before_value,
       body.target_value === undefined ? current.target_value : body.target_value,
       body.after_value === undefined ? current.after_value : body.after_value,
       body.before_at === undefined ? current.before_at : (body.before_at || null),
       body.after_at === undefined ? current.after_at : (body.after_at || null),
       body.source === undefined ? current.source : text(body.source) || null,
       body.notes === undefined ? current.notes : text(body.notes) || null],
    )).rows[0];
    await audit(client, req, tenant, req.params.id, "kpi", row.id, "kpi.updated", { before: current, after: row });
    await client.query("COMMIT");
    res.json(row);
  } catch (error) {
    await client.query("ROLLBACK");
    return fail(res, error);
  } finally { client.release(); }
});

router.delete("/projects/:id/kpis/:kpiId", async (req: AuthRequest, res) => {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const tenant = await tenantId(req);
    const row = (await client.query(`DELETE FROM management_improvement_kpis WHERE id=$1::uuid AND project_id=$2::uuid AND tenant_id=$3::bigint RETURNING *`, [req.params.kpiId, req.params.id, tenant])).rows[0];
    if (!row) throw httpError("A KPI nem található.", 404);
    await audit(client, req, tenant, req.params.id, "kpi", row.id, "kpi.deleted", { before: row });
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (error) {
    await client.query("ROLLBACK");
    return fail(res, error);
  } finally { client.release(); }
});

router.post("/projects/:id/request-approval", async (req: AuthRequest, res) => {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const tenant = await tenantId(req);
    const project = await projectRow(client, tenant, req.params.id);
    if (!project) throw httpError("A projekt nem található.", 404);
    if (["closed", "cancelled"].includes(project.status)) throw httpError("Lezárt vagy megszakított projekt nem küldhető jóváhagyásra.", 409);
    const openActions = Number((await client.query(`SELECT count(*)::int c FROM management_improvement_actions WHERE project_id=$1 AND tenant_id=$2::bigint AND status NOT IN ('completed','verified','cancelled')`, [project.id, tenant])).rows[0]?.c || 0);
    if (openActions > 0) throw httpError(`Jóváhagyás előtt ${openActions} nyitott intézkedést le kell zárni.`, 409);
    const completedKpis = Number((await client.query(`SELECT count(*)::int c FROM management_improvement_kpis WHERE project_id=$1 AND tenant_id=$2::bigint AND before_value IS NOT NULL AND after_value IS NOT NULL`, [project.id, tenant])).rows[0]?.c || 0);
    if (completedKpis < 1) throw httpError("Jóváhagyás előtt legalább egy előtte/utána KPI rögzítése kötelező.", 409);
    await client.query(`UPDATE management_improvement_approvals SET decision='withdrawn',decided_at=now(),decided_by=$3,comment='Új jóváhagyási kör indult.' WHERE project_id=$1 AND tenant_id=$2::bigint AND decision='pending'`, [project.id, tenant, actor(req)]);
    const approval = (await client.query(`INSERT INTO management_improvement_approvals(project_id,tenant_id,requested_by,comment) VALUES($1,$2::bigint,$3,$4) RETURNING *`, [project.id, tenant, actor(req), text(req.body?.comment) || null])).rows[0];
    const updated = (await client.query(
      `UPDATE management_improvement_projects SET status='review',approval_state='pending',approval_requested_by=$3,approval_requested_at=now(),approved_by=NULL,approved_at=NULL,rejected_by=NULL,rejected_at=NULL,approval_comment=$4,updated_at=now() WHERE id=$1 AND tenant_id=$2::bigint RETURNING *`,
      [project.id, tenant, actor(req), text(req.body?.comment) || null],
    )).rows[0];
    await audit(client, req, tenant, project.id, "approval", approval.id, "approval.requested", { approval, project: updated });
    await client.query("COMMIT");
    res.json({ project: updated, approval });
  } catch (error) {
    await client.query("ROLLBACK");
    return fail(res, error);
  } finally { client.release(); }
});

router.post("/projects/:id/approve", async (req: AuthRequest, res) => {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const tenant = await tenantId(req);
    const project = await projectRow(client, tenant, req.params.id);
    if (!project) throw httpError("A projekt nem található.", 404);
    if (project.approval_state !== "pending") throw httpError("Nincs függő jóváhagyási kérelem.", 409);
    const selfApproval = actor(req) === text(project.approval_requested_by);
    if (selfApproval && !isAdmin(req)) throw httpError("A kérelmező nem hagyhatja jóvá a saját projektjét.", 403);
    if (selfApproval && isAdmin(req) && !text(req.body?.override_reason)) throw httpError("Saját projekt adminisztrátori jóváhagyásához indoklás kötelező.", 409);
    const comment = text(req.body?.comment) || text(req.body?.override_reason) || null;
    const approval = (await client.query(
      `UPDATE management_improvement_approvals SET decision='approved',decided_by=$3,decided_at=now(),comment=COALESCE($4,comment)
        WHERE id=(SELECT id FROM management_improvement_approvals WHERE project_id=$1 AND tenant_id=$2::bigint AND decision='pending' ORDER BY requested_at DESC LIMIT 1) RETURNING *`,
      [project.id, tenant, actor(req), comment],
    )).rows[0];
    if (!approval) throw httpError("A függő jóváhagyási rekord nem található.", 409);
    const updated = (await client.query(`UPDATE management_improvement_projects SET status='approved',approval_state='approved',approved_by=$3,approved_at=now(),rejected_by=NULL,rejected_at=NULL,approval_comment=$4,updated_at=now() WHERE id=$1 AND tenant_id=$2::bigint RETURNING *`, [project.id, tenant, actor(req), comment])).rows[0];
    await audit(client, req, tenant, project.id, "approval", approval.id, "approval.approved", { comment, self_approval_override: selfApproval && isAdmin(req) });
    await client.query("COMMIT");
    res.json({ project: updated, approval });
  } catch (error) {
    await client.query("ROLLBACK");
    return fail(res, error);
  } finally { client.release(); }
});

router.post("/projects/:id/reject", async (req: AuthRequest, res) => {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const tenant = await tenantId(req);
    const project = await projectRow(client, tenant, req.params.id);
    const comment = text(req.body?.comment);
    if (!project) throw httpError("A projekt nem található.", 404);
    if (project.approval_state !== "pending") throw httpError("Nincs függő jóváhagyási kérelem.", 409);
    if (!comment) throw httpError("Elutasításkor indoklás kötelező.", 400);
    const approval = (await client.query(
      `UPDATE management_improvement_approvals SET decision='rejected',decided_by=$3,decided_at=now(),comment=$4
        WHERE id=(SELECT id FROM management_improvement_approvals WHERE project_id=$1 AND tenant_id=$2::bigint AND decision='pending' ORDER BY requested_at DESC LIMIT 1) RETURNING *`,
      [project.id, tenant, actor(req), comment],
    )).rows[0];
    if (!approval) throw httpError("A függő jóváhagyási rekord nem található.", 409);
    const updated = (await client.query(`UPDATE management_improvement_projects SET status='active',approval_state='rejected',rejected_by=$3,rejected_at=now(),approved_by=NULL,approved_at=NULL,approval_comment=$4,updated_at=now() WHERE id=$1 AND tenant_id=$2::bigint RETURNING *`, [project.id, tenant, actor(req), comment])).rows[0];
    await audit(client, req, tenant, project.id, "approval", approval.id, "approval.rejected", { comment });
    await client.query("COMMIT");
    res.json({ project: updated, approval });
  } catch (error) {
    await client.query("ROLLBACK");
    return fail(res, error);
  } finally { client.release(); }
});

router.post("/projects/:id/close", async (req: AuthRequest, res) => {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const tenant = await tenantId(req);
    const project = await projectRow(client, tenant, req.params.id);
    if (!project) throw httpError("A projekt nem található.", 404);
    if (project.approval_state !== "approved") throw httpError("A projekt csak jóváhagyás után zárható le.", 409);
    const unverifiedCapa = Number((await client.query(`SELECT count(*)::int c FROM management_improvement_actions WHERE project_id=$1 AND tenant_id=$2::bigint AND action_type IN ('correction','corrective','preventive') AND status NOT IN ('verified','cancelled')`, [project.id, tenant])).rows[0]?.c || 0);
    if (unverifiedCapa > 0) throw httpError(`Lezárás előtt ${unverifiedCapa} CAPA intézkedés eredményességét igazolni kell.`, 409);
    const updated = (await client.query(`UPDATE management_improvement_projects SET status='closed',closed_at=now(),updated_at=now() WHERE id=$1 AND tenant_id=$2::bigint RETURNING *`, [project.id, tenant])).rows[0];
    await audit(client, req, tenant, project.id, "project", project.id, "project.closed", { after: updated });
    await client.query("COMMIT");
    res.json(updated);
  } catch (error) {
    await client.query("ROLLBACK");
    return fail(res, error);
  } finally { client.release(); }
});

router.get("/projects/:id/audit", async (req: AuthRequest, res) => {
  try {
    const tenant = await tenantId(req);
    const project = await projectRow(db, tenant, req.params.id);
    if (!project) return res.status(404).json({ message: "A projekt nem található." });
    const rows = (await db.query(`SELECT * FROM management_improvement_audit WHERE project_id=$1::uuid AND tenant_id=$2::bigint ORDER BY created_at DESC,id DESC LIMIT 500`, [project.id, tenant])).rows;
    res.json(rows);
  } catch (error) { return fail(res, error); }
});

export default router;
