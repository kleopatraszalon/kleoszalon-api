import { Router, Response } from "express";
import db from "../db";
import { requireAuth, type AuthRequest } from "../middleware/auth";
import { requireRoles } from "../middleware/requireRoles";
import { parseRoleKeys } from "../security/roles";

const router = Router();
router.use(requireAuth);
router.use(requireRoles("admin", "manager", "accounting", "bookkeeper", "location_manager", "salon_manager", "receptionist"));

const EFFECTIVE_FROM = "2026-09-01";
const DEADLINE_DAYS = 3;
const VIR_BATCH_KEY = "VIR_COMPUTER";
const GLOBAL_ROLES = new Set(["admin", "manager", "accounting", "bookkeeper"]);
const REPORTING_MODES = new Set(["KOBAK_MANUAL", "M2M"]);
const RECEIPT_SOURCES = new Set(["COMPUTER", "PAPER", "MIXED"]);

type Settings = {
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
};

type VatLine = { vat_rate_percent: number; vat_category: string; gross: number; net: number; vat: number };
type SourceRow = {
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

const DEFAULTS: Settings = {
  scope_id: "*", effective_from: EFFECTIVE_FROM, enabled: true,
  include_workorders: true, include_retail_sales: true, reporting_mode: "KOBAK_MANUAL",
  receipt_source: "COMPUTER", default_vat_rate_percent: 27, currency: "HUF",
  software_receipt_prefix: "KLEO-NY", paper_receipt_book_code: "", warning_days_before_deadline: 1,
  email_copy_enabled: false, m2m_enabled: false, m2m_environment: "test",
};

let schemaReady: Promise<void> | null = null;
const money = (v: unknown) => Math.round((Number(v) || 0) * 100) / 100;
const dateOnly = (v: unknown) => {
  const d = v instanceof Date ? v : new Date(String(v || ""));
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
};
const cleanDate = (v: unknown, fallback: string) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : fallback;
const ratePct = (v: unknown, fallback = 27) => {
  let n = Number(v); if (!Number.isFinite(n)) n = fallback; if (n > 0 && n <= 1) n *= 100;
  return Math.max(0, Math.min(100, Math.round(n * 1000) / 1000));
};
const categoryFor = (rate: number, raw?: unknown) => {
  const c = String(raw || "").trim().toUpperCase();
  if (["AAM", "TAM", "VAT_27", "VAT_18", "VAT_5", "VAT_0", "OTHER"].includes(c)) return c;
  if (c === "EXEMPT") return "AAM";
  if (Math.abs(rate - 27) < .001) return "VAT_27";
  if (Math.abs(rate - 18) < .001) return "VAT_18";
  if (Math.abs(rate - 5) < .001) return "VAT_5";
  if (Math.abs(rate) < .001) return "VAT_0";
  return "OTHER";
};
function vatLine(grossValue: unknown, rateValue: unknown, categoryValue?: unknown): VatLine {
  const gross = money(grossValue), rate = ratePct(rateValue), category = categoryFor(rate, categoryValue);
  const exempt = category === "AAM" || category === "TAM";
  const net = exempt ? gross : money(gross / (1 + rate / 100));
  return { vat_rate_percent: rate, vat_category: category, gross, net, vat: money(gross - net) };
}
function mergeVat(lines: VatLine[]) {
  const m = new Map<string, VatLine>();
  for (const line of lines) {
    const key = `${line.vat_category}|${line.vat_rate_percent}`;
    const x = m.get(key) || { ...line, gross: 0, net: 0, vat: 0 };
    x.gross = money(x.gross + line.gross); x.net = money(x.net + line.net); x.vat = money(x.vat + line.vat); m.set(key, x);
  }
  return [...m.values()].sort((a,b)=>b.vat_rate_percent-a.vat_rate_percent || a.vat_category.localeCompare(b.vat_category));
}
function deadlineFor(day: string) { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + DEADLINE_DAYS); return d.toISOString().slice(0,10); }
function actor(req: AuthRequest) { return req.user?.email || String(req.user?.id || ""); }
function scope(req: AuthRequest, res: Response, explicit?: unknown): string | null | undefined {
  const requested = String(explicit ?? req.query.locationId ?? req.query.location_id ?? "").trim();
  const roles = parseRoleKeys(req.user?.role);
  if (roles.some(r => GLOBAL_ROLES.has(r))) return requested || null;
  const own = String(req.user?.location_id || "").trim();
  if (!own) { res.status(403).json({ ok:false, message:"A felhasználóhoz nincs telephely rendelve." }); return undefined; }
  if (requested && requested !== own) { res.status(403).json({ ok:false, message:"Másik telephely nyugtaadata nem érhető el." }); return undefined; }
  return own;
}
async function exists(name: string) { return Boolean((await db.query(`SELECT to_regclass($1) IS NOT NULL ok`, [`public.${name}`])).rows[0]?.ok); }

async function ensureSchema() {
  if (!schemaReady) schemaReady = db.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE TABLE IF NOT EXISTS vir_receipt_compliance_settings(
      scope_id text PRIMARY KEY, effective_from date NOT NULL DEFAULT DATE '2026-09-01', enabled boolean NOT NULL DEFAULT true,
      include_workorders boolean NOT NULL DEFAULT true, include_retail_sales boolean NOT NULL DEFAULT true,
      reporting_mode text NOT NULL DEFAULT 'KOBAK_MANUAL', receipt_source text NOT NULL DEFAULT 'COMPUTER',
      default_vat_rate_percent numeric(6,3) NOT NULL DEFAULT 27, currency text NOT NULL DEFAULT 'HUF',
      software_receipt_prefix text NOT NULL DEFAULT 'KLEO-NY', paper_receipt_book_code text NOT NULL DEFAULT '',
      warning_days_before_deadline integer NOT NULL DEFAULT 1, email_copy_enabled boolean NOT NULL DEFAULT false,
      m2m_enabled boolean NOT NULL DEFAULT false, m2m_environment text NOT NULL DEFAULT 'test', updated_by text, updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS vir_receipt_report_batches(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), scope_key text NOT NULL DEFAULT '*', location_id text,
      report_date date NOT NULL, currency text NOT NULL DEFAULT 'HUF', batch_key text NOT NULL,
      receipt_source text NOT NULL DEFAULT 'COMPUTER', serial_range_key text, first_receipt_number text, last_receipt_number text,
      status text NOT NULL DEFAULT 'READY', report_method text, external_reference text,
      sale_document_count integer NOT NULL DEFAULT 0, modifying_document_count integer NOT NULL DEFAULT 0,
      summary_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb, note text, reported_at timestamptz, reported_by text,
      created_by text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(scope_key, report_date, currency, batch_key)
    );
    CREATE INDEX IF NOT EXISTS vir_receipt_report_batches_date_idx ON vir_receipt_report_batches(report_date DESC, scope_key);
  `).then(()=>undefined).catch(e=>{ schemaReady=null; throw e; });
  return schemaReady;
}

async function getSettings(locationId: string | null): Promise<Settings> {
  await ensureSchema(); const key = locationId || "*";
  const row = (await db.query(`SELECT * FROM vir_receipt_compliance_settings WHERE scope_id IN($1,'*') ORDER BY CASE WHEN scope_id=$1 THEN 0 ELSE 1 END LIMIT 1`, [key])).rows[0];
  if (!row) return { ...DEFAULTS, scope_id:key };
  return { ...DEFAULTS, ...row, scope_id:row.scope_id, effective_from:dateOnly(row.effective_from), default_vat_rate_percent:Number(row.default_vat_rate_percent), warning_days_before_deadline:Number(row.warning_days_before_deadline) } as Settings;
}

async function workOrders(from: string, to: string, locationId: string | null, s: Settings): Promise<SourceRow[]> {
  if (!s.include_workorders || !(await exists("work_orders")) || !(await exists("work_order_items"))) return [];
  const q = await db.query(`
    SELECT w.id::text source_id, COALESCE(NULLIF(to_jsonb(w)->>'work_order_number',''),w.id::text) source_number,
      NULLIF(to_jsonb(w)->>'location_id','') location_id,
      COALESCE(NULLIF(to_jsonb(w)->>'financial_closed_at','')::timestamptz,NULLIF(to_jsonb(w)->>'closed_at','')::timestamptz,NULLIF(to_jsonb(w)->>'completed_at','')::timestamptz,NULLIF(to_jsonb(w)->>'updated_at','')::timestamptz,NULLIF(to_jsonb(w)->>'created_at','')::timestamptz,now()) issued_at,
      COALESCE(NULLIF(to_jsonb(w)->>'gross_total','')::numeric,0) gross_total,
      COALESCE(NULLIF(to_jsonb(w)->>'discount_amount','')::numeric,0) discount_amount,
      COALESCE(NULLIF(to_jsonb(w)->>'invoice_status',''),'not_requested') invoice_status,
      COALESCE(NULLIF(to_jsonb(w)->>'payment_status',''),'') payment_status,
      NULLIF(to_jsonb(w)->>'client_name','') customer_name,
      COALESCE(NULLIF(to_jsonb(wi)->>'line_total','')::numeric,0) line_gross,
      COALESCE(NULLIF(to_jsonb(wi)->>'vat_rate','')::numeric,NULLIF(to_jsonb(p)->>'vat_rate','')::numeric,NULLIF(to_jsonb(sv)->>'vat_rate','')::numeric,$4::numeric/100) vat_rate,
      COALESCE(NULLIF(to_jsonb(wi)->>'vat_category',''),NULLIF(to_jsonb(p)->>'vat_category',''),NULLIF(to_jsonb(sv)->>'vat_category','')) vat_category
    FROM work_orders w JOIN work_order_items wi ON wi.work_order_id::text=w.id::text
    LEFT JOIN products p ON p.id::text=NULLIF(to_jsonb(wi)->>'product_id','') LEFT JOIN services sv ON sv.id::text=NULLIF(to_jsonb(wi)->>'service_id','')
    WHERE COALESCE(NULLIF(to_jsonb(w)->>'financial_closed_at','')::timestamptz,NULLIF(to_jsonb(w)->>'closed_at','')::timestamptz,NULLIF(to_jsonb(w)->>'completed_at','')::timestamptz,NULLIF(to_jsonb(w)->>'updated_at','')::timestamptz,NULLIF(to_jsonb(w)->>'created_at','')::timestamptz)::date BETWEEN $1::date AND $2::date
      AND ($3::text IS NULL OR NULLIF(to_jsonb(w)->>'location_id','')=$3::text)
      AND COALESCE(NULLIF(to_jsonb(w)->>'status',''),'') NOT IN('cancelled','no_show') ORDER BY issued_at,w.id`, [from,to,locationId,s.default_vat_rate_percent]);
  const map = new Map<string,any>();
  for (const r of q.rows) {
    const invoice = ["requested","issued","invoiced","invoice_requested","sent","submitted"].includes(String(r.invoice_status).toLowerCase());
    const payment = String(r.payment_status||"").toLowerCase(), notPaid = Boolean(payment && payment !== "paid");
    const x = map.get(r.source_id) || { source_type:"WORK_ORDER", source_id:r.source_id, source_number:r.source_number, location_id:r.location_id||null, issued_at:new Date(r.issued_at).toISOString(), report_date:dateOnly(r.issued_at), gross_total:money(r.gross_total), discount:money(r.discount_amount), receipt_eligible:!(invoice||notPaid), exclusion_reason:invoice?"INVOICE":notPaid?"NOT_PAID":null, customer_name:r.customer_name||null, lines:[] };
    x.lines.push({ gross:money(r.line_gross), rate:r.vat_rate, category:r.vat_category }); map.set(r.source_id,x);
  }
  return [...map.values()].map((x:any)=>{ const raw=money(x.lines.reduce((a:number,l:any)=>a+l.gross,0)), taxable=Math.max(0,money(x.gross_total-x.discount)), scale=raw?taxable/raw:0; return { ...x, taxable_gross:taxable, vat_lines:mergeVat(x.lines.map((l:any)=>vatLine(money(l.gross*scale),l.rate,l.category))), lines:undefined, discount:undefined } as SourceRow; });
}

async function retail(from: string, to: string, locationId: string | null, s: Settings): Promise<SourceRow[]> {
  if (!s.include_retail_sales || !(await exists("retail_sales")) || !(await exists("retail_sale_items"))) return [];
  const q = await db.query(`
    SELECT rs.id::text source_id, NULLIF(to_jsonb(rs)->>'location_id','') location_id,
      COALESCE(NULLIF(to_jsonb(rs)->>'created_at','')::timestamptz,now()) issued_at,
      COALESCE(NULLIF(to_jsonb(rs)->>'gross_total','')::numeric,0) gross_total,
      COALESCE(NULLIF(to_jsonb(rs)->>'invoice_requested','')::boolean,false) invoice_requested,
      COALESCE(NULLIF(to_jsonb(rs)->>'status',''),'paid') sale_status,
      COALESCE(NULLIF(to_jsonb(rs)->>'customer_name',''),NULLIF(to_jsonb(rs)->>'customer_email','')) customer_name,
      COALESCE(NULLIF(to_jsonb(i)->>'gross_amount','')::numeric,0) line_gross,
      COALESCE(NULLIF(to_jsonb(i)->>'vat_rate','')::numeric,NULLIF(to_jsonb(p)->>'vat_rate','')::numeric,$4::numeric/100) vat_rate,
      COALESCE(NULLIF(to_jsonb(i)->>'vat_category',''),NULLIF(to_jsonb(p)->>'vat_category','')) vat_category
    FROM retail_sales rs JOIN retail_sale_items i ON i.sale_id::text=rs.id::text
    LEFT JOIN products p ON p.id::text=NULLIF(to_jsonb(i)->>'product_id','')
    WHERE COALESCE(NULLIF(to_jsonb(rs)->>'created_at','')::timestamptz,now())::date BETWEEN $1::date AND $2::date
      AND ($3::text IS NULL OR NULLIF(to_jsonb(rs)->>'location_id','')=$3::text) ORDER BY issued_at,rs.id`, [from,to,locationId,s.default_vat_rate_percent]);
  const map = new Map<string,any>();
  for (const r of q.rows) {
    const status = String(r.sale_status||"paid").toLowerCase(), excluded = Boolean(r.invoice_requested) || !["paid","completed","closed"].includes(status);
    const x = map.get(r.source_id) || { source_type:"RETAIL_SALE", source_id:r.source_id, source_number:r.source_id, location_id:r.location_id||null, issued_at:new Date(r.issued_at).toISOString(), report_date:dateOnly(r.issued_at), gross_total:money(r.gross_total), taxable_gross:money(r.gross_total), receipt_eligible:!excluded, exclusion_reason:r.invoice_requested?"INVOICE":excluded?"NOT_PAID":null, customer_name:r.customer_name||null, lines:[] };
    x.lines.push(vatLine(r.line_gross,r.vat_rate,r.vat_category)); map.set(r.source_id,x);
  }
  return [...map.values()].map((x:any)=>({ ...x, vat_lines:mergeVat(x.lines), lines:undefined } as SourceRow));
}
async function sources(from:string,to:string,locationId:string|null,s:Settings) { const [a,b]=await Promise.all([workOrders(from,to,locationId,s),retail(from,to,locationId,s)]); return [...a,...b].sort((x,y)=>y.issued_at.localeCompare(x.issued_at)); }
async function batches(from:string,to:string,locationId:string|null) { await ensureSchema(); return (await db.query(`SELECT * FROM vir_receipt_report_batches WHERE report_date BETWEEN $1::date AND $2::date AND ($3::text IS NULL OR location_id=$3::text) ORDER BY report_date DESC,batch_key`,[from,to,locationId])).rows; }

function virDaily(src:SourceRow[], stored:any[], s:Settings) {
  const status = new Map(stored.filter(b=>b.batch_key===VIR_BATCH_KEY).map(b=>[`${dateOnly(b.report_date)}|${b.scope_key}|${b.currency}`,b]));
  const map = new Map<string,any>();
  for (const x of src.filter(x=>x.receipt_eligible)) {
    const currency=s.currency.toUpperCase(), sk=x.location_id||"*", key=`${x.report_date}|${sk}|${currency}`;
    const d=map.get(key)||{report_date:x.report_date,location_id:x.location_id,scope_key:sk,currency,batch_key:VIR_BATCH_KEY,receipt_source:s.receipt_source==='PAPER'?'PAPER':'COMPUTER',receipt_count:0,sale_document_count:0,modifying_document_count:0,gross_total:0,vat_lines:[],sources:{workorders:0,retail_sales:0}};
    d.receipt_count++; d.sale_document_count++; d.gross_total=money(d.gross_total+x.taxable_gross); d.vat_lines.push(...x.vat_lines); if(x.source_type==='WORK_ORDER')d.sources.workorders++;else d.sources.retail_sales++; map.set(key,d);
  }
  const now=dateOnly(new Date());
  return [...map.entries()].map(([key,d])=>{ const vb=mergeVat(d.vat_lines), st=status.get(key), deadline=deadlineFor(d.report_date), reported=st?.status==='REPORTED'; return { ...d, net_total:money(vb.reduce((a,x)=>a+x.net,0)),vat_total:money(vb.reduce((a,x)=>a+x.vat,0)),vat_breakdown:vb,vat_lines:undefined,deadline_days:DEADLINE_DAYS,deadline_date:deadline,overdue:!reported&&now>deadline,due_soon:!reported&&now<=deadline,status:st?.status||'READY',report_method:st?.report_method||null,external_reference:st?.external_reference||null,serial_range_key:st?.serial_range_key||null,first_receipt_number:st?.first_receipt_number||null,last_receipt_number:st?.last_receipt_number||null,reported_at:st?.reported_at||null,reported_by:st?.reported_by||null,note:st?.note||null,manual_batch:false }; });
}
function manualRows(stored:any[]) { const now=dateOnly(new Date()); return stored.filter(b=>b.batch_key!==VIR_BATCH_KEY).map(b=>{const snap=b.summary_snapshot||{},day=dateOnly(b.report_date),deadline=deadlineFor(day),reported=b.status==='REPORTED';return {report_date:day,location_id:b.location_id||null,scope_key:b.scope_key,currency:b.currency,batch_key:b.batch_key,receipt_source:b.receipt_source,receipt_count:Number(b.sale_document_count||0)+Number(b.modifying_document_count||0),sale_document_count:Number(b.sale_document_count||0),modifying_document_count:Number(b.modifying_document_count||0),gross_total:money(snap.gross_total),net_total:money(snap.net_total),vat_total:money(snap.vat_total),vat_breakdown:Array.isArray(snap.vat_breakdown)?snap.vat_breakdown:[],sources:{workorders:0,retail_sales:0},deadline_days:DEADLINE_DAYS,deadline_date:deadline,overdue:!reported&&now>deadline,due_soon:!reported&&now<=deadline,status:b.status,report_method:b.report_method||null,external_reference:b.external_reference||null,serial_range_key:b.serial_range_key||null,first_receipt_number:b.first_receipt_number||null,last_receipt_number:b.last_receipt_number||null,reported_at:b.reported_at||null,reported_by:b.reported_by||null,note:b.note||null,manual_batch:true};}); }

router.get("/settings", async(req:AuthRequest,res:Response)=>{try{const loc=scope(req,res);if(loc===undefined)return;const s=await getSettings(loc);res.json({ok:true,settings:s,legal:{effective_from:EFFECTIVE_FROM,deadline_days:DEADLINE_DAYS,deadline_type:"calendar_days",aggregation:"daily_by_vat_category",paper_batching:"serial_range_and_currency",methods:["KOBAK","M2M"]},m2m:{configured:s.reporting_mode==='M2M'&&s.m2m_enabled,environment:s.m2m_environment,interface_version:"receipt-if 1.0",transport_status:"ADAPTER_NOT_ACTIVATED",message:"Az adatmodell elő van készítve, de közvetlen NAV hálózati beküldés csak külön technikai konfiguráció és UAT után aktiválható."}});}catch(e:any){res.status(500).json({ok:false,message:e?.message||"A nyugta beállítások nem tölthetők be."})}});
router.put("/settings", async(req:AuthRequest,res:Response)=>{try{await ensureSchema();const loc=scope(req,res,req.body?.location_id??req.body?.locationId);if(loc===undefined)return;const mode=String(req.body?.reporting_mode||DEFAULTS.reporting_mode).toUpperCase(),source=String(req.body?.receipt_source||DEFAULTS.receipt_source).toUpperCase();if(!REPORTING_MODES.has(mode)||!RECEIPT_SOURCES.has(source))return res.status(400).json({ok:false,message:"Érvénytelen nyugta vagy adatszolgáltatási mód."});const key=loc||"*";const q=await db.query(`INSERT INTO vir_receipt_compliance_settings(scope_id,effective_from,enabled,include_workorders,include_retail_sales,reporting_mode,receipt_source,default_vat_rate_percent,currency,software_receipt_prefix,paper_receipt_book_code,warning_days_before_deadline,email_copy_enabled,m2m_enabled,m2m_environment,updated_by,updated_at) VALUES($1,$2::date,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now()) ON CONFLICT(scope_id) DO UPDATE SET effective_from=EXCLUDED.effective_from,enabled=EXCLUDED.enabled,include_workorders=EXCLUDED.include_workorders,include_retail_sales=EXCLUDED.include_retail_sales,reporting_mode=EXCLUDED.reporting_mode,receipt_source=EXCLUDED.receipt_source,default_vat_rate_percent=EXCLUDED.default_vat_rate_percent,currency=EXCLUDED.currency,software_receipt_prefix=EXCLUDED.software_receipt_prefix,paper_receipt_book_code=EXCLUDED.paper_receipt_book_code,warning_days_before_deadline=EXCLUDED.warning_days_before_deadline,email_copy_enabled=EXCLUDED.email_copy_enabled,m2m_enabled=EXCLUDED.m2m_enabled,m2m_environment=EXCLUDED.m2m_environment,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING *`,[key,cleanDate(req.body?.effective_from,EFFECTIVE_FROM),req.body?.enabled!==false,req.body?.include_workorders!==false,req.body?.include_retail_sales!==false,mode,source,ratePct(req.body?.default_vat_rate_percent),String(req.body?.currency||'HUF').toUpperCase().slice(0,3),String(req.body?.software_receipt_prefix||'KLEO-NY').slice(0,32),String(req.body?.paper_receipt_book_code||'').slice(0,64),Math.max(0,Math.min(3,Number(req.body?.warning_days_before_deadline??1))),Boolean(req.body?.email_copy_enabled),Boolean(req.body?.m2m_enabled),String(req.body?.m2m_environment||'test')==='live'?'live':'test',actor(req)]);res.json({ok:true,settings:{...q.rows[0],effective_from:dateOnly(q.rows[0].effective_from)}});}catch(e:any){res.status(500).json({ok:false,message:e?.message||"A nyugta beállítások nem menthetők."})}});
router.get("/sources",async(req:AuthRequest,res:Response)=>{try{const loc=scope(req,res);if(loc===undefined)return;const s=await getSettings(loc),d=new Date();d.setUTCDate(d.getUTCDate()-14);const from=cleanDate(req.query.from,d.toISOString().slice(0,10)),to=cleanDate(req.query.to,dateOnly(new Date())),rows=await sources(from,to,loc,s);res.json({ok:true,from,to,rows,total:rows.length});}catch(e:any){res.status(500).json({ok:false,message:e?.message||"A nyugtaforrások nem tölthetők be."})}});
router.get("/daily",async(req:AuthRequest,res:Response)=>{try{const loc=scope(req,res);if(loc===undefined)return;const s=await getSettings(loc),d=new Date();d.setUTCDate(d.getUTCDate()-31);const from=cleanDate(req.query.from,s.effective_from>d.toISOString().slice(0,10)?s.effective_from:d.toISOString().slice(0,10)),to=cleanDate(req.query.to,dateOnly(new Date()));const[src,stored]=await Promise.all([sources(from,to,loc,s),batches(from,to,loc)]),rows=[...virDaily(src,stored,s),...manualRows(stored)].sort((a,b)=>b.report_date.localeCompare(a.report_date)||a.batch_key.localeCompare(b.batch_key));res.json({ok:true,from,to,settings:s,rows,stats:{days:new Set(rows.map(r=>`${r.report_date}|${r.location_id||'*'}`)).size,batches:rows.length,receipts:rows.reduce((a,r)=>a+r.receipt_count,0),gross_total:money(rows.reduce((a,r)=>a+r.gross_total,0)),overdue_days:rows.filter(r=>r.overdue).length,reported_days:rows.filter(r=>r.status==='REPORTED').length,excluded_as_invoice:src.filter(x=>x.exclusion_reason==='INVOICE').length}});}catch(e:any){res.status(500).json({ok:false,message:e?.message||"A napi nyugtaösszesítő nem tölthető be."})}});
router.post("/manual-batches",async(req:AuthRequest,res:Response)=>{try{await ensureSchema();const loc=scope(req,res,req.body?.location_id??req.body?.locationId);if(loc===undefined)return;const day=cleanDate(req.body?.report_date,"");if(!day)return res.status(400).json({ok:false,message:"A tárgynap kötelező."});const currency=String(req.body?.currency||'HUF').toUpperCase().slice(0,3),first=String(req.body?.first_receipt_number||'').trim(),range=String(req.body?.serial_range_key||req.body?.receipt_book_code||first).trim();if(!first||!range)return res.status(400).json({ok:false,message:"A nyugtatömb/sorszámtartomány és a kezdő nyugtasorszám kötelező."});const vb=mergeVat((Array.isArray(req.body?.vat_breakdown)?req.body.vat_breakdown:[]).map((x:any)=>vatLine(x.gross,x.vat_rate_percent??x.rate,x.vat_category??x.category)));const summary={gross_total:money(vb.reduce((a,x)=>a+x.gross,0)),net_total:money(vb.reduce((a,x)=>a+x.net,0)),vat_total:money(vb.reduce((a,x)=>a+x.vat,0)),vat_breakdown:vb};const batchKey=`PAPER:${range}:${first}`.slice(0,180),scopeKey=loc||"*",sale=Math.max(0,Math.floor(Number(req.body?.sale_document_count||0))),mod=Math.max(0,Math.floor(Number(req.body?.modifying_document_count||0)));const q=await db.query(`INSERT INTO vir_receipt_report_batches(scope_key,location_id,report_date,currency,batch_key,receipt_source,serial_range_key,first_receipt_number,last_receipt_number,status,sale_document_count,modifying_document_count,summary_snapshot,note,created_by,updated_at) VALUES($1,$2,$3::date,$4,$5,'PAPER',$6,$7,$8,'READY',$9,$10,$11::jsonb,$12,$13,now()) ON CONFLICT(scope_key,report_date,currency,batch_key) DO UPDATE SET serial_range_key=EXCLUDED.serial_range_key,first_receipt_number=EXCLUDED.first_receipt_number,last_receipt_number=EXCLUDED.last_receipt_number,sale_document_count=EXCLUDED.sale_document_count,modifying_document_count=EXCLUDED.modifying_document_count,summary_snapshot=EXCLUDED.summary_snapshot,note=EXCLUDED.note,status='READY',updated_at=now() RETURNING *`,[scopeKey,loc,day,currency,batchKey,range,first,String(req.body?.last_receipt_number||'').trim()||null,sale,mod,JSON.stringify(summary),String(req.body?.note||'').trim()||null,actor(req)]);res.status(201).json({ok:true,batch:q.rows[0]});}catch(e:any){res.status(500).json({ok:false,message:e?.message||"A papírnyugta-köteg nem menthető."})}});
router.post("/daily/:date/mark-reported",async(req:AuthRequest,res:Response)=>{try{await ensureSchema();const day=cleanDate(req.params.date,"");if(!day)return res.status(400).json({ok:false,message:"Érvénytelen tárgynap."});const loc=scope(req,res,req.body?.location_id??req.body?.locationId);if(loc===undefined)return;const s=await getSettings(loc),method=String(req.body?.report_method||'KOBAK').toUpperCase(),batchKey=String(req.body?.batch_key||VIR_BATCH_KEY),currency=String(req.body?.currency||s.currency).toUpperCase();if(!['KOBAK','M2M'].includes(method))return res.status(400).json({ok:false,message:"Érvénytelen beküldési mód."});if(method==='M2M')return res.status(409).json({ok:false,message:"A közvetlen M2M NAV-adapter még nincs aktiválva; csak tényleges külső/KOBAK teljesítés rögzíthető."});let summary:any,sourceType='COMPUTER',sale=0,mod=0,serial=null,first=null,last=null;if(batchKey===VIR_BATCH_KEY){const src=await sources(day,day,loc,s);summary=virDaily(src,[],s).find(x=>String(x.location_id||'')===String(loc||''));if(!summary)return res.status(409).json({ok:false,message:"A tárgynaphoz nincs jelentendő VIR nyugtaforgalom."});sourceType=summary.receipt_source;sale=summary.sale_document_count;}else{const old=(await db.query(`SELECT * FROM vir_receipt_report_batches WHERE scope_key=$1 AND report_date=$2::date AND currency=$3 AND batch_key=$4`,[loc||'*',day,currency,batchKey])).rows[0];if(!old)return res.status(404).json({ok:false,message:"A nyugtaköteg nem található."});summary=old.summary_snapshot;sourceType=old.receipt_source;sale=Number(old.sale_document_count||0);mod=Number(old.modifying_document_count||0);serial=old.serial_range_key;first=old.first_receipt_number;last=old.last_receipt_number;}const scopeKey=loc||'*';const q=await db.query(`INSERT INTO vir_receipt_report_batches(scope_key,location_id,report_date,currency,batch_key,receipt_source,serial_range_key,first_receipt_number,last_receipt_number,status,report_method,external_reference,sale_document_count,modifying_document_count,summary_snapshot,note,reported_at,reported_by,created_by,updated_at) VALUES($1,$2,$3::date,$4,$5,$6,$7,$8,$9,'REPORTED',$10,$11,$12,$13,$14::jsonb,$15,now(),$16,$16,now()) ON CONFLICT(scope_key,report_date,currency,batch_key) DO UPDATE SET status='REPORTED',report_method=EXCLUDED.report_method,external_reference=EXCLUDED.external_reference,summary_snapshot=EXCLUDED.summary_snapshot,note=EXCLUDED.note,reported_at=now(),reported_by=EXCLUDED.reported_by,updated_at=now() RETURNING *`,[scopeKey,loc,day,currency,batchKey,sourceType,serial,first,last,method,String(req.body?.external_reference||'').trim()||null,sale,mod,JSON.stringify(summary),String(req.body?.note||'').trim()||null,actor(req)]);res.json({ok:true,report:q.rows[0],summary});}catch(e:any){res.status(500).json({ok:false,message:e?.message||"A teljesítés nem rögzíthető."})}});
router.post("/daily/:date/reopen",async(req:AuthRequest,res:Response)=>{try{await ensureSchema();const day=cleanDate(req.params.date,"");if(!day)return res.status(400).json({ok:false,message:"Érvénytelen tárgynap."});const loc=scope(req,res,req.body?.location_id??req.body?.locationId);if(loc===undefined)return;const s=await getSettings(loc),batchKey=String(req.body?.batch_key||VIR_BATCH_KEY),currency=String(req.body?.currency||s.currency).toUpperCase();const q=await db.query(`UPDATE vir_receipt_report_batches SET status='REOPENED',note=$5,updated_at=now() WHERE scope_key=$1 AND report_date=$2::date AND currency=$3 AND batch_key=$4 RETURNING *`,[loc||'*',day,currency,batchKey,String(req.body?.note||'Újranyitva ellenőrzésre')]);res.json({ok:true,report:q.rows[0]||null});}catch(e:any){res.status(500).json({ok:false,message:e?.message||"A nyugtaköteg nem nyitható újra."})}});
router.get("/readiness",async(req:AuthRequest,res:Response)=>{try{const loc=scope(req,res);if(loc===undefined)return;const s=await getSettings(loc);const [wo,wi,rs,ri]=await Promise.all([exists('work_orders'),exists('work_order_items'),exists('retail_sales'),exists('retail_sale_items')]);const checks=[{key:'effective_date',ok:Boolean(s.effective_from),label:'Hatálybalépés beállítva'},{key:'vat_default',ok:s.default_vat_rate_percent>=0,label:'Alap ÁFA-kulcs beállítva'},{key:'workorders',ok:!s.include_workorders||(wo&&wi),label:'Munkalap-forrás elérhető'},{key:'retail',ok:!s.include_retail_sales||(rs&&ri),label:'Termékeladás-forrás elérhető'},{key:'reporting',ok:REPORTING_MODES.has(s.reporting_mode),label:'Adatszolgáltatási mód érvényes'},{key:'m2m_transport',ok:s.reporting_mode!=='M2M',label:'Közvetlen M2M NAV-adapter'}];res.json({ok:true,ready_for_kobak:checks.filter(x=>x.key!=='m2m_transport').every(x=>x.ok),ready_for_m2m_transport:false,m2m_adapter_implemented:false,paper_batches_supported:true,multiple_batches_per_day_supported:true,checks,legal_deadline_days:DEADLINE_DAYS,m2m_interface:'receipt-if 1.0'});}catch(e:any){res.status(500).json({ok:false,message:e?.message||"A készültség nem ellenőrizhető."})}});

export default router;
