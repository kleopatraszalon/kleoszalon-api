import cron from "node-cron";
import pool from "../db";
import { sendVirReportEmail } from "../services/virReportMailer";

function nowPartsInTimeZone(timezone: string) {
  const d = new Date();
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d);
  const weekdayText = parts.find((p) => p.type === "weekday")?.value || "Mon";
  const hour = Number(parts.find((p) => p.type === "hour")?.value || 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value || 0);
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { weekday: weekdayMap[weekdayText] ?? 1, hour, minute };
}

async function processSubscriptions() {
  const { rows } = await pool.query(
    `SELECT id, email, frequency, location_id, weekday, send_hour, send_minute, timezone, recipient_name
     FROM vir_report_subscriptions
     WHERE is_enabled = TRUE`
  );
  for (const row of rows) {
    const tz = row.timezone || "Europe/Budapest";
    const now = nowPartsInTimeZone(tz);
    if (Number(row.send_hour) !== now.hour || Number(row.send_minute) !== now.minute) continue;
    if (row.frequency === "weekly" && Number(row.weekday ?? 1) !== now.weekday) continue;
    try {
      await sendVirReportEmail({
        email: row.email,
        frequency: row.frequency,
        locationId: row.location_id,
        recipientName: row.recipient_name,
      });
      console.log("[VIR REPORT] sent", row.email, row.frequency);
    } catch (error: any) {
      console.error("[VIR REPORT] send failed", row.email, error?.message || error);
    }
  }
}

export function startVirReportScheduler() {
  cron.schedule("* * * * *", async () => {
    try { await processSubscriptions(); }
    catch (error: any) { console.error("[VIR REPORT] scheduler failed", error?.message || error); }
  });
  console.log("[VIR REPORT] scheduler started");
}
