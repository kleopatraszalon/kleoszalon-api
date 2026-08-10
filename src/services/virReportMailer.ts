import nodemailer from "nodemailer";
import pool from "../db";
import { generateVirReportPdf } from "./virReportPdf";

type SendOptions = {
  email: string;
  frequency: "daily" | "weekly";
  locationId?: string | null;
  recipientName?: string | null;
};

function getPeriod(frequency: "daily" | "weekly") {
  const now = new Date();
  const to = now.toISOString().slice(0, 10);
  if (frequency === "daily") return { from: to, to, label: to };
  const fromDate = new Date(now);
  fromDate.setDate(fromDate.getDate() - 6);
  const from = fromDate.toISOString().slice(0, 10);
  return { from, to, label: `${from} – ${to}` };
}

async function getLocationLabel(locationId?: string | null) {
  if (!locationId) return "Minden helyszín";
  const { rows } = await pool.query(`SELECT name FROM locations WHERE id = $1 LIMIT 1`, [locationId]);
  return rows[0]?.name || String(locationId);
}

async function topServicesForPeriod(from: string, to: string, locationId: string | null, limit = 10) {
  return pool.query(
    `SELECT
       s.id AS service_id,
       s.name AS service_name,
       COUNT(DISTINCT a.id)::int AS bookings_count,
       COALESCE(SUM(COALESCE(aps.price,0)),0)::numeric(14,2) AS revenue_total
     FROM appointment_services aps
     JOIN appointments a ON a.id=aps.appointment_id
     JOIN services s ON s.id=aps.service_id
     WHERE a.start_time >= $1::date
       AND a.start_time < ($2::date + interval '1 day')
       AND ($3::uuid IS NULL OR a.location_id=$3::uuid)
     GROUP BY s.id,s.name
     ORDER BY revenue_total DESC,bookings_count DESC,s.name
     LIMIT $4::integer`,
    [from, to, locationId, limit]
  );
}

async function topStaffForPeriod(from: string, to: string, locationId: string | null, limit = 10) {
  return pool.query(
    `SELECT
       e.id AS employee_id,
       e.full_name,
       e.short_name,
       COUNT(DISTINCT a.id)::int AS appointments_count,
       COALESCE(SUM(COALESCE(aps.price,0)),0)::numeric(14,2) AS revenue_total
     FROM appointments a
     JOIN employees e ON e.id=a.employee_id
     LEFT JOIN appointment_services aps ON aps.appointment_id=a.id
     WHERE a.start_time >= $1::date
       AND a.start_time < ($2::date + interval '1 day')
       AND ($3::uuid IS NULL OR a.location_id=$3::uuid)
     GROUP BY e.id,e.full_name,e.short_name
     ORDER BY revenue_total DESC,appointments_count DESC,e.full_name
     LIMIT $4::integer`,
    [from, to, locationId, limit]
  );
}

export async function sendVirReportEmail(options: SendOptions): Promise<void> {
  const { email, frequency, locationId = null, recipientName = null } = options;
  const period = getPeriod(frequency);
  const locationLabel = await getLocationLabel(locationId);

  const [summaryRes, topServicesRes, topStaffRes] = await Promise.all([
    pool.query(`SELECT * FROM public.vir_dashboard_summary($1::date, $2::date, $3::uuid)`, [period.from, period.to, locationId]),
    topServicesForPeriod(period.from, period.to, locationId, 10),
    topStaffForPeriod(period.from, period.to, locationId, 10),
  ]);

  const summary = summaryRes.rows[0] || {
    revenue_total: 0, paid_total: 0, appointments_count: 0, completed_count: 0,
    cancelled_count: 0, no_show_count: 0, avg_basket: 0, cancellation_rate_percent: 0, no_show_rate_percent: 0,
  };

  const pdf = await generateVirReportPdf({
    title: frequency === "daily" ? "Napi VIR riport" : "Heti VIR riport",
    periodLabel: period.label,
    locationLabel,
    summary,
    topServices: topServicesRes.rows || [],
    topStaff: topStaffRes.rows || [],
  });

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || "false") === "true",
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });

  const title = frequency === "daily" ? "Napi VIR riport" : "Heti VIR riport";
  const greeting = recipientName ? `Kedves ${recipientName}!` : "Kedves Vezető!";

  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: email,
    subject: `${title} • ${period.label}`,
    text: `${greeting}

Csatolva küldjük a ${title.toLowerCase()} PDF riportot.

Helyszín: ${locationLabel}
Időszak: ${period.label}

Üdv,
Kleopátra VIR`,
    attachments: [{ filename: `vir-riport-${frequency}-${period.to}.pdf`, content: pdf }],
  });
}
