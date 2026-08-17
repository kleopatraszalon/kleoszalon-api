import cron from "node-cron";
import db from "../db";
import { sendEmail } from "../mailer";
import { ensureAlertRuleEngineSchema, type AlertRule } from "../services/alertRuleEngine";
import type { AuthRequest } from "../middleware/auth";

const BUDAPEST_TZ = "Europe/Budapest";
export const MAINTENANCE_RULE_KEY = "maintenance_due";
export const MAINTENANCE_DEFAULT_WARNING_DAYS = 30;

export type MaintenanceAlert = {
  key: string;
  type: typeof MAINTENANCE_RULE_KEY;
  severity: "warning" | "critical";
  title: string;
  detail: string;
  route: string;
  created_at: string;
  due_at: string;
  location_id: string | null;
  entity_type: string;
  entity_id: string;
  payload: Record<string, unknown>;
};

type MaintenanceRule = AlertRule & { rule_key: typeof MAINTENANCE_RULE_KEY };

let schemaPromise: Promise<void> | null = null;
let schedulerStarted = false;

const clean = (value: unknown, max = 1000) => String(value ?? "").trim().slice(0, max);
const bool = (value: unknown, fallback = false) => value == null ? fallback : value === true || value === 1 || ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
const int = (value: unknown, min: number, max: number, fallback: number) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
};

async function tableExists(name: string) {
  const row = (await db.query(`SELECT to_regclass($1) IS NOT NULL ok`, [`public.${name}`])).rows[0];
  return Boolean(row?.ok);
}

export function ensurePdfGreenComplianceSchema(): Promise<void> {
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
    await ensureAlertRuleEngineSchema();
    await db.query(`
      CREATE TABLE IF NOT EXISTS ui_audit_events (
        id bigserial PRIMARY KEY,
        actor_key text,
        actor_role text,
        location_id text,
        route text NOT NULL,
        event_type text NOT NULL,
        target text,
        label text,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        request_id text,
        ip_address text,
        user_agent text,
        occurred_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS ui_audit_events_time_idx ON ui_audit_events(occurred_at DESC);
      CREATE INDEX IF NOT EXISTS ui_audit_events_actor_idx ON ui_audit_events(actor_key,occurred_at DESC);
      CREATE INDEX IF NOT EXISTS ui_audit_events_route_idx ON ui_audit_events(route,occurred_at DESC);
      CREATE INDEX IF NOT EXISTS ui_audit_events_type_idx ON ui_audit_events(event_type,occurred_at DESC);

      CREATE TABLE IF NOT EXISTS hr_recruitment_accounting_email_queue (
        id bigserial PRIMARY KEY,
        application_id uuid NOT NULL UNIQUE,
        employee_id uuid,
        recipient_email text NOT NULL,
        status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','sent','failed')),
        attempts integer NOT NULL DEFAULT 0,
        last_error text,
        queued_at timestamptz NOT NULL DEFAULT now(),
        last_attempt_at timestamptz,
        sent_at timestamptz
      );
      CREATE INDEX IF NOT EXISTS hr_recruitment_accounting_email_pending_idx
        ON hr_recruitment_accounting_email_queue(status,queued_at) WHERE sent_at IS NULL;

      INSERT INTO vir_alert_rules(
        rule_key,scope_type,scope_id,enabled,warning_value,deadline_value,
        escalation_enabled,level2_after_hours,level3_after_hours,email_enabled,push_enabled
      ) VALUES(
        '${MAINTENANCE_RULE_KEY}','global','*',true,${MAINTENANCE_DEFAULT_WARNING_DAYS},NULL,true,24,72,true,true
      ) ON CONFLICT(rule_key,scope_type,scope_id) DO NOTHING;
    `);

    if (await tableExists("hr_recruitment_applications")) {
      await db.query(`
        CREATE OR REPLACE FUNCTION kleo_queue_hired_employee_accounting_email()
        RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE target_email text;
        BEGIN
          IF NEW.status='hired' AND COALESCE(OLD.status,'')<>'hired' THEN
            target_email:=COALESCE(NULLIF(current_setting('kleo.accounting_email',true),''),'konyveles@kleoszalon.hu');
            INSERT INTO hr_recruitment_accounting_email_queue(application_id,employee_id,recipient_email,status)
            VALUES(NEW.id,NEW.employee_id,target_email,'pending')
            ON CONFLICT(application_id) DO UPDATE SET
              employee_id=COALESCE(EXCLUDED.employee_id,hr_recruitment_accounting_email_queue.employee_id),
              recipient_email=EXCLUDED.recipient_email,
              status=CASE WHEN hr_recruitment_accounting_email_queue.sent_at IS NULL THEN 'pending' ELSE hr_recruitment_accounting_email_queue.status END;
          END IF;
          RETURN NEW;
        END $$;
        DROP TRIGGER IF EXISTS trg_kleo_hire_accounting_email ON hr_recruitment_applications;
        CREATE TRIGGER trg_kleo_hire_accounting_email
          AFTER UPDATE OF status,employee_id ON hr_recruitment_applications
          FOR EACH ROW EXECUTE FUNCTION kleo_queue_hired_employee_accounting_email();
      `);
      const accountingEmail = clean(process.env.ACCOUNTING_EMAIL || "konyveles@kleoszalon.hu", 320).toLowerCase();
      await db.query(`
        INSERT INTO hr_recruitment_accounting_email_queue(application_id,employee_id,recipient_email,status)
        SELECT a.id,a.employee_id,$1,'pending'
          FROM hr_recruitment_applications a
         WHERE a.status='hired' AND a.employee_id IS NOT NULL
           AND NOT EXISTS(SELECT 1 FROM hr_recruitment_accounting_email_queue q WHERE q.application_id=a.id)
        ON CONFLICT(application_id) DO NOTHING
      `, [accountingEmail]);
    }

    if (await tableExists("operations_quality_records")) {
      await db.query(`
        CREATE OR REPLACE FUNCTION kleo_create_supervisor_verification_task()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.module_key='tasks'
             AND COALESCE(NEW.requires_approval,false)=true
             AND NEW.status='completed'
             AND COALESCE(OLD.status,'')<>'completed'
             AND COALESCE(NEW.metadata->>'system_generated','false')<>'true'
             AND NOT EXISTS(
               SELECT 1 FROM operations_quality_records v
                WHERE v.module_key='tasks'
                  AND v.metadata->>'verification_of'=NEW.id::text
                  AND COALESCE(v.metadata->>'system_generated','false')='true'
             ) THEN
            INSERT INTO operations_quality_records(
              module_key,title,description,location_name,department,assignee,priority,status,due_at,recurrence,requires_approval,metadata
            ) VALUES(
              'tasks','Vezetői ellenőrzés: '||NEW.title,
              'Automatikusan létrehozott vezetői ellenőrző feladat az elvégzett dolgozói feladat jóváhagyásához.',
              NEW.location_name,NEW.department,'Vezető','high','assigned',now()+interval '4 hours',NULL,false,
              jsonb_build_object('system_generated',true,'verification_of',NEW.id::text,'verification_reason','completed','source_due_at',NEW.due_at)
            );
          END IF;
          RETURN NEW;
        END $$;
        DROP TRIGGER IF EXISTS trg_kleo_supervisor_verification_task ON operations_quality_records;
        CREATE TRIGGER trg_kleo_supervisor_verification_task
          AFTER UPDATE OF status ON operations_quality_records
          FOR EACH ROW EXECUTE FUNCTION kleo_create_supervisor_verification_task();
      `);
    }
  })().catch(error => {
    schemaPromise = null;
    throw error;
  });
  return schemaPromise;
}

function maintenanceRuleFallback(): MaintenanceRule {
  return {
    rule_key: MAINTENANCE_RULE_KEY,
    scope_type: "global",
    scope_id: "*",
    enabled: true,
    warning_value: MAINTENANCE_DEFAULT_WARNING_DAYS,
    deadline_value: null,
    escalation_enabled: true,
    level2_after_hours: 24,
    level3_after_hours: 72,
    email_enabled: true,
    push_enabled: true,
  };
}

export async function loadMaintenanceRule(locationId?: string | null): Promise<MaintenanceRule> {
  await ensurePdfGreenComplianceSchema();
  const location = clean(locationId, 100) || null;
  const { rows } = await db.query(`
    SELECT * FROM vir_alert_rules
     WHERE rule_key=$1
       AND ((scope_type='location' AND scope_id=$2) OR (scope_type='global' AND scope_id='*'))
     ORDER BY CASE WHEN scope_type='location' THEN 0 ELSE 1 END
     LIMIT 1
  `, [MAINTENANCE_RULE_KEY, location]);
  return (rows[0] || maintenanceRuleFallback()) as MaintenanceRule;
}

export async function listMaintenanceCatalog() {
  await ensurePdfGreenComplianceSchema();
  const rules = (await db.query(`SELECT * FROM vir_alert_rules WHERE rule_key=$1 ORDER BY scope_type,scope_id`, [MAINTENANCE_RULE_KEY])).rows;
  return {
    rules,
    catalog: [{
      key: MAINTENANCE_RULE_KEY,
      title: "Karbantartási / szerviz határidő",
      description: "A karbantartási és szervizfeladatok esedékessége előtt X nappal automatikus VIR riasztást hoz létre.",
      warning_unit: "nap",
      deadline_label: null,
    }],
  };
}

export async function upsertMaintenanceRule(body: any, actor: any) {
  await ensurePdfGreenComplianceSchema();
  const scopeType = body?.scope_type === "location" ? "location" : "global";
  const scopeId = scopeType === "global" ? "*" : clean(body?.scope_id, 100);
  if (scopeType === "location" && !scopeId) throw Object.assign(new Error("A szalon kiválasztása kötelező."), { status: 400 });
  const fallback = await loadMaintenanceRule(scopeType === "location" ? scopeId : null);
  const warningValue = int(body?.warning_value, 0, 3650, Number(fallback.warning_value || MAINTENANCE_DEFAULT_WARNING_DAYS));
  const level2 = int(body?.level2_after_hours, 0, 8760, Number(fallback.level2_after_hours || 24));
  const level3 = int(body?.level3_after_hours, level2, 8760, Math.max(level2, Number(fallback.level3_after_hours || 72)));
  const updatedBy = clean(actor?.email || actor?.id || actor?.userId || "system", 320);
  const old = (await db.query(`SELECT * FROM vir_alert_rules WHERE rule_key=$1 AND scope_type=$2 AND scope_id=$3`, [MAINTENANCE_RULE_KEY, scopeType, scopeId])).rows[0] || null;
  const row = (await db.query(`
    INSERT INTO vir_alert_rules(rule_key,scope_type,scope_id,enabled,warning_value,deadline_value,escalation_enabled,level2_after_hours,level3_after_hours,email_enabled,push_enabled,updated_by,updated_at)
    VALUES($1,$2,$3,$4,$5,NULL,$6,$7,$8,$9,$10,$11,now())
    ON CONFLICT(rule_key,scope_type,scope_id) DO UPDATE SET
      enabled=EXCLUDED.enabled,warning_value=EXCLUDED.warning_value,deadline_value=NULL,
      escalation_enabled=EXCLUDED.escalation_enabled,level2_after_hours=EXCLUDED.level2_after_hours,level3_after_hours=EXCLUDED.level3_after_hours,
      email_enabled=EXCLUDED.email_enabled,push_enabled=EXCLUDED.push_enabled,updated_by=EXCLUDED.updated_by,updated_at=now()
    RETURNING *
  `, [MAINTENANCE_RULE_KEY, scopeType, scopeId, bool(body?.enabled, fallback.enabled), warningValue, bool(body?.escalation_enabled, fallback.escalation_enabled), level2, level3, bool(body?.email_enabled, fallback.email_enabled), bool(body?.push_enabled, fallback.push_enabled), updatedBy])).rows[0];
  await db.query(`INSERT INTO vir_alert_rule_audit(rule_key,scope_type,scope_id,action,old_data,new_data,actor) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)`, [MAINTENANCE_RULE_KEY, scopeType, scopeId, old ? "update" : "create", JSON.stringify(old), JSON.stringify(row), updatedBy]);
  if (scopeType === "global") {
    await db.query(`INSERT INTO system_settings(key,scope_type,scope_id,value,category,updated_by,updated_at) VALUES('maintenance.warning_days','global','*',to_jsonb($1::int),'maintenance',$2,now()) ON CONFLICT(key,scope_type,scope_id) DO UPDATE SET value=EXCLUDED.value,updated_by=EXCLUDED.updated_by,updated_at=now()`, [warningValue, updatedBy]).catch(() => undefined);
  }
  return row;
}

export async function removeMaintenanceRuleOverride(scopeIdRaw: string, actor: any) {
  await ensurePdfGreenComplianceSchema();
  const scopeId = clean(scopeIdRaw, 100);
  if (!scopeId) throw Object.assign(new Error("A szalon azonosítója kötelező."), { status: 400 });
  const old = (await db.query(`DELETE FROM vir_alert_rules WHERE rule_key=$1 AND scope_type='location' AND scope_id=$2 RETURNING *`, [MAINTENANCE_RULE_KEY, scopeId])).rows[0];
  if (!old) throw Object.assign(new Error("Nincs törölhető szalonspecifikus felülírás."), { status: 404 });
  await db.query(`INSERT INTO vir_alert_rule_audit(rule_key,scope_type,scope_id,action,old_data,new_data,actor) VALUES($1,'location',$2,'delete',$3::jsonb,NULL,$4)`, [MAINTENANCE_RULE_KEY, scopeId, JSON.stringify(old), clean(actor?.email || actor?.id || "system", 320)]);
  return { ok: true };
}

function maintenanceAlert(row: any, rule: MaintenanceRule, entityType: string): MaintenanceAlert | null {
  const dueAt = row.due_at ? new Date(row.due_at) : null;
  if (!dueAt || !Number.isFinite(dueAt.getTime())) return null;
  const days = Math.ceil((dueAt.getTime() - Date.now()) / 86_400_000);
  if (days >= 0 && days > Number(rule.warning_value || 0)) return null;
  const critical = days < 0;
  const timeText = critical ? `${Math.abs(days)} napja lejárt` : days === 0 ? "ma esedékes" : `${days} napon belül esedékes`;
  const id = String(row.id);
  return {
    key: `maintenance-due:${entityType}:${id}:${critical ? "critical" : "warning"}`,
    type: MAINTENANCE_RULE_KEY,
    severity: critical ? "critical" : "warning",
    title: `${row.title || "Karbantartás"} – ${timeText}`,
    detail: [row.department || row.location_name || "Karbantartás", row.assignee ? `felelős: ${row.assignee}` : "nincs felelős"].filter(Boolean).join(" · "),
    route: "/spec/maintenance",
    created_at: new Date().toISOString(),
    due_at: dueAt.toISOString(),
    location_id: row.location_id ? String(row.location_id) : null,
    entity_type: entityType,
    entity_id: id,
    payload: { status: row.status || null, warning_days: rule.warning_value, rule_scope_type: rule.scope_type, rule_scope_id: rule.scope_id },
  };
}

export async function collectMaintenanceAlerts(locationId?: string | null): Promise<MaintenanceAlert[]> {
  await ensurePdfGreenComplianceSchema();
  const requested = clean(locationId, 100) || null;
  const rows: any[] = [];
  if (await tableExists("operations_quality_records")) {
    const q = await db.query(`
      SELECT q.id::text,q.title,q.status,q.department,q.assignee,q.location_name,q.due_at,
             NULLIF(to_jsonb(q)->>'location_id','') location_id
        FROM operations_quality_records q
       WHERE q.module_key='maintenance'
         AND q.due_at IS NOT NULL
         AND q.status NOT IN('resolved','closed','archived','cancelled','approved')
         AND ($1::text IS NULL OR NULLIF(to_jsonb(q)->>'location_id','') IS NULL OR NULLIF(to_jsonb(q)->>'location_id','')=$1)
       ORDER BY q.due_at
       LIMIT 1000
    `, [requested]);
    rows.push(...q.rows.map((row: any) => ({ ...row, entity_type: "maintenance_record" })));
  }
  if (await tableExists("vir_module_records")) {
    const q = await db.query(`
      SELECT r.id::text,r.title,r.status,NULLIF(r.payload->>'department','') department,
             NULLIF(r.payload->>'assignee','') assignee,NULLIF(r.payload->>'location_name','') location_name,
             r.due_at,r.location_id
        FROM vir_module_records r
       WHERE r.module_key='maintenance' AND r.is_active=true AND r.due_at IS NOT NULL
         AND r.status NOT IN('resolved','closed','archived','cancelled','approved')
         AND ($1::text IS NULL OR r.location_id IS NULL OR r.location_id=$1)
       ORDER BY r.due_at
       LIMIT 1000
    `, [requested]);
    rows.push(...q.rows.map((row: any) => ({ ...row, entity_type: "vir_maintenance_record" })));
  }
  const alerts: MaintenanceAlert[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const rule = await loadMaintenanceRule(row.location_id || null);
    if (!rule.enabled) continue;
    const alert = maintenanceAlert(row, rule, row.entity_type);
    if (!alert || seen.has(`${alert.entity_type}:${alert.entity_id}`)) continue;
    seen.add(`${alert.entity_type}:${alert.entity_id}`);
    alerts.push(alert);
  }
  return alerts.sort((a, b) => +new Date(a.due_at) - +new Date(b.due_at));
}

async function managementRecipients(locationId: string | null) {
  if (!(await tableExists("users"))) return [] as Array<{ email: string; user_key: string }>;
  const { rows } = await db.query(`
    SELECT DISTINCT lower(NULLIF(to_jsonb(u)->>'email','')) email
      FROM users u
     WHERE NULLIF(to_jsonb(u)->>'email','') IS NOT NULL
       AND lower(COALESCE(to_jsonb(u)->>'role','')) ~ '(admin|manager|vezet|location_manager|salon_manager|store_manager)'
       AND ($1::text IS NULL OR NULLIF(to_jsonb(u)->>'location_id','') IS NULL OR NULLIF(to_jsonb(u)->>'location_id','')=$1)
  `, [locationId]);
  return rows.filter((row: any) => row.email).map((row: any) => ({ email: String(row.email), user_key: `email:${String(row.email)}` }));
}

async function persistMaintenanceEvents(alerts: MaintenanceAlert[]) {
  const keys = alerts.map(a => a.key);
  for (const alert of alerts) {
    await db.query(`
      INSERT INTO vir_operational_alert_events(event_key,alert_type,severity,title,detail,route,entity_type,entity_id,location_id,due_at,payload,last_seen_at,resolved_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,now(),NULL)
      ON CONFLICT(event_key) DO UPDATE SET severity=EXCLUDED.severity,title=EXCLUDED.title,detail=EXCLUDED.detail,route=EXCLUDED.route,
        location_id=EXCLUDED.location_id,due_at=EXCLUDED.due_at,payload=EXCLUDED.payload,last_seen_at=now(),resolved_at=NULL
    `, [alert.key, alert.type, alert.severity, alert.title, alert.detail, alert.route, alert.entity_type, alert.entity_id, alert.location_id, alert.due_at, JSON.stringify(alert.payload)]);
  }
  if (keys.length) {
    await db.query(`UPDATE vir_operational_alert_events SET resolved_at=now() WHERE alert_type=$1 AND resolved_at IS NULL AND NOT(event_key=ANY($2::text[]))`, [MAINTENANCE_RULE_KEY, keys]);
  } else {
    await db.query(`UPDATE vir_operational_alert_events SET resolved_at=now() WHERE alert_type=$1 AND resolved_at IS NULL`, [MAINTENANCE_RULE_KEY]);
  }
}

async function deliverMaintenanceEmails(alerts: MaintenanceAlert[]) {
  let sent = 0;
  for (const alert of alerts) {
    const rule = await loadMaintenanceRule(alert.location_id);
    if (!rule.email_enabled) continue;
    const recipients = await managementRecipients(alert.location_id);
    for (const recipient of recipients) {
      const existing = (await db.query(`SELECT status,attempts FROM vir_alert_deliveries WHERE event_key=$1 AND user_key=$2 AND channel='email'`, [alert.key, recipient.user_key])).rows[0];
      if (existing?.status === "sent" || Number(existing?.attempts || 0) >= 5) continue;
      try {
        const result: any = await sendEmail({
          to: recipient.email,
          subject: `Kleopátra VIR – karbantartási riasztás: ${alert.title}`,
          text: `${alert.title}\n${alert.detail}\nHatáridő: ${new Date(alert.due_at).toLocaleString("hu-HU")}\nMegnyitás: ${alert.route}`,
          html: `<div style="font-family:Arial,sans-serif"><h2>Karbantartási riasztás</h2><p><b>${alert.title}</b></p><p>${alert.detail}</p><p>Határidő: ${new Date(alert.due_at).toLocaleString("hu-HU")}</p></div>`,
        });
        if (result?.sent === false) throw new Error("SMTP_NOT_CONFIGURED");
        await db.query(`INSERT INTO vir_alert_deliveries(event_key,user_key,channel,status,attempts,last_error,sent_at,updated_at,recipient_email,recipient_role,escalation_level,source) VALUES($1,$2,'email','sent',1,NULL,now(),now(),$3,'management',0,'preference') ON CONFLICT(event_key,user_key,channel) DO UPDATE SET status='sent',attempts=vir_alert_deliveries.attempts+1,last_error=NULL,sent_at=now(),updated_at=now(),recipient_email=EXCLUDED.recipient_email`, [alert.key, recipient.user_key, recipient.email]);
        sent += 1;
      } catch (error: any) {
        await db.query(`INSERT INTO vir_alert_deliveries(event_key,user_key,channel,status,attempts,last_error,updated_at,recipient_email,recipient_role,escalation_level,source) VALUES($1,$2,'email','failed',1,$3,now(),$4,'management',0,'preference') ON CONFLICT(event_key,user_key,channel) DO UPDATE SET status='failed',attempts=vir_alert_deliveries.attempts+1,last_error=EXCLUDED.last_error,updated_at=now()`, [alert.key, recipient.user_key, clean(error?.message || error, 800), recipient.email]);
      }
    }
  }
  return sent;
}

export async function runMaintenanceAlertAutomation() {
  const alerts = await collectMaintenanceAlerts();
  await persistMaintenanceEvents(alerts);
  const sent = await deliverMaintenanceEmails(alerts);
  return { alerts: alerts.length, critical: alerts.filter(a => a.severity === "critical").length, email_sent: sent };
}

export async function maintenanceSummary(locationId?: string | null) {
  const alerts = await collectMaintenanceAlerts(locationId);
  return { maintenance_due: alerts.length, maintenance_critical: alerts.filter(a => a.severity === "critical").length };
}

export async function reconcileSupervisorVerificationTasks() {
  await ensurePdfGreenComplianceSchema();
  if (!(await tableExists("operations_quality_records"))) return { created: 0 };
  const result = await db.query(`
    INSERT INTO operations_quality_records(
      module_key,title,description,location_name,department,assignee,priority,status,due_at,recurrence,requires_approval,metadata
    )
    SELECT 'tasks','Vezetői ellenőrzés: '||q.title,
           CASE WHEN q.status='completed'
                THEN 'Automatikus vezetői ellenőrzés az elvégzett dolgozói feladat jóváhagyásához.'
                ELSE 'Automatikus vezetői ellenőrzés a határidőre le nem zárt dolgozói feladathoz.' END,
           q.location_name,q.department,'Vezető','high','assigned',
           CASE WHEN q.status='completed' THEN now()+interval '4 hours' ELSE now()+interval '2 hours' END,
           NULL,false,
           jsonb_build_object('system_generated',true,'verification_of',q.id::text,'verification_reason',CASE WHEN q.status='completed' THEN 'completed' ELSE 'overdue' END,'source_due_at',q.due_at)
      FROM operations_quality_records q
     WHERE q.module_key='tasks'
       AND COALESCE(q.requires_approval,false)=true
       AND COALESCE(q.metadata->>'system_generated','false')<>'true'
       AND (q.status='completed' OR (q.due_at<now() AND q.status NOT IN('approved','resolved','closed','cancelled')))
       AND NOT EXISTS(
         SELECT 1 FROM operations_quality_records v
          WHERE v.module_key='tasks'
            AND v.metadata->>'verification_of'=q.id::text
            AND COALESCE(v.metadata->>'system_generated','false')='true'
       )
    RETURNING id
  `);
  return { created: result.rowCount || 0 };
}

export async function processAccountingHireEmails(limit = 25) {
  await ensurePdfGreenComplianceSchema();
  if (!(await tableExists("hr_recruitment_applications"))) return { attempted: 0, sent: 0 };
  const accountingEmail = clean(process.env.ACCOUNTING_EMAIL || "konyveles@kleoszalon.hu", 320).toLowerCase();
  await db.query(`UPDATE hr_recruitment_accounting_email_queue SET recipient_email=$1 WHERE sent_at IS NULL AND recipient_email<>$1`, [accountingEmail]);
  const { rows } = await db.query(`
    SELECT q.id,q.application_id::text,q.employee_id::text,q.recipient_email,q.attempts,
           a.first_name,a.last_name,a.email applicant_email,a.phone,
           COALESCE(p.name,'Munkatárs') position_name,
           COALESCE(l.name,'Nincs megadva') location_name,
           NULLIF(to_jsonb(e)->>'employment_type','') employment_type
      FROM hr_recruitment_accounting_email_queue q
      JOIN hr_recruitment_applications a ON a.id=q.application_id
      LEFT JOIN employees e ON e.id=q.employee_id
      LEFT JOIN hr_positions p ON p.id=a.position_id
      LEFT JOIN locations l ON l.id=COALESCE(e.location_id,a.preferred_location_id)
     WHERE q.sent_at IS NULL AND q.attempts<8
     ORDER BY q.queued_at
     LIMIT $1
  `, [Math.max(1, Math.min(100, limit))]);
  let sent = 0;
  for (const row of rows) {
    const fullName = `${row.last_name || ""} ${row.first_name || ""}`.trim();
    try {
      const result: any = await sendEmail({
        to: row.recipient_email,
        subject: `Új munkatárs felvéve – ${fullName}`,
        text: `Kedves Könyvelés!\n\nA VIR-ben új munkatárs került felvételre.\n\nNév: ${fullName}\nMunkakör: ${row.position_name}\nTelephely: ${row.location_name}\nFoglalkoztatási forma: ${row.employment_type || "nincs megadva"}\nE-mail: ${row.applicant_email || "nincs"}\nTelefon: ${row.phone || "nincs"}\nMunkatárs azonosító: ${row.employee_id || "nincs"}\n\nAz üzenetet a Kleopátra VIR automatikusan küldte.`,
        html: `<div style="font-family:Arial,sans-serif"><h2>Új munkatárs felvéve</h2><p><b>${fullName}</b></p><ul><li>Munkakör: ${row.position_name}</li><li>Telephely: ${row.location_name}</li><li>Foglalkoztatási forma: ${row.employment_type || "nincs megadva"}</li><li>E-mail: ${row.applicant_email || "nincs"}</li><li>Telefon: ${row.phone || "nincs"}</li></ul><p>Automatikus VIR értesítés.</p></div>`,
      });
      if (result?.sent === false) throw new Error("SMTP_NOT_CONFIGURED");
      await db.query(`UPDATE hr_recruitment_accounting_email_queue SET status='sent',attempts=attempts+1,last_error=NULL,last_attempt_at=now(),sent_at=now() WHERE id=$1`, [row.id]);
      sent += 1;
    } catch (error: any) {
      await db.query(`UPDATE hr_recruitment_accounting_email_queue SET status='failed',attempts=attempts+1,last_error=$2,last_attempt_at=now() WHERE id=$1`, [row.id, clean(error?.message || error, 1000)]);
    }
  }
  return { attempted: rows.length, sent };
}

function firstHeader(req: AuthRequest, name: string) {
  const raw = req.headers?.[name];
  return Array.isArray(raw) ? String(raw[0] || "") : String(raw || "");
}

export async function recordUiAuditEvents(req: AuthRequest, rawEvents: unknown) {
  await ensurePdfGreenComplianceSchema();
  const events = Array.isArray(rawEvents) ? rawEvents.slice(0, 100) : [];
  if (!events.length) return { accepted: 0 };
  const actorKey = clean(req.user?.email || req.user?.id || "anonymous", 320);
  const actorRole = clean(Array.isArray(req.user?.role) ? req.user?.role.join(",") : req.user?.role, 500) || null;
  const locationId = req.user?.location_id == null ? null : clean(req.user.location_id, 100);
  const requestId = clean(firstHeader(req, "x-request-id") || firstHeader(req, "x-render-request-id"), 200) || null;
  const userAgent = clean(firstHeader(req, "user-agent"), 1000) || null;
  const forwarded = clean(firstHeader(req, "x-forwarded-for").split(",")[0], 100);
  const ipAddress = forwarded || req.ip || req.socket?.remoteAddress || null;
  let accepted = 0;
  for (const item of events) {
    if (!item || typeof item !== "object") continue;
    const e: any = item;
    const route = clean(e.route, 500);
    const eventType = clean(e.event_type, 80);
    if (!route || !eventType || !["click","route","window","dialog","submit","filter","export"].includes(eventType)) continue;
    const occurred = Number(e.occurred_at);
    const occurredAt = Number.isFinite(occurred) && occurred > 0 ? new Date(occurred).toISOString() : new Date().toISOString();
    await db.query(`INSERT INTO ui_audit_events(actor_key,actor_role,location_id,route,event_type,target,label,metadata,request_id,ip_address,user_agent,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12::timestamptz)`, [
      actorKey, actorRole, locationId, route, eventType, clean(e.target, 500) || null, clean(e.label, 1000) || null,
      JSON.stringify(e.metadata && typeof e.metadata === "object" ? e.metadata : {}), requestId, ipAddress, userAgent, occurredAt,
    ]);
    accepted += 1;
  }
  return { accepted };
}

export async function listUiAuditEvents(limitRaw?: unknown) {
  await ensurePdfGreenComplianceSchema();
  const limit = int(limitRaw, 1, 1000, 250);
  const [items, summary] = await Promise.all([
    db.query(`SELECT id,actor_key,actor_role,location_id,route,event_type,target,label,metadata,request_id,ip_address,user_agent,occurred_at FROM ui_audit_events ORDER BY occurred_at DESC LIMIT $1`, [limit]).then(r => r.rows),
    db.query(`SELECT count(*) FILTER(WHERE occurred_at>=current_date)::int today,count(*) FILTER(WHERE event_type='click')::int clicks,count(*) FILTER(WHERE event_type='route')::int routes,count(*) FILTER(WHERE event_type='window')::int windows FROM ui_audit_events WHERE occurred_at>=now()-interval '30 days'`).then(r => r.rows[0]),
  ]);
  return { items, summary };
}

export async function runPdfGreenAutomation() {
  await ensurePdfGreenComplianceSchema();
  const [maintenance, verification, accounting] = await Promise.all([
    runMaintenanceAlertAutomation(),
    reconcileSupervisorVerificationTasks(),
    processAccountingHireEmails(),
  ]);
  return { maintenance, verification, accounting };
}

export function startPdfGreenComplianceScheduler() {
  if (schedulerStarted) return;
  schedulerStarted = true;
  setTimeout(() => {
    ensurePdfGreenComplianceSchema()
      .then(() => runPdfGreenAutomation())
      .then(result => console.log("[PDF GREEN COMPLIANCE] initial run", result))
      .catch(error => console.error("[PDF GREEN COMPLIANCE] initial run failed", error?.message || error));
  }, 15_000);
  cron.schedule("23 * * * *", async () => {
    try {
      const result = await runPdfGreenAutomation();
      console.log("[PDF GREEN COMPLIANCE] hourly run", result);
    } catch (error: any) {
      console.error("[PDF GREEN COMPLIANCE] scheduler failed", error?.message || error);
    }
  }, { timezone: BUDAPEST_TZ });
  cron.schedule("*/5 * * * *", async () => {
    try { await processAccountingHireEmails(); } catch (error: any) { console.error("[PDF GREEN COMPLIANCE] accounting mail worker failed", error?.message || error); }
  }, { timezone: BUDAPEST_TZ });
  console.log("[PDF GREEN COMPLIANCE] scheduler started");
}
