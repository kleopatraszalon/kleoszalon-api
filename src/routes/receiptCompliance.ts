import { Router, Response } from "express";
import db from "../db";
import { requireAuth, type AuthRequest } from "../middleware/auth";
import { requireManagement } from "../middleware/requireRoles";
import { parseRoleKeys } from "../security/roles";

const router = Router();
router.use(requireAuth, requireManagement);

const EFFECTIVE_FROM = "2026-09-01";
const DEADLINE_DAYS = 3;
const DEFAULT_VAT_RATE_PERCENT = 27;
const VALID_REPORTING_MODES = new Set(["KOBAK_MANUAL", "M2M"]);
const VALID_RECEIPT_SOURCES = new Set(["COMPUTER", "PAPER", "MIXED"]);
const VALID_REPORT_METHODS = new Set(["KOBAK", "M2M"]);

let schemaReady: Promise<void> | null = null;

type ReceiptSettings = {
  scope_id: string;
  effective_from: string;
  enabled: boolean;
  include_workorders: boolean;
  include_retail_sales: boolean;
  reporting_mode: "KOBAK_MANUAL" | "M2M";
  receipt_source: "COMPUTER" | "PAPER" | "MIXED";
  default_vat_rate_percent: number;
  currency: string;
  software_receipt_prefix: string;
  paper_receipt_book_code: string;
  warning_days_before_deadline: number;
  email_copy_enabled: boolean;
  m2m_enabled: boolean;
  m2m_environment: "test" | "live";
  updated_by?: string | null;
  updated_at?: string | null;
};

type VatLine = {
  vat_rate_percent: number;
  gross: number;
  net: number;
  vat: number;
};

type ReceiptSourceRow = {
  source_type: "WORK_ORDER" | "RETAIL_SALE";
  source_id: string;
  source_number: string;
  location_id: string | null;
  issued_at: string;
  report_date: string;
  gross_total: number;
  taxable_gross: number;
  receipt_eligible: boolean;
  exclusion_reason: string | null;
  customer_name: string | null;
  vat_lines: VatLine[];
};

const DEFAULT_SETTINGS: ReceiptSettings = {
  scope_id: "*",
  effective_from: EFFECTIVE_FROM,
  enabled: true,
  include_workorders: true,
  include_retail_sales: true,
  reporting_mode: "KOBAK_MANUAL",
  receipt_source: "COMPUTER",
  default_vat_rate_percent: DEFAULT_VAT_RATE_PERCENT,
  currency: "HUF",
  software_receipt_prefix: "KLEO-NY",
  paper_receipt_book_code: "",
  warning_days_before_deadline: 1,
  email_copy_enabled: false,
  m2m_enabled: false,
  m2m_environment: "test",
};

function actor(req: AuthRequest) {
  return req.user?.email || String(req.user?.id || "");
}

function cleanDate(value: unknown, fallback: string) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : fallback;
}

function money(value: unknown) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function roundRate(value: unknown, fallback = DEFAULT_VAT_RATE_PERCENT) {
  let n = Number(value);
  if (!Number.isFinite(n)) n = fallback;
  if (n > 0 && n <= 1) n *= 100;
  if (n < 0 || n > 100) n = fallback;
  return Math.round(n * 1000) / 1000;
}

function toIsoDate(value: unknown) {
  const d = value instanceof Date ? value : new Date(String(value || ""));
  if (!Number.isFinite(d.getTime())) return new Date().toISOString().slice(0, 10);
  return d.toISOString().slice(0, 10);
}

function deadlineFor(reportDate: string) {
  const d = new Date(`${reportDate}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + DEADLINE_DAYS);
  return d.toISOString().slice(0, 10);
}

function vatLine(grossRaw: unknown, rateRaw: unknown): VatLine {
  const gross = money(grossRaw);
  const vat_rate_percent = roundRate(rateRaw);
  const divisor = 1 + vat_rate_percent / 100;
  const net = divisor > 0 ? money(gross / divisor) : gross;
  return { vat_rate_percent, gross, net, vat: money(gross - net) };
}

function mergeVatLines(lines: VatLine[]) {
  const byRate = new Map<number, VatLine>();
  for (const line of lines) {
    const key = roundRate(line.vat_rate_percent);
    const old = byRate.get(key) || { vat_rate_percent: key, gross: 0, net: 0, vat: 0 };
    old.gross = money(old.gross + line.gross);
    old.net = money(old.net + line.net);
    old.vat = money(old.vat + line.vat);
    byRate.set(key, old);
  }
  return Array.from(byRate.values()).sort((a, b) => b.vat_rate_percent - a.vat_rate_percent);
}

function scopeFor(req: AuthRequest, res: Response, explicit?: unknown): string | null | undefined {
  const requested = String(explicit ?? req.query.locationId ?? req.query.location_id ?? "").trim();
  const roles = parseRoleKeys(req.user?.role);
  const ownLocation = String(req.user?.location_id || "").trim();
  if (roles.includes("admin")) return requested || null;
  if (!ownLocation) {
    res.status(403).json({ ok: false, message: "A felhasználóhoz nincs telephely rendelve." });
    return undefined;
  }
  if (requested && requested !== ownLocation) {
    res.status(403).json({ ok: false, message: "Másik telephely nyugtaadata nem érhető el." });
    return undefined;
  }
  return ownLocation;
}

async function tableExists(name: string) {
  const q = await db.query(`SELECT to_regclass($1) IS NOT NULL ok`, [`public.${name}`]);
  return Boolean(q.rows[0]?.ok);
}

async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await db.query(`
        CREATE EXTENSION IF NOT EXISTS pgcrypto;
        CREATE TABLE IF NOT EXISTS vir_receipt_compliance_settings (
          scope_id text PRIMARY KEY,
          effective_from date NOT NULL DEFAULT DATE '2026-09-01',
          enabled boolean NOT NULL DEFAULT true,
          include_workorders boolean NOT NULL DEFAULT true,
          include_retail_sales boolean NOT NULL DEFAULT true,
          reporting_mode text NOT NULL DEFAULT 'KOBAK_MANUAL',
          receipt_source text NOT NULL DEFAULT 'COMPUTER',
          default_vat_rate_percent numeric(6,3) NOT NULL DEFAULT 27,
          currency text NOT NULL DEFAULT 'HUF',
          software_receipt_prefix text NOT NULL DEFAULT 'KLEO-NY',
          paper_receipt_book_code text NOT NULL DEFAULT '',
          warning_days_before_deadline integer NOT NULL DEFAULT 1,
          email_copy_enabled boolean NOT NULL DEFAULT false,
          m2m_enabled boolean NOT NULL DEFAULT false,
          m2m_environment text NOT NULL DEFAULT 'test',
          updated_by text,
          updated_at timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT vir_receipt_reporting_mode_ck CHECK(reporting_mode IN ('KOBAK_MANUAL','M2M')),
          CONSTRAINT vir_receipt_source_ck CHECK(receipt_source IN ('COMPUTER','PAPER','MIXED')),
          CONSTRAINT vir_receipt_vat_ck CHECK(default_vat_rate_percent BETWEEN 0 AND 100),
          CONSTRAINT vir_receipt_warning_ck CHECK(warning_days_before_deadline BETWEEN 0 AND 3),
          CONSTRAINT vir_receipt_m2m_environment_ck CHECK(m2m_environment IN ('test','live'))
        );

        CREATE TABLE IF NOT EXISTS vir_receipt_report_status (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          location_id text,
          report_date date NOT NULL,
          currency text NOT NULL DEFAULT 'HUF',
          status text NOT NULL DEFAULT 'PENDING',
          report_method text,
          external_reference text,
          first_receipt_number text,
          last_receipt_number text,
          summary_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
          note text,
          reported_at timestamptz,
          reported_by text,
          updated_at timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT vir_receipt_status_ck CHECK(status IN ('PENDING','READY','REPORTED','REOPENED')),
          CONSTRAINT vir_receipt_method_ck CHECK(report_method IS NULL OR report_method IN ('KOBAK','M2M'))
        );
        CREATE UNIQUE INDEX IF NOT EXISTS vir_receipt_report_status_uq
          ON vir_receipt_report_status(COALESCE(location_id,'*'),report_date,currency);
        CREATE INDEX IF NOT EXISTS vir_receipt_report_date_idx
          ON vir_receipt_report_status(report_date DESC,location_id);
      `);
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

async function loadSettings(locationId: string | null): Promise<ReceiptSettings> {
  await ensureSchema();
  const scopeId = locationId || "*";
  const q = await db.query(
    `SELECT * FROM vir_receipt_compliance_settings
     WHERE scope_id IN($1,'*')
     ORDER BY CASE WHEN scope_id=$1 THEN 0 ELSE 1 END
     LIMIT 1`,
    [scopeId],
  );
  const row = q.rows[0];
  if (!row) return { ...DEFAULT_SETTINGS, scope_id: scopeId };
  return {
    ...DEFAULT_SETTINGS,
    ...row,
    scope_id: row.scope_id,
    effective_from: toIsoDate(row.effective_from),
    enabled: Boolean(row.enabled),
    include_workorders: Boolean(row.include_workorders),
    include_retail_sales: Boolean(row.include_retail_sales),
    default_vat_rate_percent: Number(row.default_vat_rate_percent),
    warning_days_before_deadline: Number(row.warning_days_before_deadline),
    email_copy_enabled: Boolean(row.email_copy_enabled),
    m2m_enabled: Boolean(row.m2m_enabled),
  } as ReceiptSettings;
}

async function workOrderSources(from: string, to: string, locationId: string | null, settings: ReceiptSettings): Promise<ReceiptSourceRow[]> {
  if (!settings.include_workorders || !(await tableExists("work_orders")) || !(await tableExists("work_order_items"))) return [];
  const q = await db.query(
    `SELECT
       w.id::text source_id,
       COALESCE(NULLIF(to_jsonb(w)->>'work_order_number',''),w.id::text) source_number,
       NULLIF(to_jsonb(w)->>'location_id','') location_id,
       COALESCE(
         NULLIF(to_jsonb(w)->>'financial_closed_at','')::timestamptz,
         NULLIF(to_jsonb(w)->>'closed_at','')::timestamptz,
         NULLIF(to_jsonb(w)->>'completed_at','')::timestamptz,
         NULLIF(to_jsonb(w)->>'updated_at','')::timestamptz,
         NULLIF(to_jsonb(w)->>'created_at','')::timestamptz,
         now()
       ) issued_at,
       COALESCE(NULLIF(to_jsonb(w)->>'gross_total','')::numeric,0)::numeric gross_total,
       COALESCE(NULLIF(to_jsonb(w)->>'discount_amount','')::numeric,0)::numeric discount_amount,
       COALESCE(NULLIF(to_jsonb(w)->>'tip_amount','')::numeric,0)::numeric tip_amount,
       COALESCE(NULLIF(to_jsonb(w)->>'invoice_status',''),'not_requested') invoice_status,
       COALESCE(NULLIF(to_jsonb(w)->>'payment_status',''),'') payment_status,
       NULLIF(to_jsonb(w)->>'client_name','') customer_name,
       wi.id::text line_id,
       COALESCE(NULLIF(to_jsonb(wi)->>'item_type',''),'service') item_type,
       COALESCE(NULLIF(to_jsonb(wi)->>'line_total','')::numeric,0)::numeric line_gross,
       COALESCE(
         NULLIF(to_jsonb(wi)->>'vat_rate','')::numeric,
         NULLIF(to_jsonb(p)->>'vat_rate','')::numeric,
         NULLIF(to_jsonb(s)->>'vat_rate','')::numeric,
         $4::numeric / 100
       ) vat_rate
     FROM work_orders w
     JOIN work_order_items wi ON wi.work_order_id::text=w.id::text
     LEFT JOIN products p ON p.id::text=NULLIF(to_jsonb(wi)->>'product_id','')
     LEFT JOIN services s ON s.id::text=NULLIF(to_jsonb(wi)->>'service_id','')
     WHERE COALESCE(
       NULLIF(to_jsonb(w)->>'financial_closed_at','')::timestamptz,
       NULLIF(to_jsonb(w)->>'closed_at','')::timestamptz,
       NULLIF(to_jsonb(w)->>'completed_at','')::timestamptz,
       NULLIF(to_jsonb(w)->>'updated_at','')::timestamptz,
       NULLIF(to_jsonb(w)->>'created_at','')::timestamptz
     )::date BETWEEN $1::date AND $2::date
       AND ($3::text IS NULL OR NULLIF(to_jsonb(w)->>'location_id','')=$3::text)
       AND COALESCE(NULLIF(to_jsonb(w)->>'status',''),'') NOT IN ('cancelled','no_show')
     ORDER BY issued_at,w.id,wi.id`,
    [from, to, locationId, settings.default_vat_rate_percent],
  );

  const grouped = new Map<string, any>();
  for (const row of q.rows) {
    const key = String(row.source_id);
    const invoiceStatus = String(row.invoice_status || "not_requested").toLowerCase();
    const invoiceExcluded = ["requested", "issued", "invoiced", "invoice_requested", "sent", "submitted"].includes(invoiceStatus);
    const paymentStatus = String(row.payment_status || "").toLowerCase();
    const paymentExcluded = paymentStatus && paymentStatus !== "paid";
    const current = grouped.get(key) || {
      source_type: "WORK_ORDER" as const,
      source_id: key,
      source_number: String(row.source_number || key),
      location_id: row.location_id ? String(row.location_id) : null,
      issued_at: new Date(row.issued_at).toISOString(),
      report_date: toIsoDate(row.issued_at),
      gross_total: money(row.gross_total),
      discount_amount: money(row.discount_amount),
      tip_amount: money(row.tip_amount),
      receipt_eligible: !(invoiceExcluded || paymentExcluded),
      exclusion_reason: invoiceExcluded ? "INVOICE" : paymentExcluded ? "NOT_PAID" : null,
      customer_name: row.customer_name ? String(row.customer_name) : null,
      raw_lines: [] as Array<{ gross: number; rate: number }>,
    };
    current.raw_lines.push({ gross: money(row.line_gross), rate: roundRate(row.vat_rate, settings.default_vat_rate_percent) });
    grouped.set(key, current);
  }

  return Array.from(grouped.values()).map((source) => {
    const lineGross = money(source.raw_lines.reduce((sum: number, line: any) => sum + line.gross, 0));
    const taxableGross = Math.max(0, money(source.gross_total - source.discount_amount));
    const scale = lineGross > 0 ? taxableGross / lineGross : 0;
    const vat_lines = mergeVatLines(
      source.raw_lines.map((line: any) => vatLine(money(line.gross * scale), line.rate)),
    );
    return {
      source_type: source.source_type,
      source_id: source.source_id,
      source_number: source.source_number,
      location_id: source.location_id,
      issued_at: source.issued_at,
      report_date: source.report_date,
      gross_total: source.gross_total,
      taxable_gross: taxableGross,
      receipt_eligible: source.receipt_eligible,
      exclusion_reason: source.exclusion_reason,
      customer_name: source.customer_name,
      vat_lines,
    } satisfies ReceiptSourceRow;
  });
}

async function retailSources(from: string, to: string, locationId: string | null, settings: ReceiptSettings): Promise<ReceiptSourceRow[]> {
  if (!settings.include_retail_sales || !(await tableExists("retail_sales")) || !(await tableExists("retail_sale_items"))) return [];
  const q = await db.query(
    `SELECT
       rs.id::text source_id,
       rs.id::text source_number,
       NULLIF(to_jsonb(rs)->>'location_id','') location_id,
       COALESCE(NULLIF(to_jsonb(rs)->>'created_at','')::timestamptz,now()) issued_at,
       COALESCE(NULLIF(to_jsonb(rs)->>'gross_total','')::numeric,0)::numeric gross_total,
       COALESCE(NULLIF(to_jsonb(rs)->>'invoice_requested','')::boolean,false) invoice_requested,
       COALESCE(NULLIF(to_jsonb(rs)->>'status',''),'paid') sale_status,
       COALESCE(NULLIF(to_jsonb(rs)->>'customer_name',''),NULLIF(to_jsonb(rs)->>'customer_email','')) customer_name,
       i.id::text line_id,
       COALESCE(NULLIF(to_jsonb(i)->>'gross_amount','')::numeric,0)::numeric line_gross,
       COALESCE(
         NULLIF(to_jsonb(i)->>'vat_rate','')::numeric,
         NULLIF(to_jsonb(p)->>'vat_rate','')::numeric,
         $4::numeric / 100
       ) vat_rate
     FROM retail_sales rs
     JOIN retail_sale_items i ON i.sale_id::text=rs.id::text
     LEFT JOIN products p ON p.id::text=NULLIF(to_jsonb(i)->>'product_id','')
     WHERE COALESCE(NULLIF(to_jsonb(rs)->>'created_at','')::timestamptz,now())::date BETWEEN $1::date AND $2::date
       AND ($3::text IS NULL OR NULLIF(to_jsonb(rs)->>'location_id','')=$3::text)
     ORDER BY issued_at,rs.id,i.id`,
    [from, to, locationId, settings.default_vat_rate_percent],
  );

  const grouped = new Map<string, any>();
  for (const row of q.rows) {
    const key = String(row.source_id);
    const invoiceExcluded = Boolean(row.invoice_requested);
    const statusExcluded = !["paid", "completed", "closed"].includes(String(row.sale_status || "paid").toLowerCase());
    const current = grouped.get(key) || {
      source_type: "RETAIL_SALE" as const,
      source_id: key,
      source_number: key,
      location_id: row.location_id ? String(row.location_id) : null,
      issued_at: new Date(row.issued_at).toISOString(),
      report_date: toIsoDate(row.issued_at),
      gross_total: money(row.gross_total),
      receipt_eligible: !(invoiceExcluded || statusExcluded),
      exclusion_reason: invoiceExcluded ? "INVOICE" : statusExcluded ? "NOT_PAID" : null,
      customer_name: row.customer_name ? String(row.customer_name) : null,
      raw_lines: [] as Array<{ gross: number; rate: number }>,
    };
    current.raw_lines.push({ gross: money(row.line_gross), rate: roundRate(row.vat_rate, settings.default_vat_rate_percent) });
    grouped.set(key, current);
  }

  return Array.from(grouped.values()).map((source) => ({
    source_type: source.source_type,
    source_id: source.source_id,
    source_number: source.source_number,
    location_id: source.location_id,
    issued_at: source.issued_at,
    report_date: source.report_date,
    gross_total: source.gross_total,
    taxable_gross: source.gross_total,
    receipt_eligible: source.receipt_eligible,
    exclusion_reason: source.exclusion_reason,
    customer_name: source.customer_name,
    vat_lines: mergeVatLines(source.raw_lines.map((line: any) => vatLine(line.gross, line.rate))),
  }));
}

async function sourceRows(from: string, to: string, locationId: string | null, settings: ReceiptSettings) {
  const [workorders, retail] = await Promise.all([
    workOrderSources(from, to, locationId, settings),
    retailSources(from, to, locationId, settings),
  ]);
  return [...workorders, ...retail].sort((a, b) => b.issued_at.localeCompare(a.issued_at));
}

async function statusRows(from: string, to: string, locationId: string | null) {
  await ensureSchema();
  const q = await db.query(
    `SELECT * FROM vir_receipt_report_status
     WHERE report_date BETWEEN $1::date AND $2::date
       AND ($3::text IS NULL OR location_id=$3::text)
     ORDER BY report_date DESC,location_id`,
    [from, to, locationId],
  );
  return q.rows;
}

function buildDailySummary(sources: ReceiptSourceRow[], statuses: any[], settings: ReceiptSettings) {
  const statusMap = new Map<string, any>();
  for (const status of statuses) {
    statusMap.set(`${toIsoDate(status.report_date)}|${status.location_id || "*"}|${String(status.currency || settings.currency).toUpperCase()}`, status);
  }
  const days = new Map<string, any>();
  for (const source of sources.filter((item) => item.receipt_eligible)) {
    const currency = String(settings.currency || "HUF").toUpperCase();
    const key = `${source.report_date}|${source.location_id || "*"}|${currency}`;
    const current = days.get(key) || {
      report_date: source.report_date,
      location_id: source.location_id,
      currency,
      receipt_count: 0,
      gross_total: 0,
      net_total: 0,
      vat_total: 0,
      workorder_count: 0,
      retail_sale_count: 0,
      vat_lines: [] as VatLine[],
      source_ids: [] as string[],
    };
    current.receipt_count += 1;
    current.gross_total = money(current.gross_total + source.taxable_gross);
    if (source.source_type === "WORK_ORDER") current.workorder_count += 1;
    else current.retail_sale_count += 1;
    current.source_ids.push(`${source.source_type}:${source.source_id}`);
    current.vat_lines.push(...source.vat_lines);
    days.set(key, current);
  }

  const nowDate = new Date().toISOString().slice(0, 10);
  return Array.from(days.entries()).map(([key, current]) => {
    const vat_breakdown = mergeVatLines(current.vat_lines);
    current.net_total = money(vat_breakdown.reduce((sum, line) => sum + line.net, 0));
    current.vat_total = money(vat_breakdown.reduce((sum, line) => sum + line.vat, 0));
    const status = statusMap.get(key);
    const deadline_date = deadlineFor(current.report_date);
    const reported = String(status?.status || "").toUpperCase() === "REPORTED";
    return {
      report_date: current.report_date,
      location_id: current.location_id,
      currency: current.currency,
      receipt_count: current.receipt_count,
      gross_total: current.gross_total,
      net_total: current.net_total,
      vat_total: current.vat_total,
      vat_breakdown,
      sources: { workorders: current.workorder_count, retail_sales: current.retail_sale_count },
      deadline_days: DEADLINE_DAYS,
      deadline_date,
      overdue: !reported && nowDate > deadline_date,
      due_soon: !reported && nowDate <= deadline_date && nowDate >= current.report_date,
      status: status?.status || "READY",
      report_method: status?.report_method || null,
      external_reference: status?.external_reference || null,
      first_receipt_number: status?.first_receipt_number || null,
      last_receipt_number: status?.last_receipt_number || null,
      reported_at: status?.reported_at || null,
      reported_by: status?.reported_by || null,
      note: status?.note || null,
    };
  }).sort((a, b) => b.report_date.localeCompare(a.report_date) || String(a.location_id || "").localeCompare(String(b.location_id || "")));
}

router.get("/settings", async (req: AuthRequest, res: Response) => {
  try {
    const locationId = scopeFor(req, res);
    if (locationId === undefined) return;
    const settings = await loadSettings(locationId);
    return res.json({
      ok: true,
      settings,
      legal: {
        effective_from: EFFECTIVE_FROM,
        deadline_days: DEADLINE_DAYS,
        deadline_type: "calendar_days",
        aggregation: "daily_by_vat_rate",
        methods: ["KOBAK", "M2M"],
      },
      m2m: {
        configured: settings.reporting_mode === "M2M" && settings.m2m_enabled,
        environment: settings.m2m_environment,
        interface_version: "receipt-if 1.0",
        transport_status: "ADAPTER_NOT_ACTIVATED",
        message: "A VIR az M2M módot és az adatszerkezetet előkészíti; hálózati beküldés csak külön NAV technikai konfiguráció és teszt után aktiválható.",
      },
    });
  } catch (error: any) {
    return res.status(500).json({ ok: false, message: error?.message || "A nyugta beállítások nem tölthetők be." });
  }
});

router.put("/settings", async (req: AuthRequest, res: Response) => {
  try {
    await ensureSchema();
    const locationId = scopeFor(req, res, req.body?.location_id ?? req.body?.locationId);
    if (locationId === undefined) return;
    const scopeId = locationId || "*";
    const reportingMode = String(req.body?.reporting_mode || DEFAULT_SETTINGS.reporting_mode).toUpperCase();
    const receiptSource = String(req.body?.receipt_source || DEFAULT_SETTINGS.receipt_source).toUpperCase();
    if (!VALID_REPORTING_MODES.has(reportingMode)) return res.status(400).json({ ok: false, message: "Érvénytelen adatszolgáltatási mód." });
    if (!VALID_RECEIPT_SOURCES.has(receiptSource)) return res.status(400).json({ ok: false, message: "Érvénytelen nyugtaforrás." });
    const effectiveFrom = cleanDate(req.body?.effective_from, EFFECTIVE_FROM);
    const defaultVat = roundRate(req.body?.default_vat_rate_percent, DEFAULT_VAT_RATE_PERCENT);
    const currency = String(req.body?.currency || "HUF").trim().toUpperCase().slice(0, 3) || "HUF";
    const warningDays = Math.max(0, Math.min(DEADLINE_DAYS, Math.floor(Number(req.body?.warning_days_before_deadline ?? 1))));
    const m2mEnvironment = String(req.body?.m2m_environment || "test").toLowerCase() === "live" ? "live" : "test";
    const q = await db.query(
      `INSERT INTO vir_receipt_compliance_settings(
         scope_id,effective_from,enabled,include_workorders,include_retail_sales,reporting_mode,receipt_source,
         default_vat_rate_percent,currency,software_receipt_prefix,paper_receipt_book_code,warning_days_before_deadline,
         email_copy_enabled,m2m_enabled,m2m_environment,updated_by,updated_at
       ) VALUES($1,$2::date,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now())
       ON CONFLICT(scope_id) DO UPDATE SET
         effective_from=EXCLUDED.effective_from,enabled=EXCLUDED.enabled,include_workorders=EXCLUDED.include_workorders,
         include_retail_sales=EXCLUDED.include_retail_sales,reporting_mode=EXCLUDED.reporting_mode,receipt_source=EXCLUDED.receipt_source,
         default_vat_rate_percent=EXCLUDED.default_vat_rate_percent,currency=EXCLUDED.currency,
         software_receipt_prefix=EXCLUDED.software_receipt_prefix,paper_receipt_book_code=EXCLUDED.paper_receipt_book_code,
         warning_days_before_deadline=EXCLUDED.warning_days_before_deadline,email_copy_enabled=EXCLUDED.email_copy_enabled,
         m2m_enabled=EXCLUDED.m2m_enabled,m2m_environment=EXCLUDED.m2m_environment,updated_by=EXCLUDED.updated_by,updated_at=now()
       RETURNING *`,
      [
        scopeId,
        effectiveFrom,
        req.body?.enabled !== false,
        req.body?.include_workorders !== false,
        req.body?.include_retail_sales !== false,
        reportingMode,
        receiptSource,
        defaultVat,
        currency,
        String(req.body?.software_receipt_prefix || "KLEO-NY").trim().slice(0, 32),
        String(req.body?.paper_receipt_book_code || "").trim().slice(0, 64),
        warningDays,
        Boolean(req.body?.email_copy_enabled),
        Boolean(req.body?.m2m_enabled),
        m2mEnvironment,
        actor(req),
      ],
    );
    return res.json({ ok: true, settings: { ...q.rows[0], effective_from: toIsoDate(q.rows[0].effective_from) } });
  } catch (error: any) {
    return res.status(500).json({ ok: false, message: error?.message || "A nyugta beállítások nem menthetők." });
  }
});

router.get("/sources", async (req: AuthRequest, res: Response) => {
  try {
    const locationId = scopeFor(req, res);
    if (locationId === undefined) return;
    const settings = await loadSettings(locationId);
    const today = new Date().toISOString().slice(0, 10);
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 14);
    const from = cleanDate(req.query.from, d.toISOString().slice(0, 10));
    const to = cleanDate(req.query.to, today);
    const rows = await sourceRows(from, to, locationId, settings);
    return res.json({ ok: true, from, to, rows, total: rows.length });
  } catch (error: any) {
    return res.status(500).json({ ok: false, message: error?.message || "A nyugtaforrások nem tölthetők be." });
  }
});

router.get("/daily", async (req: AuthRequest, res: Response) => {
  try {
    const locationId = scopeFor(req, res);
    if (locationId === undefined) return;
    const settings = await loadSettings(locationId);
    const today = new Date().toISOString().slice(0, 10);
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 31);
    const from = cleanDate(req.query.from, settings.effective_from > d.toISOString().slice(0, 10) ? settings.effective_from : d.toISOString().slice(0, 10));
    const to = cleanDate(req.query.to, today);
    const [sources, statuses] = await Promise.all([
      sourceRows(from, to, locationId, settings),
      statusRows(from, to, locationId),
    ]);
    const daily = buildDailySummary(sources, statuses, settings);
    const eligible = sources.filter((item) => item.receipt_eligible);
    return res.json({
      ok: true,
      from,
      to,
      settings,
      rows: daily,
      stats: {
        days: daily.length,
        receipts: eligible.length,
        gross_total: money(eligible.reduce((sum, item) => sum + item.taxable_gross, 0)),
        overdue_days: daily.filter((item) => item.overdue).length,
        reported_days: daily.filter((item) => item.status === "REPORTED").length,
        excluded_as_invoice: sources.filter((item) => item.exclusion_reason === "INVOICE").length,
      },
    });
  } catch (error: any) {
    return res.status(500).json({ ok: false, message: error?.message || "A napi nyugtaösszesítő nem tölthető be." });
  }
});

router.post("/daily/:date/mark-reported", async (req: AuthRequest, res: Response) => {
  try {
    await ensureSchema();
    const reportDate = cleanDate(req.params.date, "");
    if (!reportDate) return res.status(400).json({ ok: false, message: "Érvénytelen tárgynap." });
    const locationId = scopeFor(req, res, req.body?.location_id ?? req.body?.locationId);
    if (locationId === undefined) return;
    const settings = await loadSettings(locationId);
    const method = String(req.body?.report_method || req.body?.method || "KOBAK").toUpperCase();
    if (!VALID_REPORT_METHODS.has(method)) return res.status(400).json({ ok: false, message: "Érvénytelen beküldési mód." });
    const sources = await sourceRows(reportDate, reportDate, locationId, settings);
    const summary = buildDailySummary(sources, [], settings).find((item) => String(item.location_id || "") === String(locationId || "")) || null;
    if (!summary || !summary.receipt_count) return res.status(409).json({ ok: false, message: "A tárgynaphoz nincs jelentendő VIR nyugtaforgalom." });
    const currency = String(req.body?.currency || settings.currency || "HUF").toUpperCase();
    const q = await db.query(
      `INSERT INTO vir_receipt_report_status(
         location_id,report_date,currency,status,report_method,external_reference,first_receipt_number,last_receipt_number,
         summary_snapshot,note,reported_at,reported_by,updated_at
       ) VALUES($1,$2::date,$3,'REPORTED',$4,$5,$6,$7,$8::jsonb,$9,now(),$10,now())
       ON CONFLICT(COALESCE(location_id,'*'),report_date,currency) DO UPDATE SET
         status='REPORTED',report_method=EXCLUDED.report_method,external_reference=EXCLUDED.external_reference,
         first_receipt_number=EXCLUDED.first_receipt_number,last_receipt_number=EXCLUDED.last_receipt_number,
         summary_snapshot=EXCLUDED.summary_snapshot,note=EXCLUDED.note,reported_at=now(),reported_by=EXCLUDED.reported_by,updated_at=now()
       RETURNING *`,
      [
        locationId,
        reportDate,
        currency,
        method,
        String(req.body?.external_reference || "").trim() || null,
        String(req.body?.first_receipt_number || "").trim() || null,
        String(req.body?.last_receipt_number || "").trim() || null,
        JSON.stringify(summary),
        String(req.body?.note || "").trim() || null,
        actor(req),
      ],
    );
    return res.json({ ok: true, report: q.rows[0], summary });
  } catch (error: any) {
    return res.status(500).json({ ok: false, message: error?.message || "A nyugta-adatszolgáltatás státusza nem menthető." });
  }
});

router.post("/daily/:date/reopen", async (req: AuthRequest, res: Response) => {
  try {
    await ensureSchema();
    const reportDate = cleanDate(req.params.date, "");
    if (!reportDate) return res.status(400).json({ ok: false, message: "Érvénytelen tárgynap." });
    const locationId = scopeFor(req, res, req.body?.location_id ?? req.body?.locationId);
    if (locationId === undefined) return;
    const settings = await loadSettings(locationId);
    const q = await db.query(
      `UPDATE vir_receipt_report_status SET status='REOPENED',note=$4,updated_at=now()
       WHERE report_date=$1::date AND COALESCE(location_id,'*')=COALESCE($2::text,'*') AND currency=$3
       RETURNING *`,
      [reportDate, locationId, settings.currency, String(req.body?.note || "Újranyitva ellenőrzésre").trim()],
    );
    return res.json({ ok: true, report: q.rows[0] || null });
  } catch (error: any) {
    return res.status(500).json({ ok: false, message: error?.message || "A tárgynap nem nyitható újra." });
  }
});

router.get("/readiness", async (req: AuthRequest, res: Response) => {
  try {
    const locationId = scopeFor(req, res);
    if (locationId === undefined) return;
    const settings = await loadSettings(locationId);
    const [hasWorkOrders, hasWorkOrderItems, hasRetailSales, hasRetailItems] = await Promise.all([
      tableExists("work_orders"),
      tableExists("work_order_items"),
      tableExists("retail_sales"),
      tableExists("retail_sale_items"),
    ]);
    const checks = [
      { key: "effective_date", ok: Boolean(settings.effective_from), label: "Hatálybalépés beállítva" },
      { key: "vat_default", ok: settings.default_vat_rate_percent >= 0, label: "Alap ÁFA-kulcs beállítva" },
      { key: "workorders", ok: !settings.include_workorders || (hasWorkOrders && hasWorkOrderItems), label: "Munkalap-forrás elérhető" },
      { key: "retail", ok: !settings.include_retail_sales || (hasRetailSales && hasRetailItems), label: "Termékeladás-forrás elérhető" },
      { key: "reporting", ok: VALID_REPORTING_MODES.has(settings.reporting_mode), label: "Adatszolgáltatási mód érvényes" },
      { key: "m2m_transport", ok: settings.reporting_mode !== "M2M" || settings.m2m_enabled, label: "M2M aktiválás" },
    ];
    return res.json({
      ok: true,
      ready_for_kobak: checks.filter((item) => item.key !== "m2m_transport").every((item) => item.ok),
      ready_for_m2m_transport: settings.reporting_mode === "M2M" && settings.m2m_enabled && checks.every((item) => item.ok),
      checks,
      legal_deadline_days: DEADLINE_DAYS,
      m2m_interface: "receipt-if 1.0",
    });
  } catch (error: any) {
    return res.status(500).json({ ok: false, message: error?.message || "A nyugta modul készültsége nem ellenőrizhető." });
  }
});

export default router;
