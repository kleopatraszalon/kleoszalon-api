import { Router, Request, Response, NextFunction } from "express";
import crypto from "crypto";
import pool from "../db";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { ensureHrRecruitment } from "../hr/ensureHrRecruitment";

const router = Router();
const asyncRoute = (handler: (req: any, res: Response) => Promise<any>) =>
  (req: Request, res: Response, next: NextFunction) => handler(req, res).catch(next);

const text = (value: unknown) => String(value ?? "").trim();
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function roleKeys(req: AuthRequest) {
  const raw: any = req.user?.role;
  if (Array.isArray(raw)) return raw.map(String).map((x) => x.toLowerCase());
  try {
    const parsed = JSON.parse(String(raw || ""));
    if (Array.isArray(parsed)) return parsed.map(String).map((x) => x.toLowerCase());
  } catch {}
  return String(raw || "")
    .replace(/[\[\]"]/g, "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

function requireHrReviewer(req: AuthRequest, res: Response, next: NextFunction) {
  const allowed = roleKeys(req).some((x) =>
    ["admin", "administrator", "manager", "vezető", "vezeto", "superadmin", "super_admin", "hr", "hr_manager"].includes(x)
  );
  if (!allowed) return res.status(403).json({ code: "HR_FORBIDDEN", message: "HR vagy vezetői jogosultság szükséges." });
  next();
}

async function resolveTenantId(tenantSlug?: unknown, locationId?: unknown): Promise<number> {
  const location = text(locationId);
  if (location) {
    const byLocation = await pool.query(`SELECT tenant_id FROM locations WHERE id=$1::uuid AND tenant_id IS NOT NULL LIMIT 1`, [location]);
    if (byLocation.rows[0]?.tenant_id != null) return Number(byLocation.rows[0].tenant_id);
  }
  const slug = text(tenantSlug) || "kleopatra";
  const tenant = await pool.query(`SELECT id FROM tenants WHERE slug=$1 AND is_active=true LIMIT 1`, [slug]);
  if (!tenant.rows[0]) {
    const error: any = new Error("A tenant nem található vagy nem aktív.");
    error.status = 404;
    error.code = "TENANT_NOT_FOUND";
    throw error;
  }
  return Number(tenant.rows[0].id);
}

function validateApplication(body: any) {
  const fields: Record<string, string> = {};
  for (const key of ["position_id", "first_name", "last_name", "email", "phone", "cv_url"] as const) {
    if (!text(body?.[key])) fields[key] = "required";
  }
  if (body?.consent_given !== true) fields.consent_given = "required_true";
  if (text(body?.email) && !emailPattern.test(text(body.email))) fields.email = "invalid_email";
  return fields;
}

function confirmationCode() {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `APP-${day}-${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
}

router.get("/positions", asyncRoute(async (req, res) => {
  await ensureHrRecruitment();
  const tenantId = await resolveTenantId(req.query.tenant_slug, req.query.location_id);
  const { rows } = await pool.query(
    `SELECT id,code,name,description,department_name,management_level
       FROM hr_positions
      WHERE is_active=true AND tenant_id=$1
      ORDER BY name`,
    [tenantId]
  );
  res.json(rows);
}));

router.post("/applications", asyncRoute(async (req, res) => {
  await ensureHrRecruitment();
  const body = req.body || {};
  const fields = validateApplication(body);
  if (Object.keys(fields).length) {
    return res.status(400).json({ code: "VALIDATION_ERROR", message: "A pályázat kötelező adatai hiányosak.", fields });
  }

  const tenantId = await resolveTenantId(body.tenant_slug, body.preferred_location_id);
  const position = await pool.query(
    `SELECT id FROM hr_positions WHERE id=$1::uuid AND tenant_id=$2 AND is_active=true LIMIT 1`,
    [body.position_id, tenantId]
  );
  if (!position.rows[0]) return res.status(409).json({ code: "POSITION_NOT_ACTIVE", message: "A kiválasztott pozíció nem aktív vagy nem ehhez a szervezethez tartozik." });

  const idempotencyKey = text(req.headers["idempotency-key"]) || null;
  if (idempotencyKey) {
    const existing = await pool.query(
      `SELECT id,confirmation_code,status,submitted_at FROM hr_recruitment_applications WHERE tenant_id=$1 AND submission_key=$2 LIMIT 1`,
      [tenantId, idempotencyKey]
    );
    if (existing.rows[0]) return res.status(200).json({ ...existing.rows[0], idempotent_replay: true });
  }

  const values = [
    tenantId, body.position_id, body.preferred_location_id || null, text(body.first_name), text(body.last_name),
    text(body.email).toLowerCase(), text(body.phone), text(body.cv_url), text(body.portfolio_url) || null,
    text(body.cover_letter) || null, true, confirmationCode(), idempotencyKey,
  ];
  try {
    const { rows } = await pool.query(
      `INSERT INTO hr_recruitment_applications(
         tenant_id,position_id,preferred_location_id,first_name,last_name,email,phone,cv_url,portfolio_url,cover_letter,
         consent_given,confirmation_code,submission_key,status,submitted_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'new',now())
       RETURNING id,confirmation_code,status,submitted_at`,
      values
    );
    return res.status(201).json({ ...rows[0], idempotent_replay: false });
  } catch (error: any) {
    if (error?.code === "23505" && idempotencyKey) {
      const existing = await pool.query(
        `SELECT id,confirmation_code,status,submitted_at FROM hr_recruitment_applications WHERE tenant_id=$1 AND submission_key=$2 LIMIT 1`,
        [tenantId, idempotencyKey]
      );
      if (existing.rows[0]) return res.status(200).json({ ...existing.rows[0], idempotent_replay: true });
    }
    throw error;
  }
}));

router.use(requireAuth);
router.use(requireHrReviewer);

router.get("/applications", asyncRoute(async (req: AuthRequest, res) => {
  await ensureHrRecruitment();
  const tenantId = await resolveTenantId(req.query.tenant_slug, req.user?.location_id);
  const status = text(req.query.status);
  const values: any[] = [tenantId];
  const statusSql = status ? ` AND a.status=$2` : "";
  if (status) values.push(status);
  const { rows } = await pool.query(
    `SELECT a.*,p.name position_name,l.name preferred_location_name
       FROM hr_recruitment_applications a
       JOIN hr_positions p ON p.id=a.position_id
       LEFT JOIN locations l ON l.id=a.preferred_location_id
      WHERE a.tenant_id=$1${statusSql}
      ORDER BY a.submitted_at DESC`,
    values
  );
  res.json(rows);
}));

router.get("/applications/:id", asyncRoute(async (req: AuthRequest, res) => {
  await ensureHrRecruitment();
  const tenantId = await resolveTenantId(req.query.tenant_slug, req.user?.location_id);
  const application = await pool.query(
    `SELECT a.*,p.name position_name FROM hr_recruitment_applications a JOIN hr_positions p ON p.id=a.position_id WHERE a.id=$1::uuid AND a.tenant_id=$2`,
    [req.params.id, tenantId]
  );
  if (!application.rows[0]) return res.status(404).json({ code: "APPLICATION_NOT_FOUND" });
  const contacts = await pool.query(
    `SELECT id,channel,result,internal_note,actor_user_id,contacted_at,created_at FROM hr_recruitment_contacts WHERE application_id=$1::uuid AND tenant_id=$2 ORDER BY contacted_at DESC`,
    [req.params.id, tenantId]
  );
  res.json({ application: application.rows[0], contacts: contacts.rows });
}));

router.post("/applications/:id/contacts", asyncRoute(async (req: AuthRequest, res) => {
  await ensureHrRecruitment();
  const body = req.body || {};
  const channel = text(body.channel).toLowerCase();
  const result = text(body.result);
  const internalNote = text(body.internal_note);
  const fields: Record<string, string> = {};
  if (!['phone','email'].includes(channel)) fields.channel = "phone_or_email_required";
  if (!result) fields.result = "required";
  if (!internalNote) fields.internal_note = "required";
  if (Object.keys(fields).length) return res.status(400).json({ code: "VALIDATION_ERROR", fields });

  const tenantId = await resolveTenantId(body.tenant_slug, req.user?.location_id);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const app = await client.query(`SELECT id,status FROM hr_recruitment_applications WHERE id=$1::uuid AND tenant_id=$2 FOR UPDATE`, [req.params.id, tenantId]);
    if (!app.rows[0]) { await client.query("ROLLBACK"); return res.status(404).json({ code: "APPLICATION_NOT_FOUND" }); }
    const contact = await client.query(
      `INSERT INTO hr_recruitment_contacts(tenant_id,application_id,channel,result,internal_note,actor_user_id,contacted_at)
       VALUES($1,$2,$3,$4,$5,$6,COALESCE($7::timestamptz,now()))
       RETURNING id,channel,result,internal_note,actor_user_id,contacted_at,created_at`,
      [tenantId, req.params.id, channel, result, internalNote, String(req.user?.id ?? ""), body.contacted_at || null]
    );
    if (app.rows[0].status === "new") {
      await client.query(`UPDATE hr_recruitment_applications SET status='contacted',updated_at=now() WHERE id=$1::uuid`, [req.params.id]);
    }
    await client.query("COMMIT");
    res.status(201).json(contact.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}));

router.patch("/applications/:id/evaluation", asyncRoute(async (req: AuthRequest, res) => {
  await ensureHrRecruitment();
  const status = text(req.body?.status).toLowerCase();
  if (!['under_review','passed','rejected'].includes(status)) {
    return res.status(400).json({ code: "INVALID_STATUS", fields: { status: "under_review_passed_or_rejected_required" } });
  }
  const tenantId = await resolveTenantId(req.body?.tenant_slug, req.user?.location_id);
  const old = await pool.query(`SELECT * FROM hr_recruitment_applications WHERE id=$1::uuid AND tenant_id=$2`, [req.params.id, tenantId]);
  if (!old.rows[0]) return res.status(404).json({ code: "APPLICATION_NOT_FOUND" });
  const { rows } = await pool.query(
    `UPDATE hr_recruitment_applications SET status=$3,updated_at=now() WHERE id=$1::uuid AND tenant_id=$2 RETURNING *`,
    [req.params.id, tenantId, status]
  );
  await pool.query(
    `INSERT INTO audit_log(actor_user_id,actor_role,action,entity_type,entity_id,location_id,old_data,new_data,request_id)
     VALUES($1,$2,'evaluate','hr_recruitment_application',$3,$4,$5::jsonb,$6::jsonb,$7)`,
    [String(req.user?.id ?? ""), req.user?.role ?? null, req.params.id, req.user?.location_id == null ? null : String(req.user.location_id), JSON.stringify(old.rows[0]), JSON.stringify({ status, internal_note: text(req.body?.internal_note) || null }), text(req.headers['x-request-id']) || null]
  );
  res.json(rows[0]);
}));

router.post("/applications/:id/hire", asyncRoute(async (req: AuthRequest, res) => {
  await ensureHrRecruitment();
  const tenantId = await resolveTenantId(req.body?.tenant_slug, req.user?.location_id);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const selected = await client.query(`SELECT * FROM hr_recruitment_applications WHERE id=$1::uuid AND tenant_id=$2 FOR UPDATE`, [req.params.id, tenantId]);
    const application = selected.rows[0];
    if (!application) { await client.query("ROLLBACK"); return res.status(404).json({ code: "APPLICATION_NOT_FOUND" }); }

    if (application.employee_id) {
      const task = await client.query(`SELECT id,status,task_type,created_at FROM hr_recruitment_accounting_tasks WHERE application_id=$1::uuid AND tenant_id=$2`, [req.params.id, tenantId]);
      await client.query("COMMIT");
      return res.status(200).json({ employee_id: application.employee_id, accounting_task: task.rows[0] || null, idempotent_replay: true });
    }
    if (application.status !== "passed") {
      await client.query("ROLLBACK");
      return res.status(409).json({ code: "APPLICATION_NOT_PASSED", message: "Csak megfelelt jelentkező alakítható munkatárssá." });
    }

    const fullName = `${application.last_name} ${application.first_name}`.trim();
    const insertedEmployee = await client.query(
      `INSERT INTO employees(full_name,first_name,last_name,email,phone,location_id,position_id,employment_type,active,role,tenant_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,true,'["employee"]'::jsonb,$9)
       RETURNING id,full_name,email,phone,position_id,location_id,tenant_id`,
      [fullName, application.first_name, application.last_name, application.email, application.phone,
       req.body?.location_id || application.preferred_location_id || null, application.position_id,
       text(req.body?.employment_type) || null, tenantId]
    );
    const employee = insertedEmployee.rows[0];
    await client.query(
      `UPDATE hr_recruitment_applications SET employee_id=$2,status='hired',hired_at=now(),updated_at=now() WHERE id=$1::uuid`,
      [req.params.id, employee.id]
    );
    await client.query(
      `INSERT INTO employee_position_assignments(employee_id,position_id,location_id,is_primary,valid_from,is_active,tenant_id)
       VALUES($1,$2,$3,true,CURRENT_DATE,true,$4)
       ON CONFLICT DO NOTHING`,
      [employee.id, application.position_id, employee.location_id, tenantId]
    );
    await client.query(
      `INSERT INTO hr_recruitment_accounting_tasks(tenant_id,application_id,employee_id,payload)
       VALUES($1,$2,$3,$4::jsonb)
       ON CONFLICT(application_id) DO NOTHING`,
      [tenantId, req.params.id, employee.id, JSON.stringify({ full_name: employee.full_name, employment_type: text(req.body?.employment_type) || null, location_id: employee.location_id })]
    );
    const task = await client.query(`SELECT id,status,task_type,created_at FROM hr_recruitment_accounting_tasks WHERE application_id=$1::uuid AND tenant_id=$2`, [req.params.id, tenantId]);
    await client.query(
      `INSERT INTO audit_log(actor_user_id,actor_role,action,entity_type,entity_id,location_id,old_data,new_data,request_id)
       VALUES($1,$2,'hire','hr_recruitment_application',$3,$4,NULL,$5::jsonb,$6)`,
      [String(req.user?.id ?? ""), req.user?.role ?? null, req.params.id, req.user?.location_id == null ? null : String(req.user.location_id), JSON.stringify({ employee_id: employee.id, accounting_task_id: task.rows[0]?.id || null }), text(req.headers['x-request-id']) || null]
    );
    await client.query("COMMIT");
    res.status(201).json({ employee_id: employee.id, accounting_task: task.rows[0], idempotent_replay: false });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}));

export default router;
