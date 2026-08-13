import cron from "node-cron";
import webpush from "web-push";
import db from "../db";
import { sendEmail } from "../mailer";

export type OperationalAlertType = "supplier_expiry" | "employee_document" | "complaint_sla";
export type OperationalAlertSeverity = "warning" | "critical";
export type OperationalAlert = {
  key: string;
  type: OperationalAlertType;
  severity: OperationalAlertSeverity;
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

let schemaPromise: Promise<void> | null = null;
let schedulerStarted = false;
let vapidPromise: Promise<{ publicKey: string; privateKey: string }> | null = null;

const normalizeKey = (value: unknown) => String(value ?? "").trim();
const bool = (value: unknown) => value === true || value === 1 || String(value).toLowerCase() === "true";

export function userKey(user: any) {
  if (user?.email) return `email:${String(user.email).trim().toLowerCase()}`;
  return `user:${String(user?.id ?? "unknown")}`;
}

export async function ensureOperationalAlertSchema() {
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
    await db.query(`
      CREATE EXTENSION IF NOT EXISTS pgcrypto;

      CREATE TABLE IF NOT EXISTS system_settings (
        key text NOT NULL,
        scope_type text NOT NULL DEFAULT 'global',
        scope_id text NOT NULL DEFAULT '*',
        value jsonb NOT NULL,
        category text NOT NULL,
        updated_by text,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(key,scope_type,scope_id)
      );

      INSERT INTO system_settings(key,scope_type,scope_id,value,category)
      VALUES
        ('supplier.shelf_life_warning_days','global','*','30'::jsonb,'supplier'),
        ('hr.document_expiry_warning_days','global','*','30'::jsonb,'hr'),
        ('complaints.sla_default_hours','global','*','120'::jsonb,'complaints'),
        ('complaints.sla_warning_hours','global','*','24'::jsonb,'complaints')
      ON CONFLICT(key,scope_type,scope_id) DO NOTHING;

      CREATE TABLE IF NOT EXISTS employee_documents (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        document_type text NOT NULL,
        document_name text NOT NULL,
        document_number text,
        issued_at date,
        valid_from date,
        valid_until date,
        file_url text,
        warning_days integer,
        note text,
        active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CHECK(valid_until IS NULL OR valid_from IS NULL OR valid_until >= valid_from)
      );
      CREATE INDEX IF NOT EXISTS employee_documents_expiry_idx
        ON employee_documents(active,valid_until,employee_id);

      CREATE TABLE IF NOT EXISTS supplier_expiry_batches (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        supplier_id bigint REFERENCES suppliers(id) ON DELETE SET NULL,
        product_id uuid REFERENCES products(id) ON DELETE SET NULL,
        location_id text,
        lot_number text,
        received_at date NOT NULL DEFAULT CURRENT_DATE,
        expires_at date NOT NULL,
        quantity numeric(14,3),
        note text,
        active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS supplier_expiry_batches_expiry_idx
        ON supplier_expiry_batches(active,expires_at,location_id);

      CREATE TABLE IF NOT EXISTS vir_alert_preferences (
        user_key text PRIMARY KEY,
        email text,
        location_id text,
        email_enabled boolean NOT NULL DEFAULT false,
        push_enabled boolean NOT NULL DEFAULT false,
        critical_only boolean NOT NULL DEFAULT false,
        supplier_expiry boolean NOT NULL DEFAULT true,
        employee_document boolean NOT NULL DEFAULT true,
        complaint_sla boolean NOT NULL DEFAULT true,
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS vir_staff_push_subscriptions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_key text NOT NULL,
        location_id text,
        endpoint text NOT NULL UNIQUE,
        subscription jsonb NOT NULL,
        active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        last_success_at timestamptz,
        last_error text
      );
      CREATE INDEX IF NOT EXISTS vir_staff_push_user_idx
        ON vir_staff_push_subscriptions(user_key,active);

      CREATE TABLE IF NOT EXISTS vir_operational_alert_events (
        event_key text PRIMARY KEY,
        alert_type text NOT NULL,
        severity text NOT NULL,
        title text NOT NULL,
        detail text NOT NULL,
        route text,
        entity_type text NOT NULL,
        entity_id text NOT NULL,
        location_id text,
        due_at timestamptz,
        payload jsonb NOT NULL DEFAULT '{}'::jsonb,
        first_seen_at timestamptz NOT NULL DEFAULT now(),
        last_seen_at timestamptz NOT NULL DEFAULT now(),
        resolved_at timestamptz
      );
      CREATE INDEX IF NOT EXISTS vir_operational_alert_events_active_idx
        ON vir_operational_alert_events(resolved_at,alert_type,severity,last_seen_at DESC);

      CREATE TABLE IF NOT EXISTS vir_alert_deliveries (
        id bigserial PRIMARY KEY,
        event_key text NOT NULL,
        user_key text NOT NULL,
        channel text NOT NULL,
        status text NOT NULL DEFAULT 'pending',
        attempts integer NOT NULL DEFAULT 0,
        last_error text,
        sent_at timestamptz,
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(event_key,user_key,channel)
      );

      CREATE TABLE IF NOT EXISTS app_runtime_secrets (
        secret_key text PRIMARY KEY,
        secret_value text NOT NULL,
        created_at timestamptz DEFAULT now(),
        updated_at timestamptz DEFAULT now()
      );

      DO $$ BEGIN
        IF to_regclass('public.operations_quality_records') IS NOT NULL THEN
          ALTER TABLE operations_quality_records ADD COLUMN IF NOT EXISTS location_id text;
        END IF;
      END $$;
    `);
  })().catch((error) => {
    schemaPromise = null;
    throw error;
  });
  return schemaPromise;
}

async function settingNumber(key: string, fallback: number) {
  await ensureOperationalAlertSchema();
  try {
    const row = (await db.query(
      `SELECT value FROM system_settings WHERE key=$1 AND scope_type='global' AND scope_id='*' LIMIT 1`,
      [key],
    )).rows[0];
    const n = Number(row?.value ?? fallback);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

async function tableExists(table: string) {
  const row = (await db.query(`SELECT to_regclass($1) IS NOT NULL ok`, [`public.${table}`])).rows[0];
  return Boolean(row?.ok);
}

async function getVapidConfig() {
  const envPublic = normalizeKey(process.env.VAPID_PUBLIC_KEY);
  const envPrivate = normalizeKey(process.env.VAPID_PRIVATE_KEY);
  if (envPublic && envPrivate) return { publicKey: envPublic, privateKey: envPrivate };
  if (!vapidPromise) {
    vapidPromise = (async () => {
      await ensureOperationalAlertSchema();
      const existing = await db.query(
        `SELECT secret_key,secret_value FROM app_runtime_secrets WHERE secret_key IN('vapid_public_key','vapid_private_key')`,
      );
      const values = Object.fromEntries(existing.rows.map((x: any) => [x.secret_key, x.secret_value]));
      if (values.vapid_public_key && values.vapid_private_key) {
        return { publicKey: values.vapid_public_key, privateKey: values.vapid_private_key };
      }
      const generated = webpush.generateVAPIDKeys();
      await db.query(
        `INSERT INTO app_runtime_secrets(secret_key,secret_value) VALUES('vapid_public_key',$1),('vapid_private_key',$2)
         ON CONFLICT(secret_key) DO NOTHING`,
        [generated.publicKey, generated.privateKey],
      );
      const saved = await db.query(
        `SELECT secret_key,secret_value FROM app_runtime_secrets WHERE secret_key IN('vapid_public_key','vapid_private_key')`,
      );
      const final = Object.fromEntries(saved.rows.map((x: any) => [x.secret_key, x.secret_value]));
      return { publicKey: final.vapid_public_key, privateKey: final.vapid_private_key };
    })().catch((error) => {
      vapidPromise = null;
      throw error;
    });
  }
  return vapidPromise;
}

function daysUntil(value: unknown) {
  const ms = new Date(String(value)).getTime() - Date.now();
  return Math.ceil(ms / 86_400_000);
}

function hoursUntil(value: unknown) {
  const ms = new Date(String(value)).getTime() - Date.now();
  return Math.ceil(ms / 3_600_000);
}

export async function collectOperationalAlerts(locationId?: string | null): Promise<OperationalAlert[]> {
  await ensureOperationalAlertSchema();
  const now = new Date().toISOString();
  const location = normalizeKey(locationId) || null;
  const alerts: OperationalAlert[] = [];

  const supplierWarningDays = Math.max(0, Math.round(await settingNumber("supplier.shelf_life_warning_days", 30)));
  if (await tableExists("supplier_expiry_batches")) {
    const { rows } = await db.query(
      `SELECT b.id::text,b.location_id,b.lot_number,b.expires_at,b.quantity,
              COALESCE(s.name,'Ismeretlen beszállító') supplier_name,
              COALESCE(p.name,'Ismeretlen termék') product_name
       FROM supplier_expiry_batches b
       LEFT JOIN suppliers s ON s.id=b.supplier_id
       LEFT JOIN products p ON p.id=b.product_id
       WHERE b.active=true
         AND b.expires_at <= CURRENT_DATE + $1::int
         AND ($2::text IS NULL OR b.location_id IS NULL OR b.location_id=$2::text)
       ORDER BY b.expires_at,b.id LIMIT 200`,
      [supplierWarningDays, location],
    );
    for (const row of rows) {
      const days = daysUntil(row.expires_at);
      const severity: OperationalAlertSeverity = days < 0 ? "critical" : "warning";
      const timeText = days < 0 ? `${Math.abs(days)} napja lejárt` : days === 0 ? "ma lejár" : `${days} napon belül lejár`;
      alerts.push({
        key: `supplier-expiry:${row.id}:${severity}`,
        type: "supplier_expiry",
        severity,
        title: `${row.product_name} – ${timeText}`,
        detail: `${row.supplier_name}${row.lot_number ? ` · tétel: ${row.lot_number}` : ""}${row.quantity != null ? ` · készlet: ${Number(row.quantity).toLocaleString("hu-HU")}` : ""}`,
        route: "/warehouse?view=procurement&section=suppliers",
        created_at: now,
        due_at: new Date(`${row.expires_at}T12:00:00Z`).toISOString(),
        location_id: row.location_id ?? null,
        entity_type: "supplier_expiry_batch",
        entity_id: row.id,
        payload: { expires_at: row.expires_at, supplier_name: row.supplier_name, product_name: row.product_name, lot_number: row.lot_number },
      });
    }
  }

  const documentWarningDays = Math.max(0, Math.round(await settingNumber("hr.document_expiry_warning_days", 30)));
  if (await tableExists("employee_documents")) {
    const { rows } = await db.query(
      `SELECT d.id::text,d.document_type,d.document_name,d.document_number,d.valid_until,d.warning_days,
              e.id::text employee_id,e.full_name,e.location_id::text
       FROM employee_documents d JOIN employees e ON e.id=d.employee_id
       WHERE d.active=true AND COALESCE(e.active,true)=true AND d.valid_until IS NOT NULL
         AND d.valid_until <= CURRENT_DATE + COALESCE(d.warning_days,$1)::int
         AND ($2::text IS NULL OR e.location_id::text=$2::text)
       ORDER BY d.valid_until,e.full_name LIMIT 200`,
      [documentWarningDays, location],
    );
    for (const row of rows) {
      const days = daysUntil(row.valid_until);
      const severity: OperationalAlertSeverity = days < 0 ? "critical" : "warning";
      const timeText = days < 0 ? `${Math.abs(days)} napja lejárt` : days === 0 ? "ma lejár" : `${days} napon belül lejár`;
      alerts.push({
        key: `employee-document:${row.id}:${severity}`,
        type: "employee_document",
        severity,
        title: `${row.full_name}: ${row.document_name} ${timeText}`,
        detail: `${row.document_type}${row.document_number ? ` · ${row.document_number}` : ""}`,
        route: "/employees",
        created_at: now,
        due_at: new Date(`${row.valid_until}T12:00:00Z`).toISOString(),
        location_id: row.location_id ?? null,
        entity_type: "employee_document",
        entity_id: row.id,
        payload: { employee_id: row.employee_id, valid_until: row.valid_until, document_type: row.document_type },
      });
    }
  }

  if (await tableExists("employment_contracts")) {
    const { rows } = await db.query(
      `SELECT c.id::text,c.contract_number,c.end_date,e.id::text employee_id,e.full_name,e.location_id::text
       FROM employment_contracts c JOIN employees e ON e.id=c.employee_id
       WHERE c.is_active=true AND COALESCE(e.active,true)=true AND c.end_date IS NOT NULL
         AND c.end_date <= CURRENT_DATE + $1::int
         AND ($2::text IS NULL OR e.location_id::text=$2::text)
       ORDER BY c.end_date,e.full_name LIMIT 100`,
      [documentWarningDays, location],
    );
    for (const row of rows) {
      const days = daysUntil(row.end_date);
      const severity: OperationalAlertSeverity = days < 0 ? "critical" : "warning";
      const timeText = days < 0 ? `${Math.abs(days)} napja lejárt` : days === 0 ? "ma lejár" : `${days} napon belül lejár`;
      alerts.push({
        key: `employee-contract:${row.id}:${severity}`,
        type: "employee_document",
        severity,
        title: `${row.full_name}: munkaszerződés ${timeText}`,
        detail: row.contract_number ? `Szerződésszám: ${row.contract_number}` : "Határozott idejű szerződés lejárata közeleg.",
        route: "/employees",
        created_at: now,
        due_at: new Date(`${row.end_date}T12:00:00Z`).toISOString(),
        location_id: row.location_id ?? null,
        entity_type: "employment_contract",
        entity_id: row.id,
        payload: { employee_id: row.employee_id, end_date: row.end_date },
      });
    }
  }

  const slaDefaultHours = Math.max(1, Math.round(await settingNumber("complaints.sla_default_hours", 120)));
  const slaWarningHours = Math.max(0, Math.round(await settingNumber("complaints.sla_warning_hours", 24)));
  if (await tableExists("operations_quality_records")) {
    const { rows } = await db.query(
      `SELECT id::text,title,status,assignee,department,location_id,created_at,
              COALESCE(due_at,created_at + ($1::int * interval '1 hour')) deadline,
              metadata
       FROM operations_quality_records
       WHERE module_key='complaints'
         AND status NOT IN ('resolved','rejected','closed','archived')
         AND COALESCE(due_at,created_at + ($1::int * interval '1 hour')) <= now() + ($2::int * interval '1 hour')
         AND ($3::text IS NULL OR location_id IS NULL OR location_id=$3::text)
       ORDER BY COALESCE(due_at,created_at + ($1::int * interval '1 hour')) ASC LIMIT 200`,
      [slaDefaultHours, slaWarningHours, location],
    );
    for (const row of rows) {
      const hours = hoursUntil(row.deadline);
      const severity: OperationalAlertSeverity = hours < 0 ? "critical" : "warning";
      const timeText = hours < 0 ? `${Math.abs(hours)} órája SLA-n túl` : hours === 0 ? "SLA-határidő most" : `${hours} órán belül SLA-határidő`;
      alerts.push({
        key: `complaint-sla:${row.id}:${severity}`,
        type: "complaint_sla",
        severity,
        title: `${row.title} – ${timeText}`,
        detail: `${row.department || "Panaszkezelés"}${row.assignee ? ` · felelős: ${row.assignee}` : " · nincs felelős"}`,
        route: "/marketing/complaints",
        created_at: now,
        due_at: new Date(row.deadline).toISOString(),
        location_id: row.location_id ?? null,
        entity_type: "complaint",
        entity_id: row.id,
        payload: { status: row.status, metadata: row.metadata ?? {} },
      });
    }
  }

  return alerts.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "critical" ? -1 : 1;
    return +(new Date(a.due_at || a.created_at)) - +(new Date(b.due_at || b.created_at));
  });
}

async function refreshAlertEventStore(alerts: OperationalAlert[]) {
  await ensureOperationalAlertSchema();
  const keys = alerts.map((a) => a.key);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    for (const alert of alerts) {
      await client.query(
        `INSERT INTO vir_operational_alert_events(event_key,alert_type,severity,title,detail,route,entity_type,entity_id,location_id,due_at,payload,last_seen_at,resolved_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,now(),NULL)
         ON CONFLICT(event_key) DO UPDATE SET alert_type=EXCLUDED.alert_type,severity=EXCLUDED.severity,title=EXCLUDED.title,
           detail=EXCLUDED.detail,route=EXCLUDED.route,location_id=EXCLUDED.location_id,due_at=EXCLUDED.due_at,payload=EXCLUDED.payload,
           last_seen_at=now(),resolved_at=NULL`,
        [alert.key, alert.type, alert.severity, alert.title, alert.detail, alert.route, alert.entity_type, alert.entity_id,
          alert.location_id ?? null, alert.due_at ?? null, JSON.stringify(alert.payload ?? {})],
      );
    }
    if (keys.length) {
      await client.query(
        `UPDATE vir_operational_alert_events SET resolved_at=now()
         WHERE resolved_at IS NULL AND alert_type IN('supplier_expiry','employee_document','complaint_sla')
           AND NOT(event_key=ANY($1::text[]))`,
        [keys],
      );
    } else {
      await client.query(
        `UPDATE vir_operational_alert_events SET resolved_at=now()
         WHERE resolved_at IS NULL AND alert_type IN('supplier_expiry','employee_document','complaint_sla')`,
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getAlertPreferences(user: any) {
  await ensureOperationalAlertSchema();
  const key = userKey(user);
  const email = normalizeKey(user?.email) || null;
  const locationId = user?.location_id == null ? null : String(user.location_id);
  await db.query(
    `INSERT INTO vir_alert_preferences(user_key,email,location_id)
     VALUES($1,$2,$3) ON CONFLICT(user_key) DO UPDATE SET email=COALESCE(EXCLUDED.email,vir_alert_preferences.email),location_id=COALESCE(EXCLUDED.location_id,vir_alert_preferences.location_id)`,
    [key, email, locationId],
  );
  const row = (await db.query(`SELECT * FROM vir_alert_preferences WHERE user_key=$1`, [key])).rows[0];
  const vapid = await getVapidConfig();
  const pushCount = Number((await db.query(`SELECT count(*)::int count FROM vir_staff_push_subscriptions WHERE user_key=$1 AND active=true`, [key])).rows[0]?.count || 0);
  return { ...row, push_subscription_count: pushCount, vapid_public_key: vapid.publicKey };
}

export async function updateAlertPreferences(user: any, body: any) {
  await ensureOperationalAlertSchema();
  const current = await getAlertPreferences(user);
  const key = userKey(user);
  const values = {
    email_enabled: body?.email_enabled === undefined ? current.email_enabled : bool(body.email_enabled),
    push_enabled: body?.push_enabled === undefined ? current.push_enabled : bool(body.push_enabled),
    critical_only: body?.critical_only === undefined ? current.critical_only : bool(body.critical_only),
    supplier_expiry: body?.supplier_expiry === undefined ? current.supplier_expiry : bool(body.supplier_expiry),
    employee_document: body?.employee_document === undefined ? current.employee_document : bool(body.employee_document),
    complaint_sla: body?.complaint_sla === undefined ? current.complaint_sla : bool(body.complaint_sla),
  };
  const row = (await db.query(
    `UPDATE vir_alert_preferences SET email_enabled=$2,push_enabled=$3,critical_only=$4,supplier_expiry=$5,employee_document=$6,complaint_sla=$7,updated_at=now()
     WHERE user_key=$1 RETURNING *`,
    [key, values.email_enabled, values.push_enabled, values.critical_only, values.supplier_expiry, values.employee_document, values.complaint_sla],
  )).rows[0];
  return row;
}

export async function subscribeStaffPush(user: any, subscription: any) {
  await ensureOperationalAlertSchema();
  const endpoint = normalizeKey(subscription?.endpoint);
  if (!endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    throw Object.assign(new Error("Érvénytelen push feliratkozás."), { status: 400 });
  }
  const key = userKey(user);
  const locationId = user?.location_id == null ? null : String(user.location_id);
  await db.query(
    `INSERT INTO vir_staff_push_subscriptions(user_key,location_id,endpoint,subscription,active,updated_at)
     VALUES($1,$2,$3,$4::jsonb,true,now())
     ON CONFLICT(endpoint) DO UPDATE SET user_key=EXCLUDED.user_key,location_id=EXCLUDED.location_id,subscription=EXCLUDED.subscription,active=true,updated_at=now(),last_error=NULL`,
    [key, locationId, endpoint, JSON.stringify(subscription)],
  );
  await db.query(`UPDATE vir_alert_preferences SET push_enabled=true,updated_at=now() WHERE user_key=$1`, [key]);
  return getAlertPreferences(user);
}

export async function unsubscribeStaffPush(user: any, endpoint?: string) {
  await ensureOperationalAlertSchema();
  const key = userKey(user);
  if (normalizeKey(endpoint)) {
    await db.query(`UPDATE vir_staff_push_subscriptions SET active=false,updated_at=now() WHERE user_key=$1 AND endpoint=$2`, [key, normalizeKey(endpoint)]);
  } else {
    await db.query(`UPDATE vir_staff_push_subscriptions SET active=false,updated_at=now() WHERE user_key=$1`, [key]);
  }
  const count = Number((await db.query(`SELECT count(*)::int count FROM vir_staff_push_subscriptions WHERE user_key=$1 AND active=true`, [key])).rows[0]?.count || 0);
  if (!count) await db.query(`UPDATE vir_alert_preferences SET push_enabled=false,updated_at=now() WHERE user_key=$1`, [key]);
  return getAlertPreferences(user);
}

function alertEnabled(pref: any, alert: OperationalAlert) {
  if (pref.critical_only && alert.severity !== "critical") return false;
  if (pref.location_id && alert.location_id && String(pref.location_id) !== String(alert.location_id)) return false;
  if (alert.type === "supplier_expiry" && !pref.supplier_expiry) return false;
  if (alert.type === "employee_document" && !pref.employee_document) return false;
  if (alert.type === "complaint_sla" && !pref.complaint_sla) return false;
  return true;
}

async function alreadySent(eventKey: string, key: string, channel: string) {
  const row = (await db.query(
    `SELECT status,attempts FROM vir_alert_deliveries WHERE event_key=$1 AND user_key=$2 AND channel=$3`,
    [eventKey, key, channel],
  )).rows[0];
  return row?.status === "sent" || Number(row?.attempts || 0) >= 5;
}

async function recordDelivery(eventKey: string, key: string, channel: string, status: "sent" | "failed", error?: unknown) {
  await db.query(
    `INSERT INTO vir_alert_deliveries(event_key,user_key,channel,status,attempts,last_error,sent_at,updated_at)
     VALUES($1,$2,$3,$4,1,$5,CASE WHEN $4='sent' THEN now() ELSE NULL END,now())
     ON CONFLICT(event_key,user_key,channel) DO UPDATE SET status=EXCLUDED.status,attempts=vir_alert_deliveries.attempts+1,
       last_error=EXCLUDED.last_error,sent_at=CASE WHEN EXCLUDED.status='sent' THEN now() ELSE vir_alert_deliveries.sent_at END,updated_at=now()`,
    [eventKey, key, channel, status, status === "failed" ? String((error as any)?.message || error || "unknown") : null],
  );
}

async function deliverEmail(pref: any, alerts: OperationalAlert[]) {
  const key = pref.user_key;
  const email = normalizeKey(pref.email);
  if (!pref.email_enabled || !email) return;
  const pending: OperationalAlert[] = [];
  for (const alert of alerts) if (!(await alreadySent(alert.key, key, "email"))) pending.push(alert);
  if (!pending.length) return;
  const critical = pending.filter((a) => a.severity === "critical").length;
  const rows = pending.map((a) => `<tr><td style="padding:8px;border-bottom:1px solid #eee"><b>${a.severity === "critical" ? "KRITIKUS" : "FIGYELMEZTETÉS"}</b></td><td style="padding:8px;border-bottom:1px solid #eee"><b>${a.title}</b><br><span>${a.detail}</span></td></tr>`).join("");
  try {
    await sendEmail({
      to: email,
      subject: `Kleopátra VIR – ${pending.length} operatív figyelmeztetés${critical ? `, ${critical} kritikus` : ""}`,
      text: pending.map((a) => `${a.severity.toUpperCase()}: ${a.title} – ${a.detail}`).join("\n"),
      html: `<div style="font-family:Arial,sans-serif;color:#241b18"><h2>Kleopátra VIR értesítési összefoglaló</h2><p>${pending.length} új figyelmeztetés vár intézkedésre.</p><table style="border-collapse:collapse;width:100%">${rows}</table></div>`,
    });
    for (const alert of pending) await recordDelivery(alert.key, key, "email", "sent");
  } catch (error) {
    for (const alert of pending) await recordDelivery(alert.key, key, "email", "failed", error);
  }
}

async function deliverPush(pref: any, alerts: OperationalAlert[]) {
  if (!pref.push_enabled) return;
  const key = pref.user_key;
  const subscriptions = (await db.query(`SELECT id,subscription FROM vir_staff_push_subscriptions WHERE user_key=$1 AND active=true`, [key])).rows;
  if (!subscriptions.length) return;
  const vapid = await getVapidConfig();
  const subject = normalizeKey(process.env.VAPID_SUBJECT) || `mailto:${normalizeKey(process.env.SMTP_USER) || "admin@kleoszalon.hu"}`;
  webpush.setVapidDetails(subject, vapid.publicKey, vapid.privateKey);
  for (const alert of alerts) {
    if (await alreadySent(alert.key, key, "push")) continue;
    let success = false;
    let lastError: unknown = null;
    for (const sub of subscriptions) {
      try {
        await webpush.sendNotification(sub.subscription, JSON.stringify({
          title: alert.severity === "critical" ? `Kritikus VIR figyelmeztetés` : `Kleopátra VIR figyelmeztetés`,
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
        await db.query(`UPDATE vir_staff_push_subscriptions SET active=CASE WHEN $2 THEN false ELSE active END,last_error=$3,updated_at=now() WHERE id=$1`, [sub.id, gone, String(error?.message || error)]);
      }
    }
    await recordDelivery(alert.key, key, "push", success ? "sent" : "failed", lastError);
  }
}

export async function runOperationalAlertAutomation() {
  await ensureOperationalAlertSchema();
  const alerts = await collectOperationalAlerts(null);
  await refreshAlertEventStore(alerts);
  const preferences = (await db.query(`SELECT * FROM vir_alert_preferences WHERE email_enabled=true OR push_enabled=true`)).rows;
  for (const pref of preferences) {
    const selected = alerts.filter((alert) => alertEnabled(pref, alert));
    if (!selected.length) continue;
    await deliverEmail(pref, selected);
    await deliverPush(pref, selected);
  }
  return { alerts: alerts.length, recipients: preferences.length, critical: alerts.filter((a) => a.severity === "critical").length };
}

export async function listEmployeeDocuments(employeeId?: string | null) {
  await ensureOperationalAlertSchema();
  const { rows } = await db.query(
    `SELECT d.*,e.full_name,e.location_id::text FROM employee_documents d JOIN employees e ON e.id=d.employee_id
     WHERE ($1::text IS NULL OR d.employee_id::text=$1::text) ORDER BY d.active DESC,d.valid_until NULLS LAST,e.full_name,d.document_name`,
    [normalizeKey(employeeId) || null],
  );
  return rows;
}

export async function createEmployeeDocument(body: any) {
  await ensureOperationalAlertSchema();
  if (!body?.employee_id || !normalizeKey(body?.document_name)) throw Object.assign(new Error("A munkatárs és a dokumentum neve kötelező."), { status: 400 });
  return (await db.query(
    `INSERT INTO employee_documents(employee_id,document_type,document_name,document_number,issued_at,valid_from,valid_until,file_url,warning_days,note,active)
     VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE($11,true)) RETURNING *`,
    [body.employee_id, normalizeKey(body.document_type) || "Egyéb", normalizeKey(body.document_name), normalizeKey(body.document_number) || null,
      body.issued_at || null, body.valid_from || null, body.valid_until || null, normalizeKey(body.file_url) || null,
      body.warning_days == null || body.warning_days === "" ? null : Math.max(0, Number(body.warning_days)), normalizeKey(body.note) || null, body.active],
  )).rows[0];
}

export async function updateEmployeeDocument(id: string, body: any) {
  await ensureOperationalAlertSchema();
  const row = (await db.query(
    `UPDATE employee_documents SET document_type=COALESCE($2,document_type),document_name=COALESCE($3,document_name),document_number=$4,
      issued_at=$5,valid_from=$6,valid_until=$7,file_url=$8,warning_days=$9,note=$10,active=COALESCE($11,active),updated_at=now()
     WHERE id=$1::uuid RETURNING *`,
    [id, normalizeKey(body.document_type) || null, normalizeKey(body.document_name) || null, normalizeKey(body.document_number) || null,
      body.issued_at || null, body.valid_from || null, body.valid_until || null, normalizeKey(body.file_url) || null,
      body.warning_days == null || body.warning_days === "" ? null : Math.max(0, Number(body.warning_days)), normalizeKey(body.note) || null, body.active],
  )).rows[0];
  if (!row) throw Object.assign(new Error("A dokumentum nem található."), { status: 404 });
  return row;
}

export async function listSupplierExpiryBatches(locationId?: string | null) {
  await ensureOperationalAlertSchema();
  const { rows } = await db.query(
    `SELECT b.*,s.name supplier_name,p.name product_name,p.internal_code,l.name location_name
     FROM supplier_expiry_batches b
     LEFT JOIN suppliers s ON s.id=b.supplier_id
     LEFT JOIN products p ON p.id=b.product_id
     LEFT JOIN locations l ON l.id::text=b.location_id
     WHERE ($1::text IS NULL OR b.location_id IS NULL OR b.location_id=$1::text)
     ORDER BY b.active DESC,b.expires_at,b.created_at DESC`,
    [normalizeKey(locationId) || null],
  );
  return rows;
}

async function deriveExpiryDate(body: any) {
  if (body?.expires_at) return body.expires_at;
  if (!body?.supplier_id) throw Object.assign(new Error("A lejárati dátum vagy a beszállító kötelező."), { status: 400 });
  const supplier = (await db.query(`SELECT shelf_life_value,shelf_life_unit FROM suppliers WHERE id=$1`, [body.supplier_id])).rows[0];
  const value = Number(supplier?.shelf_life_value || 0);
  const unit = normalizeKey(supplier?.shelf_life_unit);
  if (!value || !unit) throw Object.assign(new Error("A beszállítóhoz nincs alapértelmezett szavatossági idő beállítva; adja meg a lejárati dátumot."), { status: 400 });
  const received = new Date(`${body?.received_at || new Date().toISOString().slice(0, 10)}T12:00:00Z`);
  const days = unit === "day" ? value : unit === "week" ? value * 7 : unit === "month" ? value * 30 : unit === "year" ? value * 365 : 0;
  if (!days) throw Object.assign(new Error("A beszállító szavatossági időegysége nem értelmezhető."), { status: 400 });
  received.setUTCDate(received.getUTCDate() + Math.round(days));
  return received.toISOString().slice(0, 10);
}

export async function createSupplierExpiryBatch(body: any) {
  await ensureOperationalAlertSchema();
  if (!body?.product_id) throw Object.assign(new Error("A termék kötelező."), { status: 400 });
  const expiresAt = await deriveExpiryDate(body);
  return (await db.query(
    `INSERT INTO supplier_expiry_batches(supplier_id,product_id,location_id,lot_number,received_at,expires_at,quantity,note,active)
     VALUES($1,$2::uuid,$3,$4,COALESCE($5,CURRENT_DATE),$6,$7,$8,COALESCE($9,true)) RETURNING *`,
    [body.supplier_id || null, body.product_id, normalizeKey(body.location_id) || null, normalizeKey(body.lot_number) || null,
      body.received_at || null, expiresAt, body.quantity == null || body.quantity === "" ? null : Number(body.quantity), normalizeKey(body.note) || null, body.active],
  )).rows[0];
}

export async function updateSupplierExpiryBatch(id: string, body: any) {
  await ensureOperationalAlertSchema();
  const current = (await db.query(`SELECT * FROM supplier_expiry_batches WHERE id=$1::uuid`, [id])).rows[0];
  if (!current) throw Object.assign(new Error("A lejárati tétel nem található."), { status: 404 });
  const merged = { ...current, ...body };
  const expiresAt = await deriveExpiryDate(merged);
  return (await db.query(
    `UPDATE supplier_expiry_batches SET supplier_id=$2,product_id=$3::uuid,location_id=$4,lot_number=$5,received_at=$6,expires_at=$7,quantity=$8,note=$9,active=$10,updated_at=now()
     WHERE id=$1::uuid RETURNING *`,
    [id, merged.supplier_id || null, merged.product_id, normalizeKey(merged.location_id) || null, normalizeKey(merged.lot_number) || null,
      merged.received_at, expiresAt, merged.quantity == null || merged.quantity === "" ? null : Number(merged.quantity), normalizeKey(merged.note) || null, merged.active !== false],
  )).rows[0];
}

export async function operationalAlertSummary(locationId?: string | null) {
  const alerts = await collectOperationalAlerts(locationId);
  return {
    total: alerts.length,
    critical: alerts.filter((a) => a.severity === "critical").length,
    supplier_expiry: alerts.filter((a) => a.type === "supplier_expiry").length,
    employee_document: alerts.filter((a) => a.type === "employee_document").length,
    complaint_sla: alerts.filter((a) => a.type === "complaint_sla").length,
  };
}

export function startOperationalAlertScheduler() {
  if (schedulerStarted) return;
  schedulerStarted = true;
  cron.schedule("17 * * * *", async () => {
    try {
      const result = await runOperationalAlertAutomation();
      console.log("[VIR ALERT AUTOMATION] hourly run", result);
    } catch (error: any) {
      console.error("[VIR ALERT AUTOMATION] scheduler failed", error?.message || error);
    }
  }, { timezone: "Europe/Budapest" });
  console.log("[VIR ALERT AUTOMATION] scheduler started");
}
