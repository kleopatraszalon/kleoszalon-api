import db from "../db";
import { sendEmail } from "../mailer";

export type ApmCriticalAlert = {
  key: string;
  title: string;
  detail: string;
  value: string;
  threshold: string;
  detected_at: string;
};

let deliverySchemaPromise: Promise<void> | null = null;

export function ensureApmDeliverySchema() {
  if (!deliverySchemaPromise) {
    deliverySchemaPromise = db.query(`
      CREATE TABLE IF NOT EXISTS apm_alert_deliveries(
        id bigserial PRIMARY KEY,
        alert_key text NOT NULL,
        recipient text NOT NULL,
        channel text NOT NULL DEFAULT 'email',
        status text NOT NULL CHECK(status IN ('sent','failed','logged')),
        error_text text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_apm_alert_deliveries_key_time
        ON apm_alert_deliveries(alert_key,created_at DESC);
    `).then(() => undefined).catch(error => {
      deliverySchemaPromise = null;
      throw error;
    });
  }
  return deliverySchemaPromise;
}

function configuredRecipients() {
  return String(process.env.APM_ADMIN_EMAILS || "")
    .split(",")
    .map(x => x.trim().toLowerCase())
    .filter(Boolean);
}

async function databaseAdminRecipients() {
  try {
    const { rows } = await db.query(`
      SELECT DISTINCT lower(trim(email)) email
        FROM users
       WHERE NULLIF(trim(COALESCE(email,'')),'') IS NOT NULL
         AND COALESCE(role::text,'') ~* '(super[_-]?admin|administrator|rendszergazda|admin)'
       ORDER BY 1
       LIMIT 50
    `);
    return rows.map((row: any) => String(row.email || "").trim().toLowerCase()).filter(Boolean);
  } catch {
    return [];
  }
}

export async function getApmAdminRecipients() {
  return [...new Set([...configuredRecipients(), ...(await databaseAdminRecipients())])];
}

async function writeDelivery(alertKey: string, recipient: string, status: "sent" | "failed" | "logged", errorText?: string | null) {
  await ensureApmDeliverySchema();
  await db.query(`
    INSERT INTO apm_alert_deliveries(alert_key,recipient,channel,status,error_text)
    VALUES($1,$2,'email',$3,$4)
  `, [alertKey, recipient, status, errorText ? String(errorText).slice(0, 1500) : null]);
}

export async function deliverApmCriticalAlert(alert: ApmCriticalAlert) {
  await ensureApmDeliverySchema();
  const recipients = await getApmAdminRecipients();
  if (!recipients.length) {
    console.warn("[APM] CRITICAL alert detected, but no admin e-mail recipient is configured", { key: alert.key });
    await writeDelivery(alert.key, "unconfigured-admin-recipient", "logged", "Nincs APM_ADMIN_EMAILS és nem található admin e-mail a users táblában.");
    return { recipients: 0, sent: 0, failed: 0, configured: false };
  }

  const subject = `[CRITICAL] VIR APM – ${alert.title}`;
  const text = [
    "Kritikus VIR üzemeltetési riasztás.",
    "",
    `Metrika: ${alert.title}`,
    `Kulcs: ${alert.key}`,
    `Érték: ${alert.value}`,
    `Kritikus küszöb: ${alert.threshold}`,
    `Részlet: ${alert.detail}`,
    `Észlelve: ${alert.detected_at}`,
    "",
    "Ellenőrizze a VIR Observability / APM központot és az érintett üzleti folyamatot.",
  ].join("\n");

  let sent = 0;
  let failed = 0;
  for (const recipient of recipients) {
    try {
      const result: any = await sendEmail({ to: recipient, subject, text });
      const status: "sent" | "logged" = result?.sent ? "sent" : "logged";
      await writeDelivery(alert.key, recipient, status, result?.logged ? "SMTP nem küldött; a mailer logolta az üzenetet." : null);
      if (result?.sent) sent += 1;
    } catch (error: any) {
      failed += 1;
      await writeDelivery(alert.key, recipient, "failed", error?.message || String(error));
    }
  }
  return { recipients: recipients.length, sent, failed, configured: true };
}
