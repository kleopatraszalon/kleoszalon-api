import cron from "node-cron";
import webpush from "web-push";
import db from "../db";
import { sendEmail } from "../mailer";
import { ensureOperationalAlertSchema } from "./operationalAlertAutomation";

export type AlertRuleKey = "supplier_expiry" | "employee_document" | "complaint_sla";
export type AlertSeverity = "warning" | "critical";
export type RuleScopeType = "global" | "location";

export type RuleDrivenAlert = {
  key: string;
  type: AlertRuleKey;
  severity: AlertSeverity;
  title: string;
  detail: string;
  route: string;
  created_at: string;
  due_at?: string | null;
  location_id?: string | null;
  entity_type: string;
  entity_id: string;
  payload?: Record<string, unknown>;
};

export type AlertRule = {
  rule_key: AlertRuleKey;
  scope_type: RuleScopeType;
  scope_id: string;
  enabled: boolean;
  warning_value: number;
  deadline_value: number | null;
  escalation_enabled: boolean;
  level2_after_hours: number;
  level3_after_hours: number;
  email_enabled: boolean;
  push_enabled: boolean;
  updated_by?: string | null;
  updated_at?: string;
};

type Recipient = {
  user_key: string;
  email: string | null;
  role: string;
  roles: string[];
  location_id: string | null;
};

type DeliveryMeta = {
  recipient_email?: string | null;
  recipient_role?: string | null;
  escalation_level?: number;
  source?: "preference" | "escalation" | "manual_retry";
};

const RULE_KEYS: AlertRuleKey[] = ["supplier_expiry", "employee_document", "complaint_sla"];
const DEFAULT_RULES: Record<AlertRuleKey, Omit<AlertRule, "rule_key" | "scope_type" | "scope_id">> = {
  supplier_expiry: {
    enabled: true,
    warning_value: 30,
    deadline_value: null,
    escalation_enabled: true,
    level2_after_hours: 24,
    level3_after_hours: 72,
    email_enabled: true,
    push_enabled: true,
  },
  employee_document: {
    enabled: true,
    warning_value: 30,
    deadline_value: null,
    escalation_enabled: true,
    level2_after_hours: 24,
    level3_after_hours: 72,
    email_enabled: true,
    push_enabled: true,
  },
  complaint_sla: {
    enabled: true,
    warning_value: 24,
    deadline_value: 120,
    escalation_enabled: true,
    level2_after_hours: 4,
    level3_after_hours: 24,
    email_enabled: true,
    push_enabled: true,
  },
};

export const ALERT_RULE_CATALOG = [
  {
    key: "supplier_expiry" as const,
    title: "Beszállítói / termék lejárat",
    description: "A beszállítói LOT/sarzs lejárata előtt induló figyelmeztetés és lejárat utáni eszkaláció.",
    warning_unit: "nap",
    deadline_label: null,
  },
  {
    key: "employee_document" as const,
    title: "Dolgozói dokumentumlejárat",
    description: "Képesítések, engedélyek, alkalmassági dokumentumok és határozott munkaszerződések figyelése.",
    warning_unit: "nap",
    deadline_label: null,
  },
  {
    key: "complaint_sla" as const,
    title: "Panasz SLA",
    description: "Panaszkezelési határidő, előriasztás és többszintű vezetői eszkaláció.",
    warning_unit: "óra",
    deadline_label: "SLA határidő (óra)",
  },
];

const LEVEL_ROLE_KEYS: Record<number, string[]> = {
  1: ["location_manager", "salon_manager", "szalonvezető", "szalonvezeto"],
  2: ["manager", "business_manager", "üzletvezető", "uzletvezeto", "vezető", "vezeto"],
  3: ["admin", "administrator", "superadmin", "super_admin", "rendszergazda"],
};

let schemaPromise: Promise<void> | null = null;
let schedulerStarted = false;
let vapidPromise: Promise<{ publicKey: string; privateKey: string }> | null = null;

const clean = (value: unknown) => String(value ?? "").trim();
const asBool = (value: unknown, fallback = false) => value == null ? fallback : value === true || value === 1 || ["true", "1", "yes", "on"].includes(String(value).toLowerCase());
const clampInt = (value: unknown, min: number, max: number, fallback: number) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
};

function roleKeys(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String).map(x => x.trim().toLowerCase()).filter(Boolean);
  const value = clean(raw);
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String).map(x => x.trim().toLowerCase()).filter(Boolean);
    if (parsed != null) return [String(parsed).trim().toLowerCase()].filter(Boolean);
  } catch {}
  return value.replace(/[\[\]"]/g, "").split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
}

async function legacySettingNumber(key: string, fallback: number) {
  try {
    const row = (await db.query(
      `SELECT value FROM system_settings WHERE key=$1 AND scope_type='global' AND scope_id='*' LIMIT 1`,
      [key],
    )).rows[0];
    const raw = row?.value;
    const n = Number(typeof raw === "string" ? raw : raw ?? fallback);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

export async function ensureAlertRuleEngineSchema() {
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
    await ensureOperationalAlertSchema();
    await db.query(`
      CREATE TABLE IF NOT EXISTS vir_alert_rules (
        rule_key text NOT NULL,
        scope_type text NOT NULL DEFAULT 'global' CHECK(scope_type IN('global','location')),
        scope_id text NOT NULL DEFAULT '*',
        enabled boolean NOT NULL DEFAULT true,
        warning_value integer NOT NULL DEFAULT 0 CHECK(warning_value >= 0),
        deadline_value integer,
        escalation_enabled boolean NOT NULL DEFAULT true,
        level2_after_hours integer NOT NULL DEFAULT 4 CHECK(level2_after_hours >= 0),
        level3_after_hours integer NOT NULL DEFAULT 24 CHECK(level3_after_hours >= 0),
        email_enabled boolean NOT NULL DEFAULT true,
        push_enabled boolean NOT NULL DEFAULT true,
        updated_by text,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(rule_key,scope_type,scope_id)
      );

      CREATE TABLE IF NOT EXISTS vir_alert_rule_audit (
        id bigserial PRIMARY KEY,
        rule_key text NOT NULL,
        scope_type text NOT NULL,
        scope_id text NOT NULL,
        action text NOT NULL,
        old_data jsonb,
        new_data jsonb,
        actor text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS vir_alert_rule_audit_created_idx ON vir_alert_rule_audit(created_at DESC);

      ALTER TABLE vir_alert_deliveries ADD COLUMN IF NOT EXISTS recipient_email text;
      ALTER TABLE vir_alert_deliveries ADD COLUMN IF NOT EXISTS recipient_role text;
      ALTER TABLE vir_alert_deliveries ADD COLUMN IF NOT EXISTS escalation_level integer NOT NULL DEFAULT 0;
      ALTER TABLE vir_alert_deliveries ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'preference';

      CREATE TABLE IF NOT EXISTS vir_alert_delivery_attempts (
        id bigserial PRIMARY KEY,
        delivery_id bigint,
        event_key text NOT NULL,
        user_key text NOT NULL,
        recipient_email text,
        recipient_role text,
        escalation_level integer NOT NULL DEFAULT 0,
        source text NOT NULL DEFAULT 'preference',
        channel text NOT NULL,
        status text NOT NULL,
        error text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS vir_alert_delivery_attempts_created_idx ON vir_alert_delivery_attempts(created_at DESC);
      CREATE INDEX IF NOT EXISTS vir_alert_delivery_attempts_event_idx ON vir_alert_delivery_attempts(event_key,created_at DESC);
    `);

    const supplierWarning = await legacySettingNumber("supplier.shelf_life_warning_days", DEFAULT_RULES.supplier_expiry.warning_value);
    const documentWarning = await legacySettingNumber("hr.document_expiry_warning_days", DEFAULT_RULES.employee_document.warning_value);
    const complaintDeadline = await legacySettingNumber("complaints.sla_default_hours", DEFAULT_RULES.complaint_sla.deadline_value || 120);
    const complaintWarning = await legacySettingNumber("complaints.sla_warning_hours", DEFAULT_RULES.complaint_sla.warning_value);

    const seeds: AlertRule[] = [
      { rule_key: "supplier_expiry", scope_type: "global", scope_id: "*", ...DEFAULT_RULES.supplier_expiry, warning_value: Math.max(0, Math.round(supplierWarning)) },
      { rule_key: "employee_document", scope_type: "global", scope_id: "*", ...DEFAULT_RULES.employee_document, warning_value: Math.max(0, Math.round(documentWarning)) },
      { rule_key: "complaint_sla", scope_type: "global", scope_id: "*", ...DEFAULT_RULES.complaint_sla, warning_value: Math.max(0, Math.round(complaintWarning)), deadline_value: Math.max(1, Math.round(complaintDeadline)) },
    ];
    for (const seed of seeds) {
      await db.query(
        `INSERT INTO vir_alert_rules(rule_key,scope_type,scope_id,enabled,warning_value,deadline_value,escalation_enabled,level2_after_hours,level3_after_hours,email_enabled,push_enabled)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT(rule_key,scope_type,scope_id) DO NOTHING`,
        [seed.rule_key, seed.scope_type, seed.scope_id, seed.enabled, seed.warning_value, seed.deadline_value, seed.escalation_enabled, seed.level2_after_hours, seed.level3_after_hours, seed.email_enabled, seed.push_enabled],
      );
    }
  })().catch((error) => {
    schemaPromise = null;
    throw error;
  });
  return schemaPromise;
}

export async function loadAlertRuleSnapshot(): Promise<AlertRule[]> {
  await ensureAlertRuleEngineSchema();
  return (await db.query(`SELECT * FROM vir_alert_rules ORDER BY rule_key,scope_type,scope_id`)).rows as AlertRule[];
}

export function resolveAlertRule(snapshot: AlertRule[], ruleKey: AlertRuleKey, locationId?: string | null): AlertRule {
  const location = clean(locationId);
  const specific = location ? snapshot.find(r => r.rule_key === ruleKey && r.scope_type === "location" && String(r.scope_id) === location) : undefined;
  const global = snapshot.find(r => r.rule_key === ruleKey && r.scope_type === "global" && r.scope_id === "*");
  if (specific) return specific;
  if (global) return global;
  return { rule_key: ruleKey, scope_type: "global", scope_id: "*", ...DEFAULT_RULES[ruleKey] };
}

function requestedLocationMatches(rowLocation: unknown, requestedLocation?: string | null) {
  const requested = clean(requestedLocation);
  if (!requested) return true;
  const row = clean(rowLocation);
  return !row || row === requested;
}

function dateAtNoonUtc(value: unknown) {
  const text = clean(value).slice(0, 10);
  return new Date(`${text}T12:00:00Z`);
}

function daysUntil(value: unknown) {
  return Math.ceil((dateAtNoonUtc(value).getTime() - Date.now()) / 86_400_000);
}

function hoursUntil(value: unknown) {
  return Math.ceil((new Date(String(value)).getTime() - Date.now()) / 3_600_000);
}

function alertRulePayload(rule: AlertRule) {
  return {
    rule_scope_type: rule.scope_type,
    rule_scope_id: rule.scope_id,
    warning_value: rule.warning_value,
    deadline_value: rule.deadline_value,
    escalation_enabled: rule.escalation_enabled,
    level2_after_hours: rule.level2_after_hours,
    level3_after_hours: rule.level3_after_hours,
  };
}

export async function collectRuleDrivenAlerts(locationId?: string | null): Promise<RuleDrivenAlert[]> {
  await ensureAlertRuleEngineSchema();
  const rules = await loadAlertRuleSnapshot();
  const now = new Date().toISOString();
  const alerts: RuleDrivenAlert[] = [];

  const supplierRows = (await db.query(
    `SELECT b.id::text,b.location_id,b.lot_number,b.expires_at,b.quantity,
            COALESCE(s.name,'Ismeretlen beszállító') supplier_name,
            COALESCE(p.name,'Ismeretlen termék') product_name
       FROM supplier_expiry_batches b
       LEFT JOIN suppliers s ON s.id=b.supplier_id
       LEFT JOIN products p ON p.id=b.product_id
      WHERE b.active=true
      ORDER BY b.expires_at,b.id LIMIT 1000`,
  )).rows;
  for (const row of supplierRows) {
    if (!requestedLocationMatches(row.location_id, locationId)) continue;
    const rule = resolveAlertRule(rules, "supplier_expiry", row.location_id);
    if (!rule.enabled) continue;
    const days = daysUntil(row.expires_at);
    if (days >= 0 && days > Number(rule.warning_value || 0)) continue;
    const severity: AlertSeverity = days < 0 ? "critical" : "warning";
    const timeText = days < 0 ? `${Math.abs(days)} napja lejárt` : days === 0 ? "ma lejár" : `${days} napon belül lejár`;
    alerts.push({
      key: `supplier-expiry:${row.id}:${severity}`,
      type: "supplier_expiry",
      severity,
      title: `${row.product_name} – ${timeText}`,
      detail: `${row.supplier_name}${row.lot_number ? ` · tétel: ${row.lot_number}` : ""}${row.quantity != null ? ` · készlet: ${Number(row.quantity).toLocaleString("hu-HU")}` : ""}`,
      route: "/warehouse?view=procurement&section=suppliers",
      created_at: now,
      due_at: dateAtNoonUtc(row.expires_at).toISOString(),
      location_id: row.location_id ?? null,
      entity_type: "supplier_expiry_batch",
      entity_id: row.id,
      payload: { expires_at: row.expires_at, supplier_name: row.supplier_name, product_name: row.product_name, lot_number: row.lot_number, ...alertRulePayload(rule) },
    });
  }

  const documentRows = (await db.query(
    `SELECT d.id::text,d.document_type,d.document_name,d.document_number,d.valid_until,d.warning_days,
            e.id::text employee_id,e.full_name,e.location_id::text
       FROM employee_documents d JOIN employees e ON e.id=d.employee_id
      WHERE d.active=true AND COALESCE(e.active,true)=true AND d.valid_until IS NOT NULL
      ORDER BY d.valid_until,e.full_name LIMIT 1000`,
  )).rows;
  for (const row of documentRows) {
    if (!requestedLocationMatches(row.location_id, locationId)) continue;
    const rule = resolveAlertRule(rules, "employee_document", row.location_id);
    if (!rule.enabled) continue;
    const days = daysUntil(row.valid_until);
    const threshold = row.warning_days == null ? Number(rule.warning_value || 0) : Math.max(0, Number(row.warning_days));
    if (days >= 0 && days > threshold) continue;
    const severity: AlertSeverity = days < 0 ? "critical" : "warning";
    const timeText = days < 0 ? `${Math.abs(days)} napja lejárt` : days === 0 ? "ma lejár" : `${days} napon belül lejár`;
    alerts.push({
      key: `employee-document:${row.id}:${severity}`,
      type: "employee_document",
      severity,
      title: `${row.full_name}: ${row.document_name} ${timeText}`,
      detail: `${row.document_type}${row.document_number ? ` · ${row.document_number}` : ""}`,
      route: "/employees",
      created_at: now,
      due_at: dateAtNoonUtc(row.valid_until).toISOString(),
      location_id: row.location_id ?? null,
      entity_type: "employee_document",
      entity_id: row.id,
      payload: { employee_id: row.employee_id, valid_until: row.valid_until, document_type: row.document_type, individual_warning_days: row.warning_days, ...alertRulePayload(rule) },
    });
  }

  const contractRows = (await db.query(
    `SELECT c.id::text,c.contract_number,c.end_date,e.id::text employee_id,e.full_name,e.location_id::text
       FROM employment_contracts c JOIN employees e ON e.id=c.employee_id
      WHERE c.is_active=true AND COALESCE(e.active,true)=true AND c.end_date IS NOT NULL
      ORDER BY c.end_date,e.full_name LIMIT 1000`,
  )).rows;
  for (const row of contractRows) {
    if (!requestedLocationMatches(row.location_id, locationId)) continue;
    const rule = resolveAlertRule(rules, "employee_document", row.location_id);
    if (!rule.enabled) continue;
    const days = daysUntil(row.end_date);
    if (days >= 0 && days > Number(rule.warning_value || 0)) continue;
    const severity: AlertSeverity = days < 0 ? "critical" : "warning";
    const timeText = days < 0 ? `${Math.abs(days)} napja lejárt` : days === 0 ? "ma lejár" : `${days} napon belül lejár`;
    alerts.push({
      key: `employee-contract:${row.id}:${severity}`,
      type: "employee_document",
      severity,
      title: `${row.full_name}: munkaszerződés ${timeText}`,
      detail: row.contract_number ? `Szerződésszám: ${row.contract_number}` : "Határozott idejű szerződés lejárata közeleg.",
      route: "/employees",
      created_at: now,
      due_at: dateAtNoonUtc(row.end_date).toISOString(),
      location_id: row.location_id ?? null,
      entity_type: "employment_contract",
      entity_id: row.id,
      payload: { employee_id: row.employee_id, end_date: row.end_date, ...alertRulePayload(rule) },
    });
  }

  const qualityTable = (await db.query(`SELECT to_regclass('public.operations_quality_records') IS NOT NULL ok`)).rows[0]?.ok;
  if (qualityTable) {
    const complaintRows = (await db.query(
      `SELECT id::text,title,status,assignee,department,location_id,created_at,due_at,metadata
         FROM operations_quality_records
        WHERE module_key='complaints' AND status NOT IN ('resolved','rejected','closed','archived')
        ORDER BY created_at ASC LIMIT 1000`,
    )).rows;
    for (const row of complaintRows) {
      if (!requestedLocationMatches(row.location_id, locationId)) continue;
      const rule = resolveAlertRule(rules, "complaint_sla", row.location_id);
      if (!rule.enabled) continue;
      const deadlineHours = Math.max(1, Number(rule.deadline_value || DEFAULT_RULES.complaint_sla.deadline_value || 120));
      const deadline = row.due_at ? new Date(row.due_at) : new Date(new Date(row.created_at).getTime() + deadlineHours * 3_600_000);
      const hours = hoursUntil(deadline.toISOString());
      if (hours >= 0 && hours > Number(rule.warning_value || 0)) continue;
      const severity: AlertSeverity = hours < 0 ? "critical" : "warning";
      const timeText = hours < 0 ? `${Math.abs(hours)} órája SLA-n túl` : hours === 0 ? "SLA-határidő most" : `${hours} órán belül SLA-határidő`;
      alerts.push({
        key: `complaint-sla:${row.id}:${severity}`,
        type: "complaint_sla",
        severity,
        title: `${row.title} – ${timeText}`,
        detail: `${row.department || "Panaszkezelés"}${row.assignee ? ` · felelős: ${row.assignee}` : " · nincs felelős"}`,
        route: "/marketing/complaints",
        created_at: now,
        due_at: deadline.toISOString(),
        location_id: row.location_id ?? null,
        entity_type: "complaint",
        entity_id: row.id,
        payload: { status: row.status, metadata: row.metadata ?? {}, ...alertRulePayload(rule) },
      });
    }
  }

  return alerts.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "critical" ? -1 : 1;
    return +new Date(a.due_at || a.created_at) - +new Date(b.due_at || b.created_at);
  });
}

async function refreshEventStore(alerts: RuleDrivenAlert[]) {
  const keys = alerts.map(a => a.key);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    for (const alert of alerts) {
      await client.query(
        `INSERT INTO vir_operational_alert_events(event_key,alert_type,severity,title,detail,route,entity_type,entity_id,location_id,due_at,payload,last_seen_at,resolved_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,now(),NULL)
         ON CONFLICT(event_key) DO UPDATE SET alert_type=EXCLUDED.alert_type,severity=EXCLUDED.severity,title=EXCLUDED.title,
           detail=EXCLUDED.detail,route=EXCLUDED.route,location_id=EXCLUDED.location_id,due_at=EXCLUDED.due_at,payload=EXCLUDED.payload,last_seen_at=now(),resolved_at=NULL`,
        [alert.key, alert.type, alert.severity, alert.title, alert.detail, alert.route, alert.entity_type, alert.entity_id, alert.location_id ?? null, alert.due_at ?? null, JSON.stringify(alert.payload ?? {})],
      );
    }
    if (keys.length) {
      await client.query(
        `UPDATE vir_operational_alert_events SET resolved_at=now()
          WHERE resolved_at IS NULL AND alert_type IN('supplier_expiry','employee_document','complaint_sla') AND NOT(event_key=ANY($1::text[]))`,
        [keys],
      );
    } else {
      await client.query(`UPDATE vir_operational_alert_events SET resolved_at=now() WHERE resolved_at IS NULL AND alert_type IN('supplier_expiry','employee_document','complaint_sla')`);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function getVapidConfig() {
  const envPublic = clean(process.env.VAPID_PUBLIC_KEY);
  const envPrivate = clean(process.env.VAPID_PRIVATE_KEY);
  if (envPublic && envPrivate) return { publicKey: envPublic, privateKey: envPrivate };
  if (!vapidPromise) {
    vapidPromise = (async () => {
      const existing = await db.query(`SELECT secret_key,secret_value FROM app_runtime_secrets WHERE secret_key IN('vapid_public_key','vapid_private_key')`);
      const values = Object.fromEntries(existing.rows.map((x: any) => [x.secret_key, x.secret_value]));
      if (values.vapid_public_key && values.vapid_private_key) return { publicKey: values.vapid_public_key, privateKey: values.vapid_private_key };
      const generated = webpush.generateVAPIDKeys();
      await db.query(
        `INSERT INTO app_runtime_secrets(secret_key,secret_value) VALUES('vapid_public_key',$1),('vapid_private_key',$2) ON CONFLICT(secret_key) DO NOTHING`,
        [generated.publicKey, generated.privateKey],
      );
      const saved = await db.query(`SELECT secret_key,secret_value FROM app_runtime_secrets WHERE secret_key IN('vapid_public_key','vapid_private_key')`);
      const final = Object.fromEntries(saved.rows.map((x: any) => [x.secret_key, x.secret_value]));
      return { publicKey: final.vapid_public_key, privateKey: final.vapid_private_key };
    })().catch(error => { vapidPromise = null; throw error; });
  }
  return vapidPromise;
}

async function deliveryAlreadyDone(eventKey: string, userKey: string, channel: string) {
  const row = (await db.query(`SELECT status,attempts FROM vir_alert_deliveries WHERE event_key=$1 AND user_key=$2 AND channel=$3`, [eventKey, userKey, channel])).rows[0];
  return row?.status === "sent" || Number(row?.attempts || 0) >= 5;
}

async function recordDelivery(eventKey: string, userKey: string, channel: string, status: "sent" | "failed", error: unknown, meta: DeliveryMeta = {}) {
  const errorText = status === "failed" ? clean((error as any)?.message || error || "unknown") : null;
  const row = (await db.query(
    `INSERT INTO vir_alert_deliveries(event_key,user_key,channel,status,attempts,last_error,sent_at,updated_at,recipient_email,recipient_role,escalation_level,source)
     VALUES($1,$2,$3,$4,1,$5,CASE WHEN $4='sent' THEN now() ELSE NULL END,now(),$6,$7,$8,$9)
     ON CONFLICT(event_key,user_key,channel) DO UPDATE SET status=EXCLUDED.status,attempts=vir_alert_deliveries.attempts+1,last_error=EXCLUDED.last_error,
       sent_at=CASE WHEN EXCLUDED.status='sent' THEN now() ELSE vir_alert_deliveries.sent_at END,updated_at=now(),
       recipient_email=COALESCE(EXCLUDED.recipient_email,vir_alert_deliveries.recipient_email),recipient_role=COALESCE(EXCLUDED.recipient_role,vir_alert_deliveries.recipient_role),
       escalation_level=GREATEST(vir_alert_deliveries.escalation_level,EXCLUDED.escalation_level),source=EXCLUDED.source
     RETURNING id`,
    [eventKey, userKey, channel, status, errorText, meta.recipient_email ?? null, meta.recipient_role ?? null, meta.escalation_level ?? 0, meta.source ?? "preference"],
  )).rows[0];
  await db.query(
    `INSERT INTO vir_alert_delivery_attempts(delivery_id,event_key,user_key,recipient_email,recipient_role,escalation_level,source,channel,status,error)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [row?.id ?? null, eventKey, userKey, meta.recipient_email ?? null, meta.recipient_role ?? null, meta.escalation_level ?? 0, meta.source ?? "preference", channel, status, errorText],
  );
}

function preferenceAllows(pref: any, alert: RuleDrivenAlert) {
  if (pref.critical_only && alert.severity !== "critical") return false;
  if (pref.location_id && alert.location_id && String(pref.location_id) !== String(alert.location_id)) return false;
  if (alert.type === "supplier_expiry" && !pref.supplier_expiry) return false;
  if (alert.type === "employee_document" && !pref.employee_document) return false;
  if (alert.type === "complaint_sla" && !pref.complaint_sla) return false;
  return true;
}

async function deliverPreferenceEmail(pref: any, alerts: RuleDrivenAlert[]) {
  const userKey = String(pref.user_key);
  const email = clean(pref.email);
  if (!pref.email_enabled || !email) return 0;
  const pending: RuleDrivenAlert[] = [];
  for (const alert of alerts) if (!(await deliveryAlreadyDone(alert.key, userKey, "email"))) pending.push(alert);
  if (!pending.length) return 0;
  const critical = pending.filter(a => a.severity === "critical").length;
  const rows = pending.map(a => `<tr><td style="padding:8px;border-bottom:1px solid #eee"><b>${a.severity === "critical" ? "KRITIKUS" : "FIGYELMEZTETÉS"}</b></td><td style="padding:8px;border-bottom:1px solid #eee"><b>${a.title}</b><br><span>${a.detail}</span></td></tr>`).join("");
  try {
    const result: any = await sendEmail({
      to: email,
      subject: `Kleopátra VIR – ${pending.length} operatív figyelmeztetés${critical ? `, ${critical} kritikus` : ""}`,
      text: pending.map(a => `${a.severity.toUpperCase()}: ${a.title} – ${a.detail}`).join("\n"),
      html: `<div style="font-family:Arial,sans-serif;color:#241b18"><h2>Kleopátra VIR értesítési összefoglaló</h2><p>${pending.length} új figyelmeztetés vár intézkedésre.</p><table style="border-collapse:collapse;width:100%">${rows}</table></div>`,
    });
    if (result?.sent === false) throw new Error("Az SMTP nincs konfigurálva; az e-mail csak naplózásra került.");
    for (const alert of pending) await recordDelivery(alert.key, userKey, "email", "sent", null, { recipient_email: email, source: "preference" });
    return pending.length;
  } catch (error) {
    for (const alert of pending) await recordDelivery(alert.key, userKey, "email", "failed", error, { recipient_email: email, source: "preference" });
    return 0;
  }
}

async function sendPushToUser(userKey: string, alert: RuleDrivenAlert, meta: DeliveryMeta) {
  if (await deliveryAlreadyDone(alert.key, userKey, "push")) return false;
  const subscriptions = (await db.query(`SELECT id,subscription FROM vir_staff_push_subscriptions WHERE user_key=$1 AND active=true`, [userKey])).rows;
  if (!subscriptions.length) return false;
  const vapid = await getVapidConfig();
  const subject = clean(process.env.VAPID_SUBJECT) || `mailto:${clean(process.env.SMTP_USER) || "admin@kleoszalon.hu"}`;
  webpush.setVapidDetails(subject, vapid.publicKey, vapid.privateKey);
  let success = false;
  let lastError: unknown = null;
  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification(sub.subscription, JSON.stringify({
        title: alert.severity === "critical" ? "Kritikus VIR figyelmeztetés" : "Kleopátra VIR figyelmeztetés",
        body: `${alert.title} – ${alert.detail}`,
        tag: alert.key,
        url: alert.route,
        severity: alert.severity,
        type: alert.type,
      }));
      success = true;
      await db.query(`UPDATE vir_staff_push_subscriptions SET last_success_at=now(),last_error=NULL,updated_at=now() WHERE id=$1`, [sub.id]);
    } catch (error: any) {
      lastError = error;
      const gone = [404, 410].includes(Number(error?.statusCode || error?.status));
      await db.query(`UPDATE vir_staff_push_subscriptions SET active=CASE WHEN $2 THEN false ELSE active END,last_error=$3,updated_at=now() WHERE id=$1`, [sub.id, gone, clean(error?.message || error)]);
    }
  }
  await recordDelivery(alert.key, userKey, "push", success ? "sent" : "failed", lastError, meta);
  return success;
}

async function deliverPreferencePush(pref: any, alerts: RuleDrivenAlert[]) {
  if (!pref.push_enabled) return 0;
  let sent = 0;
  for (const alert of alerts) if (await sendPushToUser(String(pref.user_key), alert, { recipient_email: pref.email ?? null, source: "preference" })) sent += 1;
  return sent;
}

async function recipientPool(): Promise<Recipient[]> {
  const raw: Array<{ id: string; email: string | null; role: any; location_id: string | null }> = [];
  try {
    const users = (await db.query(`SELECT id::text,email,role,location_id::text FROM users WHERE email IS NOT NULL AND trim(email)<>''`)).rows;
    raw.push(...users);
  } catch (error: any) {
    console.warn("[VIR ALERT] users recipient source skipped", error?.message || error);
  }
  try {
    const employees = (await db.query(`SELECT id::text,email,role,location_id::text FROM employees WHERE COALESCE(active,true)=true AND email IS NOT NULL AND trim(email)<>''`)).rows;
    raw.push(...employees);
  } catch (error: any) {
    console.warn("[VIR ALERT] employees recipient source skipped", error?.message || error);
  }
  const byEmail = new Map<string, Recipient>();
  for (const row of raw) {
    const email = clean(row.email).toLowerCase();
    if (!email) continue;
    const roles = roleKeys(row.role);
    const existing = byEmail.get(email);
    if (existing) {
      existing.roles = Array.from(new Set([...existing.roles, ...roles]));
      existing.role = existing.roles.join(", ");
      if (!existing.location_id && row.location_id) existing.location_id = String(row.location_id);
      continue;
    }
    byEmail.set(email, { user_key: `email:${email}`, email, role: roles.join(", "), roles, location_id: row.location_id == null ? null : String(row.location_id) });
  }
  return [...byEmail.values()];
}

function recipientsForLevel(pool: Recipient[], alert: RuleDrivenAlert, level: number) {
  const allowed = new Set(LEVEL_ROLE_KEYS[level] || []);
  const location = clean(alert.location_id);
  return pool.filter(recipient => {
    if (!recipient.roles.some(role => allowed.has(role))) return false;
    if (level === 3) return true;
    const recipientLocation = clean(recipient.location_id);
    if (level === 1) return location ? recipientLocation === location : !recipientLocation;
    return !location || !recipientLocation || recipientLocation === location;
  });
}

async function sendEscalationEmail(recipient: Recipient, alert: RuleDrivenAlert, level: number) {
  if (!recipient.email || await deliveryAlreadyDone(alert.key, recipient.user_key, "email")) return false;
  try {
    const result: any = await sendEmail({
      to: recipient.email,
      subject: `Kleopátra VIR – L${level} eszkaláció: ${alert.title}`,
      text: `${alert.title}\n${alert.detail}\nMegnyitás: ${alert.route}`,
      html: `<div style="font-family:Arial,sans-serif;color:#241b18"><h2>${level}. szintű VIR eszkaláció</h2><p><b>${alert.title}</b></p><p>${alert.detail}</p><p>Az esemény vezetői intézkedést igényel.</p></div>`,
    });
    if (result?.sent === false) throw new Error("Az SMTP nincs konfigurálva; az e-mail csak naplózásra került.");
    await recordDelivery(alert.key, recipient.user_key, "email", "sent", null, { recipient_email: recipient.email, recipient_role: recipient.role, escalation_level: level, source: "escalation" });
    return true;
  } catch (error) {
    await recordDelivery(alert.key, recipient.user_key, "email", "failed", error, { recipient_email: recipient.email, recipient_role: recipient.role, escalation_level: level, source: "escalation" });
    return false;
  }
}

async function deliverEscalations(alerts: RuleDrivenAlert[], rules: AlertRule[]) {
  const critical = alerts.filter(a => a.severity === "critical");
  if (!critical.length) return { attempted: 0, sent: 0 };
  const pool = await recipientPool();
  let attempted = 0;
  let sent = 0;
  for (const alert of critical) {
    const rule = resolveAlertRule(rules, alert.type, alert.location_id);
    if (!rule.enabled || !rule.escalation_enabled) continue;
    const overdueHours = alert.due_at ? Math.max(0, Math.floor((Date.now() - new Date(alert.due_at).getTime()) / 3_600_000)) : 0;
    const levels = [1];
    if (overdueHours >= Number(rule.level2_after_hours || 0)) levels.push(2);
    if (overdueHours >= Number(rule.level3_after_hours || 0)) levels.push(3);
    for (const level of levels) {
      const recipients = recipientsForLevel(pool, alert, level);
      for (const recipient of recipients) {
        if (rule.email_enabled) {
          attempted += 1;
          if (await sendEscalationEmail(recipient, alert, level)) sent += 1;
        }
        if (rule.push_enabled) {
          attempted += 1;
          if (await sendPushToUser(recipient.user_key, alert, { recipient_email: recipient.email, recipient_role: recipient.role, escalation_level: level, source: "escalation" })) sent += 1;
        }
      }
    }
  }
  return { attempted, sent };
}

export async function runAlertRuleAutomation() {
  await ensureAlertRuleEngineSchema();
  const rules = await loadAlertRuleSnapshot();
  const alerts = await collectRuleDrivenAlerts(null);
  await refreshEventStore(alerts);
  const preferences = (await db.query(`SELECT * FROM vir_alert_preferences WHERE email_enabled=true OR push_enabled=true`)).rows;
  let preferenceSent = 0;
  for (const pref of preferences) {
    const selected = alerts.filter(alert => preferenceAllows(pref, alert));
    if (!selected.length) continue;
    preferenceSent += await deliverPreferenceEmail(pref, selected);
    preferenceSent += await deliverPreferencePush(pref, selected);
  }
  const escalation = await deliverEscalations(alerts, rules);
  return {
    alerts: alerts.length,
    critical: alerts.filter(a => a.severity === "critical").length,
    preference_recipients: preferences.length,
    preference_deliveries: preferenceSent,
    escalation_attempts: escalation.attempted,
    escalation_sent: escalation.sent,
  };
}

function actorKey(actor: any) {
  return clean(actor?.email || actor?.id || actor?.userId || "system");
}

async function syncLegacyGlobalSetting(rule: AlertRule) {
  const write = async (key: string, value: number, category: string) => {
    await db.query(
      `INSERT INTO system_settings(key,scope_type,scope_id,value,category,updated_by,updated_at)
       VALUES($1,'global','*',to_jsonb($2::int),$3,$4,now())
       ON CONFLICT(key,scope_type,scope_id) DO UPDATE SET value=EXCLUDED.value,category=EXCLUDED.category,updated_by=EXCLUDED.updated_by,updated_at=now()`,
      [key, value, category, rule.updated_by || null],
    );
  };
  if (rule.rule_key === "supplier_expiry") await write("supplier.shelf_life_warning_days", rule.warning_value, "supplier");
  if (rule.rule_key === "employee_document") await write("hr.document_expiry_warning_days", rule.warning_value, "hr");
  if (rule.rule_key === "complaint_sla") {
    await write("complaints.sla_warning_hours", rule.warning_value, "complaints");
    await write("complaints.sla_default_hours", Math.max(1, Number(rule.deadline_value || 120)), "complaints");
  }
}

export async function listAlertRules() {
  await ensureAlertRuleEngineSchema();
  const [rules, locations, audit] = await Promise.all([
    loadAlertRuleSnapshot(),
    db.query(`SELECT id::text,name FROM locations ORDER BY name`).then(r => r.rows).catch(() => []),
    db.query(`SELECT * FROM vir_alert_rule_audit ORDER BY created_at DESC LIMIT 50`).then(r => r.rows),
  ]);
  return {
    rules,
    locations,
    catalog: ALERT_RULE_CATALOG,
    escalation_flow: [
      { level: 1, label: "Szalonvezető", roles: LEVEL_ROLE_KEYS[1] },
      { level: 2, label: "Üzletvezető", roles: LEVEL_ROLE_KEYS[2] },
      { level: 3, label: "Admin", roles: LEVEL_ROLE_KEYS[3] },
    ],
    audit,
  };
}

export async function upsertAlertRule(ruleKeyRaw: string, body: any, actor: any) {
  await ensureAlertRuleEngineSchema();
  const ruleKey = clean(ruleKeyRaw) as AlertRuleKey;
  if (!RULE_KEYS.includes(ruleKey)) throw Object.assign(new Error("Ismeretlen értesítési szabály."), { status: 404 });
  const scopeType: RuleScopeType = body?.scope_type === "location" ? "location" : "global";
  const scopeId = scopeType === "global" ? "*" : clean(body?.scope_id);
  if (scopeType === "location" && !scopeId) throw Object.assign(new Error("A szalon kiválasztása kötelező."), { status: 400 });
  const fallback = resolveAlertRule(await loadAlertRuleSnapshot(), ruleKey, scopeType === "location" ? scopeId : null);
  const warningValue = clampInt(body?.warning_value, 0, ruleKey === "complaint_sla" ? 8760 : 3650, Number(fallback.warning_value));
  const deadlineValue = ruleKey === "complaint_sla" ? clampInt(body?.deadline_value, 1, 8760, Number(fallback.deadline_value || 120)) : null;
  const level2 = clampInt(body?.level2_after_hours, 0, 8760, Number(fallback.level2_after_hours || 0));
  const level3 = clampInt(body?.level3_after_hours, level2, 8760, Math.max(level2, Number(fallback.level3_after_hours || level2)));
  const old = (await db.query(`SELECT * FROM vir_alert_rules WHERE rule_key=$1 AND scope_type=$2 AND scope_id=$3`, [ruleKey, scopeType, scopeId])).rows[0] || null;
  const updatedBy = actorKey(actor);
  const row = (await db.query(
    `INSERT INTO vir_alert_rules(rule_key,scope_type,scope_id,enabled,warning_value,deadline_value,escalation_enabled,level2_after_hours,level3_after_hours,email_enabled,push_enabled,updated_by,updated_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())
     ON CONFLICT(rule_key,scope_type,scope_id) DO UPDATE SET enabled=EXCLUDED.enabled,warning_value=EXCLUDED.warning_value,deadline_value=EXCLUDED.deadline_value,
       escalation_enabled=EXCLUDED.escalation_enabled,level2_after_hours=EXCLUDED.level2_after_hours,level3_after_hours=EXCLUDED.level3_after_hours,
       email_enabled=EXCLUDED.email_enabled,push_enabled=EXCLUDED.push_enabled,updated_by=EXCLUDED.updated_by,updated_at=now()
     RETURNING *`,
    [ruleKey, scopeType, scopeId, asBool(body?.enabled, fallback.enabled), warningValue, deadlineValue, asBool(body?.escalation_enabled, fallback.escalation_enabled), level2, level3, asBool(body?.email_enabled, fallback.email_enabled), asBool(body?.push_enabled, fallback.push_enabled), updatedBy],
  )).rows[0] as AlertRule;
  await db.query(
    `INSERT INTO vir_alert_rule_audit(rule_key,scope_type,scope_id,action,old_data,new_data,actor) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)`,
    [ruleKey, scopeType, scopeId, old ? "update" : "create", JSON.stringify(old), JSON.stringify(row), updatedBy],
  );
  if (scopeType === "global") await syncLegacyGlobalSetting(row);
  return row;
}

export async function removeAlertRuleOverride(ruleKeyRaw: string, scopeIdRaw: string, actor: any) {
  await ensureAlertRuleEngineSchema();
  const ruleKey = clean(ruleKeyRaw) as AlertRuleKey;
  const scopeId = clean(scopeIdRaw);
  if (!RULE_KEYS.includes(ruleKey)) throw Object.assign(new Error("Ismeretlen értesítési szabály."), { status: 404 });
  if (!scopeId) throw Object.assign(new Error("A szalon azonosítója kötelező."), { status: 400 });
  const old = (await db.query(`DELETE FROM vir_alert_rules WHERE rule_key=$1 AND scope_type='location' AND scope_id=$2 RETURNING *`, [ruleKey, scopeId])).rows[0];
  if (!old) throw Object.assign(new Error("Nincs törölhető szalonspecifikus felülírás."), { status: 404 });
  await db.query(
    `INSERT INTO vir_alert_rule_audit(rule_key,scope_type,scope_id,action,old_data,new_data,actor) VALUES($1,'location',$2,'delete',$3::jsonb,NULL,$4)`,
    [ruleKey, scopeId, JSON.stringify(old), actorKey(actor)],
  );
  return { ok: true };
}

export async function listAlertDeliveryLog(locationId?: string | null, limitRaw?: unknown, statusRaw?: unknown, channelRaw?: unknown) {
  await ensureAlertRuleEngineSchema();
  const limit = clampInt(limitRaw, 1, 500, 200);
  const location = clean(locationId) || null;
  const status = clean(statusRaw) || null;
  const channel = clean(channelRaw) || null;
  const { rows } = await db.query(
    `SELECT a.id,a.delivery_id,a.event_key,a.user_key,a.recipient_email,a.recipient_role,a.escalation_level,a.source,a.channel,a.status,a.error,a.created_at,
            e.alert_type,e.severity,e.title,e.detail,e.route,e.location_id,e.due_at
       FROM vir_alert_delivery_attempts a
       LEFT JOIN vir_operational_alert_events e ON e.event_key=a.event_key
      WHERE ($1::text IS NULL OR e.location_id IS NULL OR e.location_id=$1)
        AND ($2::text IS NULL OR a.status=$2)
        AND ($3::text IS NULL OR a.channel=$3)
      ORDER BY a.created_at DESC LIMIT $4`,
    [location, status, channel, limit],
  );
  const stats = (await db.query(
    `SELECT count(*)::int total,
            count(*) FILTER(WHERE status='sent')::int sent,
            count(*) FILTER(WHERE status='failed')::int failed,
            count(*) FILTER(WHERE source='escalation')::int escalation,
            count(*) FILTER(WHERE channel='email')::int email,
            count(*) FILTER(WHERE channel='push')::int push
       FROM vir_alert_delivery_attempts
      WHERE created_at>=now()-interval '30 days'`,
  )).rows[0];
  return { items: rows, stats };
}

export async function retryAlertDelivery(deliveryIdRaw: string) {
  await ensureAlertRuleEngineSchema();
  const deliveryId = Number(deliveryIdRaw);
  if (!Number.isFinite(deliveryId)) throw Object.assign(new Error("Érvénytelen kézbesítési azonosító."), { status: 400 });
  const row = (await db.query(
    `UPDATE vir_alert_deliveries SET status='pending',attempts=0,last_error=NULL,sent_at=NULL,source='manual_retry',updated_at=now() WHERE id=$1 RETURNING *`,
    [deliveryId],
  )).rows[0];
  if (!row) throw Object.assign(new Error("A kézbesítés nem található."), { status: 404 });
  const result = await runAlertRuleAutomation();
  return { ok: true, delivery: row, automation: result };
}

export async function alertRuleSummary(locationId?: string | null) {
  const alerts = await collectRuleDrivenAlerts(locationId);
  return {
    total: alerts.length,
    critical: alerts.filter(a => a.severity === "critical").length,
    supplier_expiry: alerts.filter(a => a.type === "supplier_expiry").length,
    employee_document: alerts.filter(a => a.type === "employee_document").length,
    complaint_sla: alerts.filter(a => a.type === "complaint_sla").length,
  };
}

export function startAlertRuleScheduler() {
  if (schedulerStarted) return;
  schedulerStarted = true;
  cron.schedule("17 * * * *", async () => {
    try {
      const result = await runAlertRuleAutomation();
      console.log("[VIR ALERT RULE ENGINE] hourly run", result);
    } catch (error: any) {
      console.error("[VIR ALERT RULE ENGINE] scheduler failed", error?.message || error);
    }
  }, { timezone: "Europe/Budapest" });
  console.log("[VIR ALERT RULE ENGINE] scheduler started");
}
