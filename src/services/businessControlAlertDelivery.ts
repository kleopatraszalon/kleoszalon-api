import db from "../db";
import { sendEmail } from "../mailer";
import { getApmAdminRecipients } from "./apmAlertDelivery";

export type BusinessControlAlert = {
  key: string;
  title: string;
  detail: string;
  control_type: "finance" | "stock";
  business_date: string;
  location_key: string;
  discrepancy_count: number;
};

let schemaPromise: Promise<void> | null = null;

export function ensureBusinessControlAlertDeliverySchema() {
  if (!schemaPromise) {
    schemaPromise = db.query(`
      CREATE TABLE IF NOT EXISTS business_control_alert_deliveries(
        id bigserial PRIMARY KEY,
        alert_key text NOT NULL,
        control_type text NOT NULL,
        recipient text NOT NULL,
        status text NOT NULL CHECK(status IN ('sent','failed','logged')),
        error_text text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS business_control_alert_deliveries_key_idx
        ON business_control_alert_deliveries(alert_key,created_at DESC);
    `).then(() => undefined).catch(error => { schemaPromise = null; throw error; });
  }
  return schemaPromise;
}

async function audit(alert: BusinessControlAlert, recipient: string, status: "sent" | "failed" | "logged", error?: string | null) {
  await ensureBusinessControlAlertDeliverySchema();
  await db.query(`INSERT INTO business_control_alert_deliveries(alert_key,control_type,recipient,status,error_text)
    VALUES($1,$2,$3,$4,$5)`, [alert.key, alert.control_type, recipient, status, error ? String(error).slice(0,1500) : null]);
}

export async function deliverBusinessControlCriticalAlert(alert: BusinessControlAlert) {
  const recipients = await getApmAdminRecipients();
  if (!recipients.length) {
    await audit(alert, "unconfigured-admin-recipient", "logged", "Nincs admin e-mail cím konfigurálva.");
    return { recipients:0, sent:0, failed:0 };
  }
  const subject = `[CRITICAL] VIR üzleti kontroll – ${alert.title}`;
  const text = [
    "Kritikus VIR üzleti egyeztetési eltérés.", "",
    `Kontroll: ${alert.control_type === "finance" ? "Pénzügyi egyeztetés" : "Készletegyeztetés"}`,
    `Üzleti nap: ${alert.business_date}`,
    `Telephely: ${alert.location_key}`,
    `Eltérések: ${alert.discrepancy_count}`,
    `Részlet: ${alert.detail}`, "",
    "Nyissa meg a VIR Pénzügyi egyeztető központját, és vizsgálja ki a piros eltéréseket."
  ].join("\n");
  let sent=0,failed=0;
  for (const recipient of recipients) {
    try {
      const result:any = await sendEmail({to:recipient,subject,text});
      await audit(alert,recipient,result?.sent?"sent":"logged",result?.logged?"SMTP nem küldött; az üzenet naplózva lett.":null);
      if(result?.sent)sent++;
    } catch (error:any) {
      failed++;
      await audit(alert,recipient,"failed",error?.message||String(error));
    }
  }
  return {recipients:recipients.length,sent,failed};
}
