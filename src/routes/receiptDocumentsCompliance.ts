import { Router, Response } from "express";
import db from "../db";
import { requireAuth, type AuthRequest } from "../middleware/auth";
import { requireRoles } from "../middleware/requireRoles";
import { parseRoleKeys } from "../security/roles";

const router = Router();
router.use(requireAuth);
router.use(requireRoles("admin", "manager", "accounting", "bookkeeper", "location_manager", "salon_manager", "receptionist"));

const GLOBAL = new Set(["admin", "manager", "accounting", "bookkeeper"]);
const BATCH_PREFIX = "VIR_COMPUTER";
const DEADLINE = 3;
const money = (v: unknown) => Math.round(Number(v || 0) * 100) / 100;
const day = (v: unknown) => {
  const d = new Date(String(v || ""));
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
};
const businessDay = (v: unknown) => new Date(String(v)).toLocaleDateString("sv-SE", { timeZone: "Europe/Budapest" });
const deadline = (d: string) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + DEADLINE); return x.toISOString().slice(0, 10); };
const actor = (req: AuthRequest) => req.user?.email || String(req.user?.id || "");
const batchFor = (entityId: unknown) => `${BATCH_PREFIX}:${String(entityId || "UNASSIGNED")}`;

function scope(req: AuthRequest, res: Response, explicit?: unknown): string | null | undefined {
  const requested = String(explicit ?? req.query.location_id ?? req.query.locationId ?? "").trim();
  const roles = parseRoleKeys(req.user?.role);
  if (roles.some((r) => GLOBAL.has(r))) return requested || null;
  const own = String(req.user?.location_id || "").trim();
  if (!own) { res.status(403).json({ ok: false, message: "A felhasználóhoz nincs telephely rendelve." }); return undefined; }
  if (requested && requested !== own) { res.status(403).json({ ok: false, message: "Másik telephely nyugtaadata nem érhető el." }); return undefined; }
  return own;
}

async function table(name: string) { return Boolean((await db.query(`SELECT to_regclass($1) IS NOT NULL ok`, [`public.${name}`])).rows[0]?.ok); }
async function ensureBatch() {
  await db.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE TABLE IF NOT EXISTS vir_receipt_report_batches(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),scope_key text NOT NULL DEFAULT '*',location_id text,legal_entity_id uuid,
      report_date date NOT NULL,currency text NOT NULL DEFAULT 'HUF',batch_key text NOT NULL,receipt_source text NOT NULL DEFAULT 'COMPUTER',
      serial_range_key text,first_receipt_number text,last_receipt_number text,status text NOT NULL DEFAULT 'READY',report_method text,external_reference text,
      sale_document_count integer NOT NULL DEFAULT 0,modifying_document_count integer NOT NULL DEFAULT 0,summary_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,note text,
      reported_at timestamptz,reported_by text,created_by text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(scope_key,report_date,currency,batch_key)
    );
    ALTER TABLE vir_receipt_report_batches ADD COLUMN IF NOT EXISTS legal_entity_id uuid REFERENCES legal_entities(id) ON DELETE RESTRICT;
  `);
}

async function documentRows(from: string, to: string, locationId: string | null) {
  if (!(await table("vir_receipts"))) return [];
  const params: any[] = [from, to]; let filter = "";
  if (locationId) { params.push(locationId); filter = ` AND r.location_id=$3`; }
  return (await db.query(`
    SELECT r.id::text id,r.location_id,r.legal_entity_id::text,r.source_type,r.source_id,r.source_number,r.receipt_number,
           r.document_type,r.issued_at,r.currency,r.gross_total,r.vat_breakdown,r.customer_name,r.issuer_name,r.issuer_tax_number,
           e.legal_name,e.accounting_ledger_code
      FROM vir_receipts r LEFT JOIN legal_entities e ON e.id=r.legal_entity_id
     WHERE (r.issued_at AT TIME ZONE 'Europe/Budapest')::date BETWEEN $1::date AND $2::date ${filter}
     ORDER BY r.issued_at,r.receipt_number`, params)).rows;
}

type VatBucket = { vat_category: string; vat_rate_percent: number; gross: number; net: number; vat: number };
function addVat(target: Map<string, VatBucket>, source: any[]) {
  for (const raw of Array.isArray(source) ? source : []) {
    const vat_category = String(raw?.vat_category || "OTHER"), vat_rate_percent = Number(raw?.vat_rate_percent || 0), key = `${vat_category}|${vat_rate_percent}`;
    const x = target.get(key) || { vat_category, vat_rate_percent, gross: 0, net: 0, vat: 0 };
    x.gross = money(x.gross + Number(raw?.gross || 0)); x.net = money(x.net + Number(raw?.net || 0)); x.vat = money(x.vat + Number(raw?.vat || 0)); target.set(key, x);
  }
}

function aggregate(rows: any[], stored: any[]) {
  const status = new Map(stored.map((x: any) => [`${day(x.report_date)}|${x.location_id || ""}|${x.currency}|${x.batch_key}`, x]));
  const map = new Map<string, any>();
  for (const r of rows) {
    const reportDate = businessDay(r.issued_at), currency = String(r.currency || "HUF"), batch_key=batchFor(r.legal_entity_id);
    const key = `${reportDate}|${r.location_id || ""}|${currency}|${batch_key}`;
    const x = map.get(key) || {
      report_date: reportDate, location_id: r.location_id || null, legal_entity_id:r.legal_entity_id||null,
      legal_entity_name:r.legal_name||r.issuer_name||"Ismeretlen cég", issuer_tax_number:r.issuer_tax_number||null, accounting_ledger_code:r.accounting_ledger_code||null,
      scope_key: r.location_id || "*", currency, batch_key, receipt_source: "COMPUTER", receipt_count: 0,
      sale_document_count: 0, modifying_document_count: 0, sales_gross_total: 0, modifying_gross_total: 0,
      gross_total: 0, net_total: 0, vat_total: 0, vat: new Map<string, VatBucket>(), sale_vat: new Map<string, VatBucket>(), modifying_vat: new Map<string, VatBucket>(),
      sources: { workorders: 0, retail_sales: 0 }, first_receipt_number: null, last_receipt_number: null,
    };
    x.receipt_count += 1; const gross = money(r.gross_total), isVoid = r.document_type === "VOID";
    if (isVoid) { x.modifying_document_count += 1; x.modifying_gross_total = money(x.modifying_gross_total + gross); addVat(x.modifying_vat, r.vat_breakdown); }
    else { x.sale_document_count += 1; x.sales_gross_total = money(x.sales_gross_total + gross); addVat(x.sale_vat, r.vat_breakdown); }
    x.gross_total = money(x.gross_total + gross); addVat(x.vat, r.vat_breakdown);
    for (const v of Array.isArray(r.vat_breakdown) ? r.vat_breakdown : []) { x.net_total = money(x.net_total + Number(v?.net || 0)); x.vat_total = money(x.vat_total + Number(v?.vat || 0)); }
    if (r.source_type === "WORK_ORDER") x.sources.workorders += 1; else x.sources.retail_sales += 1;
    if (!x.first_receipt_number) x.first_receipt_number = r.receipt_number; x.last_receipt_number = r.receipt_number; map.set(key, x);
  }
  const now = day(new Date());
  return [...map.entries()].map(([key, x]) => { const st = status.get(key), deadlineDate = deadline(x.report_date), reported = st?.status === "REPORTED"; return {
    ...x, vat_breakdown: [...x.vat.values()], sale_vat_breakdown: [...x.sale_vat.values()], modifying_vat_breakdown: [...x.modifying_vat.values()],
    vat: undefined, sale_vat: undefined, modifying_vat: undefined, deadline_days: DEADLINE, deadline_date: deadlineDate,
    overdue: !reported && now > deadlineDate, due_soon: !reported && now <= deadlineDate, status: st?.status || "READY", report_method: st?.report_method || null,
    external_reference: st?.external_reference || null, serial_range_key: null, reported_at: st?.reported_at || null, reported_by: st?.reported_by || null, note: st?.note || null, manual_batch: false,
  }});
}

router.get("/sources", async (req: AuthRequest, res: Response, next) => { try {
  const loc = scope(req, res); if (loc === undefined) return; const to = String(req.query.to || day(new Date())); const d = new Date(); d.setUTCDate(d.getUTCDate() - 14); const from = String(req.query.from || d.toISOString().slice(0, 10)); const rows = await documentRows(from, to, loc); if (!rows.length) return next();
  return res.json({ ok: true, from, to, total: rows.length, rows: rows.map((r: any) => ({source_type:r.source_type,source_id:`${r.source_id}:${r.receipt_number}`,source_number:r.receipt_number,location_id:r.location_id||null,legal_entity_id:r.legal_entity_id||null,legal_entity_name:r.legal_name||r.issuer_name||null,issued_at:r.issued_at,report_date:businessDay(r.issued_at),gross_total:money(r.gross_total),taxable_gross:money(r.gross_total),receipt_eligible:true,exclusion_reason:null,customer_name:r.customer_name||null,vat_lines:Array.isArray(r.vat_breakdown)?r.vat_breakdown:[],receipt_document_type:r.document_type,original_source_id:r.source_id})), actual_receipt_documents: true });
 } catch (e) { next(e); }});

router.get("/daily", async (req: AuthRequest, res: Response, next) => { try {
  const loc = scope(req, res); if (loc === undefined) return; const to = String(req.query.to || day(new Date())); const d = new Date(); d.setUTCDate(d.getUTCDate() - 31); const from = String(req.query.from || d.toISOString().slice(0, 10)); const docs = await documentRows(from, to, loc); if (!docs.length) return next(); await ensureBatch();
  const stored = (await db.query(`SELECT * FROM vir_receipt_report_batches WHERE report_date BETWEEN $1::date AND $2::date AND batch_key LIKE $4 AND ($3::text IS NULL OR location_id=$3)`, [from, to, loc, `${BATCH_PREFIX}:%`])).rows;
  const rows = aggregate(docs, stored).sort((a: any, b: any) => b.report_date.localeCompare(a.report_date)||String(a.legal_entity_name).localeCompare(String(b.legal_entity_name)));
  return res.json({ok:true,from,to,rows,stats:{days:new Set(rows.map((r:any)=>`${r.report_date}|${r.location_id||"*"}|${r.legal_entity_id||"*"}`)).size,batches:rows.length,receipts:rows.reduce((a:number,r:any)=>a+r.receipt_count,0),sale_documents:rows.reduce((a:number,r:any)=>a+r.sale_document_count,0),modifying_documents:rows.reduce((a:number,r:any)=>a+r.modifying_document_count,0),sales_gross_total:money(rows.reduce((a:number,r:any)=>a+r.sales_gross_total,0)),modifying_gross_total:money(rows.reduce((a:number,r:any)=>a+r.modifying_gross_total,0)),gross_total:money(rows.reduce((a:number,r:any)=>a+r.gross_total,0)),overdue_days:rows.filter((r:any)=>r.overdue).length,reported_days:rows.filter((r:any)=>r.status==="REPORTED").length,excluded_as_invoice:0},actual_receipt_documents:true,multi_company:true});
 } catch (e) { next(e); }});

router.post("/daily/:date/mark-reported", async (req: AuthRequest, res: Response, next) => { try {
  const loc = scope(req, res, req.body?.location_id ?? req.body?.locationId); if (loc === undefined) return; const reportDate = String(req.params.date || ""); if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) return res.status(400).json({ ok: false, message: "Érvénytelen tárgynap." }); const method = String(req.body?.report_method || "KOBAK").toUpperCase(); if (method === "M2M") return res.status(409).json({ ok: false, message: "A közvetlen M2M NAV-adapter még nincs aktiválva." });
  const docs = await documentRows(reportDate, reportDate, loc); if (!docs.length) return next(); await ensureBatch(); const all=aggregate(docs,[]); const requestedBatch=String(req.body?.batch_key||''); const summary=all.find((x:any)=>!requestedBatch||x.batch_key===requestedBatch); if (!summary) return res.status(409).json({ok:false,message:"A kiválasztott cég tárgynapi nyugtakötege nem található."});
  const scopeKey = loc || "*", currency = String(req.body?.currency || summary.currency || "HUF").toUpperCase(), ref = String(req.body?.external_reference || "").trim() || null, note = String(req.body?.note || "").trim() || null;
  const q = await db.query(`INSERT INTO vir_receipt_report_batches(scope_key,location_id,legal_entity_id,report_date,currency,batch_key,receipt_source,first_receipt_number,last_receipt_number,status,report_method,external_reference,sale_document_count,modifying_document_count,summary_snapshot,note,reported_at,reported_by,created_by,updated_at) VALUES($1,$2,$3::uuid,$4::date,$5,$6,'COMPUTER',$7,$8,'REPORTED',$9,$10,$11,$12,$13::jsonb,$14,now(),$15,$15,now()) ON CONFLICT(scope_key,report_date,currency,batch_key) DO UPDATE SET legal_entity_id=EXCLUDED.legal_entity_id,status='REPORTED',report_method=EXCLUDED.report_method,external_reference=EXCLUDED.external_reference,first_receipt_number=EXCLUDED.first_receipt_number,last_receipt_number=EXCLUDED.last_receipt_number,sale_document_count=EXCLUDED.sale_document_count,modifying_document_count=EXCLUDED.modifying_document_count,summary_snapshot=EXCLUDED.summary_snapshot,note=EXCLUDED.note,reported_at=now(),reported_by=EXCLUDED.reported_by,updated_at=now() RETURNING *`,[scopeKey,loc,summary.legal_entity_id,reportDate,currency,summary.batch_key,summary.first_receipt_number,summary.last_receipt_number,method,ref,summary.sale_document_count,summary.modifying_document_count,JSON.stringify(summary),note,actor(req)]);
  return res.json({ok:true,report:q.rows[0],summary,actual_receipt_documents:true,multi_company:true});
 } catch (e) { next(e); }});

export default router;
