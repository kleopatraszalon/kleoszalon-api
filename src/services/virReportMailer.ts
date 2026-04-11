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

export async function sendVirReportEmail(options: SendOptions): Promise<void> {
  const { email, frequency, locationId = null, recipientName = null } = options;
  const period = getPeriod(frequency);
  const locationLabel = await getLocationLabel(locationId);

  const summaryRes = await pool.query(`SELECT * FROM public.vir_dashboard_summary($1::date, $2::date, $3::uuid)`, [period.from, period.to, locationId]);
  const topServicesRes = await pool.query(`SELECT * FROM public.vir_top_services($1::integer)`, [10]);
  const topStaffRes = await pool.query(`SELECT * FROM public.vir_top_staff($1::integer)`, [10]);

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
