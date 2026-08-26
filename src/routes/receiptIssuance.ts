import crypto from "crypto";
import { Router, Response } from "express";
import db from "../db";
import { requireAuth, type AuthRequest } from "../middleware/auth";
import { requireRoles } from "../middleware/requireRoles";
import { parseRoleKeys } from "../security/roles";
import { sendEmail } from "../mailer";
import { generateReceiptPdf, type ReceiptPdfDocument, type ReceiptPdfLine } from "../services/receiptDocumentPdf";
import { reverseFinancialMovement } from "../finance/financialIntegrity";

const router = Router();
router.use(requireAuth);
router.use(requireRoles("admin", "manager", "accounting", "bookkeeper", "location_manager", "salon_manager", "receptionist"));

const GLOBAL_ROLES = new Set(["admin", "manager", "accounting", "bookkeeper"]);
const SOURCE_TYPES = new Set(["WORK_ORDER", "RETAIL_SALE"]);
const money = (v: unknown) => Math.round((Number(v) || 0) * 100) / 100;
const pct = (v: unknown, fallback = 27) => {
  let n = Number(v);
  if (!Number.isFinite(n)) n = fallback;
  if (n > 0 && n <= 1) n *= 100;
  return Math.round(n * 1000) / 1000;
};
const category = (rate: number, raw?: unknown) => {
  const c = String(raw || "").trim().toUpperCase();
  if (["AAM", "TAM", "VAT_27", "VAT_18", "VAT_5", "VAT_0", "OTHER"].includes(c)) return c;
  if (Math.abs(rate - 27) < 0.001) return "VAT_27";
  if (Math.abs(rate - 18) < 0.001) return "VAT_18";
  if (Math.abs(rate - 5) < 0.001) return "VAT_5";
  if (Math.abs(rate) < 0.001) return "VAT_0";
  return "OTHER";
};
const vat = (grossValue: unknown, rateValue: unknown, categoryValue?: unknown) => {
  const gross = money(grossValue), rate = pct(rateValue), vat_category = category(rate, categoryValue);
  const exempt = vat_category === "AAM" || vat_category === "TAM";
  const net = exempt ? gross : money(gross / (1 + rate / 100));
  return { vat_rate_percent: rate, vat_category, gross, net, vat: money(gross - net) };
};
const mergeVat = (lines: Array<ReturnType<typeof vat>>) => {
  const m = new Map<string, ReturnType<typeof vat>>();
  for (const line of lines) {
    const key = `${line.vat_category}|${line.vat_rate_percent}`;
    const x = m.get(key) || { ...line, gross: 0, net: 0, vat: 0 };
    x.gross = money(x.gross + line.gross); x.net = money(x.net + line.net); x.vat = money(x.vat + line.vat); m.set(key, x);
  }
  return [...m.values()];
};
const actor = (req: AuthRequest) => req.user?.email || String(req.user?.id || "");
const validEmail = (v: unknown) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || "").trim());

function scopedLocation(req: AuthRequest, res: Response, explicit?: unknown): string | null | undefined {
  const requested = String(explicit ?? req.query.location_id ?? req.query.locationId ?? "").trim();
  const roles = parseRoleKeys(req.user?.role);
  if (roles.some((r) => GLOBAL_ROLES.has(r))) return requested || null;
  const own = String(req.user?.location_id || "").trim();
  if (!own) { res.status(403).json({ ok: false, message: "A felhasználóhoz nincs telephely rendelve." }); return undefined; }
  if (requested && requested !== own) { res.status(403).json({ ok: false, message: "Másik telephely nyugtája nem kezelhető." }); return undefined; }
  return own;
}

let ready: Promise<void> | null = null;
async function ensureSchema() {
  if (!ready) ready = db.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE TABLE IF NOT EXISTS vir_receipt_sequences(
      sequence_key text PRIMARY KEY,
      last_no bigint NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS vir_receipts(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      location_id text,
      source_type text NOT NULL CHECK(source_type IN ('WORK_ORDER','RETAIL_SALE')),
      source_id text NOT NULL,
      source_number text,
      receipt_number text NOT NULL UNIQUE,
      document_type text NOT NULL CHECK(document_type IN ('SALE','VOID')),
      status text NOT NULL DEFAULT 'ISSUED' CHECK(status IN ('ISSUED','VOIDED')),
      original_receipt_id uuid REFERENCES vir_receipts(id) ON DELETE RESTRICT,
      original_receipt_number text,
      issued_at timestamptz NOT NULL DEFAULT now(),
      issuer_name text NOT NULL,
      issuer_tax_number text NOT NULL,
      issuer_address text NOT NULL,
      currency varchar(3) NOT NULL DEFAULT 'HUF',
      gross_total numeric(14,2) NOT NULL,
      vat_breakdown jsonb NOT NULL DEFAULT '[]'::jsonb,
      line_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
      customer_name text,
      customer_email text,
      correction_reason text,
      document_hash text NOT NULL,
      pdf_sha256 text NOT NULL,
      pdf_data bytea NOT NULL,
      email_sent_at timestamptz,
      email_message_id text,
      created_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      voided_at timestamptz,
      voided_by text,
      void_reason text
    );
    CREATE UNIQUE INDEX IF NOT EXISTS vir_receipts_sale_source_uq ON vir_receipts(source_type,source_id) WHERE document_type='SALE';
    CREATE UNIQUE INDEX IF NOT EXISTS vir_receipts_void_original_uq ON vir_receipts(original_receipt_id) WHERE document_type='VOID';
    CREATE INDEX IF NOT EXISTS vir_receipts_scope_idx ON vir_receipts(location_id,issued_at DESC);
    CREATE TABLE IF NOT EXISTS vir_receipt_events(
      id bigserial PRIMARY KEY,
      receipt_id uuid NOT NULL REFERENCES vir_receipts(id) ON DELETE RESTRICT,
      event_type text NOT NULL,
      actor text,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS receipt_status text NOT NULL DEFAULT 'not_issued';
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS receipt_id uuid;
    ALTER TABLE retail_sales ADD COLUMN IF NOT EXISTS receipt_status text NOT NULL DEFAULT 'not_issued';
    ALTER TABLE retail_sales ADD COLUMN IF NOT EXISTS receipt_id uuid;
  `).then(() => undefined).catch((e) => { ready = null; throw e; });
  return ready;
}

async function issuerConfig(c: any, locationId: string | null) {
  const exists = Boolean((await c.query(`SELECT to_regclass('public.nav_online_invoice_settings') IS NOT NULL ok`)).rows[0]?.ok);
  if (!exists) throw Object.assign(new Error("A NAV/kibocsátói konfiguráció nem érhető el."), { status: 409, code: "ISSUER_CONFIG_MISSING" });
  const cfg = (await c.query(`SELECT * FROM nav_online_invoice_settings WHERE active=true AND ($1::text='' OR location_id::text=$1 OR location_id IS NULL) ORDER BY CASE WHEN location_id::text=$1 THEN 0 ELSE 1 END LIMIT 1`, [locationId || ""])).rows[0];
  if (!cfg) throw Object.assign(new Error("Ehhez a szalonhoz nincs aktív kibocsátói konfiguráció."), { status: 409, code: "ISSUER_CONFIG_MISSING" });
  const address = [cfg.supplier_postal_code, cfg.supplier_city, cfg.supplier_address].filter(Boolean).join(" ");
  if (!cfg.supplier_name || !cfg.supplier_tax_number || !address) throw Object.assign(new Error("A kibocsátó neve, adószáma vagy címe hiányzik a NAV-beállításokból."), { status: 409, code: "ISSUER_CONFIG_INCOMPLETE" });
  return { name: String(cfg.supplier_name), tax: String(cfg.supplier_tax_number), address, defaultVat: pct(cfg.default_vat_rate ?? 0.27) };
}

async function receiptPrefix(c: any, locationId: string | null) {
  const exists = Boolean((await c.query(`SELECT to_regclass('public.vir_receipt_compliance_settings') IS NOT NULL ok`)).rows[0]?.ok);
  if (!exists) return "KLEO-NY";
  const row = (await c.query(`SELECT software_receipt_prefix FROM vir_receipt_compliance_settings WHERE scope_id IN($1,'*') ORDER BY CASE WHEN scope_id=$1 THEN 0 ELSE 1 END LIMIT 1`, [locationId || "*"])).rows[0];
  return String(row?.software_receipt_prefix || "KLEO-NY").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24) || "KLEO-NY";
}
async function nextNumber(c: any, locationId: string | null) {
  const prefix = await receiptPrefix(c, locationId), year = new Date().getFullYear(), key = `${prefix}:${year}`;
  await c.query(`INSERT INTO vir_receipt_sequences(sequence_key,last_no) VALUES($1,0) ON CONFLICT(sequence_key) DO NOTHING`, [key]);
  const no = Number((await c.query(`UPDATE vir_receipt_sequences SET last_no=last_no+1,updated_at=now() WHERE sequence_key=$1 RETURNING last_no`, [key])).rows[0].last_no);
  return `${prefix}-${year}-${String(no).padStart(6, "0")}`;
}

async function loadSource(c: any, sourceType: string, sourceId: string, fallbackVat: number) {
  if (sourceType === "WORK_ORDER") {
    const wo = (await c.query(`SELECT w.*,to_jsonb(w) j FROM work_orders w WHERE w.id::text=$1 FOR UPDATE`, [sourceId])).rows[0];
    if (!wo) throw Object.assign(new Error("A munkalap nem található."), { status: 404 });
    const j = wo.j || wo;
    const payment = String(j.payment_status || "").toLowerCase();
    if (payment !== "paid" && !j.fully_paid) throw Object.assign(new Error("Nyugta csak teljesen kifizetett munkalapból állítható ki."), { status: 409 });
    if (["requested","issued","invoiced","invoice_requested","sent","submitted"].includes(String(j.invoice_status || "").toLowerCase())) throw Object.assign(new Error("A munkalaphoz számla tartozik vagy számla készült; nyugta nem állítható ki."), { status: 409 });
    const rows = (await c.query(`SELECT wi.*,to_jsonb(wi) j FROM work_order_items wi WHERE wi.work_order_id::text=$1 ORDER BY wi.created_at,wi.id`, [sourceId])).rows;
    if (!rows.length) throw Object.assign(new Error("A munkalapon nincs nyugtázható tétel."), { status: 409 });
    const raw = rows.map((r: any) => { const x = r.j || r; return { description: String(x.item_name || "Tétel"), quantity: Number(x.quantity || 1), gross: money(x.line_total || 0), rate: pct(x.vat_rate, fallbackVat), category: x.vat_category }; });
    const rawTotal = money(raw.reduce((a: number, x: any) => a + x.gross, 0)), target = Math.max(0, money(Number(j.gross_total || rawTotal) - Number(j.discount_amount || 0)));
    let allocated = 0;
    const lines = raw.map((x: any, i: number) => { const gross = i === raw.length - 1 ? money(target - allocated) : money(rawTotal ? x.gross * target / rawTotal : 0); allocated = money(allocated + gross); return { ...x, gross }; });
    return { location_id: String(j.location_id || "") || null, source_number: String(j.work_order_number || wo.id), customer_name: String(j.client_name || "") || null, customer_email: String(j.client_email || "") || null, gross_total: target, lines };
  }

  const sale = (await c.query(`SELECT rs.*,to_jsonb(rs) j FROM retail_sales rs WHERE rs.id::text=$1 FOR UPDATE`, [sourceId])).rows[0];
  if (!sale) throw Object.assign(new Error("A termékeladás nem található."), { status: 404 });
  const j = sale.j || sale;
  if (Boolean(j.invoice_requested) || j.finance_invoice_id) throw Object.assign(new Error("A termékeladáshoz számla tartozik; nyugta nem állítható ki."), { status: 409 });
  if (!["paid","completed","closed"].includes(String(j.status || "paid").toLowerCase())) throw Object.assign(new Error("Nyugta csak lezárt/kifizetett termékeladásból állítható ki."), { status: 409 });
  const rows = (await c.query(`SELECT i.*,to_jsonb(i) j,to_jsonb(p) p FROM retail_sale_items i LEFT JOIN products p ON p.id::text=NULLIF(to_jsonb(i)->>'product_id','') WHERE i.sale_id::text=$1 ORDER BY i.created_at,i.id`, [sourceId])).rows;
  if (!rows.length) throw Object.assign(new Error("A termékeladásban nincs nyugtázható tétel."), { status: 409 });
  const lines = rows.map((r: any) => { const x = r.j || r, p = r.p || {}; return { description: String(x.product_name || p.name || "Termék"), quantity: Number(x.quantity || 1), gross: money(x.gross_amount || 0), rate: pct(x.vat_rate ?? p.vat_rate, fallbackVat), category: x.vat_category ?? p.vat_category }; });
  return { location_id: String(j.location_id || "") || null, source_number: String(j.sale_number || sale.id), customer_name: String(j.customer_name || "") || null, customer_email: String(j.customer_email || "") || null, gross_total: money(j.gross_total || lines.reduce((a: number, x: any) => a + x.gross, 0)), lines };
}

function snapshotFor(sourceType: string, sourceId: string, source: any, issuer: any, receiptNumber: string, issuedAt: string, documentType: "SALE" | "VOID", original?: any, reason?: string) {
  const sign = documentType === "VOID" ? -1 : 1;
  const pdfLines: ReceiptPdfLine[] = source.lines.map((x: any) => ({ description: x.description, quantity: x.quantity, gross: money(sign * x.gross), vat_rate_percent: x.rate, vat_category: category(x.rate, x.category) }));
  const vatBreakdown = mergeVat(source.lines.map((x: any) => vat(sign * x.gross, x.rate, x.category)));
  const grossTotal = money(sign * source.gross_total);
  const base = { source_type: sourceType, source_id: sourceId, source_number: source.source_number, receipt_number: receiptNumber, document_type: documentType, issued_at: issuedAt, issuer_name: issuer.name, issuer_tax_number: issuer.tax, issuer_address: issuer.address, currency: "HUF", gross_total: grossTotal, vat_breakdown: vatBreakdown, lines: pdfLines, customer_name: source.customer_name, customer_email: source.customer_email, original_receipt_number: original?.receipt_number || null, correction_reason: reason || null };
  const document_hash = crypto.createHash("sha256").update(JSON.stringify(base)).digest("hex");
  return { ...base, document_hash };
}
async function event(c: any, receiptId: string, type: string, who: string, payload: any = {}) {
  await c.query(`INSERT INTO vir_receipt_events(receipt_id,event_type,actor,payload) VALUES($1,$2,$3,$4::jsonb)`, [receiptId, type, who, JSON.stringify(payload)]);
}
async function getReceipt(c: any, id: string) {
  return (await c.query(`SELECT id,location_id,source_type,source_id,source_number,receipt_number,document_type,status,original_receipt_id,original_receipt_number,issued_at,issuer_name,issuer_tax_number,issuer_address,currency,gross_total,vat_breakdown,line_snapshot,customer_name,customer_email,correction_reason,document_hash,pdf_sha256,email_sent_at,email_message_id,created_by,created_at,voided_at,voided_by,void_reason FROM vir_receipts WHERE id=$1::uuid`, [id])).rows[0] || null;
}
async function mailReceipt(receipt: any, pdf: Buffer, to: string) {
  const kind = receipt.document_type === "VOID" ? "érvénytelenítő nyugta" : "nyugta";
  return sendEmail({
    to,
    subject: `Kleopátra – ${kind} ${receipt.receipt_number}`,
    text: `Kedves Vendég!\n\nCsatolva küldjük a ${receipt.receipt_number} számú ${kind} PDF példányát.\n\nÜdvözlettel:\nKleopátra Szépségszalonok`,
    html: `<p>Kedves Vendég!</p><p>Csatolva küldjük a <b>${receipt.receipt_number}</b> számú ${kind} PDF példányát.</p><p>Üdvözlettel:<br/>Kleopátra Szépségszalonok</p>`,
    attachments: [{ filename: `${receipt.receipt_number}.pdf`, content: pdf, contentType: "application/pdf" }],
  });
}

router.get("/documents", async (req: AuthRequest, res) => {
  try {
    await ensureSchema(); const loc = scopedLocation(req, res); if (loc === undefined) return;
    const params: any[] = []; let where = "WHERE 1=1";
    if (loc) { params.push(loc); where += ` AND location_id=$${params.length}`; }
    if (req.query.status) { params.push(String(req.query.status)); where += ` AND status=$${params.length}`; }
    const rows = (await db.query(`SELECT id,location_id,source_type,source_id,source_number,receipt_number,document_type,status,original_receipt_number,issued_at,currency,gross_total,customer_name,customer_email,email_sent_at,voided_at,void_reason FROM vir_receipts ${where} ORDER BY issued_at DESC LIMIT 300`, params)).rows;
    res.json({ ok: true, rows });
  } catch (e: any) { res.status(500).json({ ok: false, message: e?.message || "A nyugták nem tölthetők be." }); }
});

router.post("/documents/issue", async (req: AuthRequest, res) => {
  const c = await db.connect(); let result: any = null;
  try {
    await ensureSchema(); const sourceType = String(req.body?.source_type || "").toUpperCase(), sourceId = String(req.body?.source_id || "").trim();
    if (!SOURCE_TYPES.has(sourceType) || !sourceId) return res.status(400).json({ ok: false, message: "A forrástípus és forrásazonosító kötelező." });
    const loc = scopedLocation(req, res, req.body?.location_id); if (loc === undefined) return;
    await c.query("BEGIN");
    const existing = (await c.query(`SELECT id FROM vir_receipts WHERE source_type=$1 AND source_id=$2 AND document_type='SALE' FOR UPDATE`, [sourceType, sourceId])).rows[0];
    if (existing) { await c.query("COMMIT"); return res.json({ ok: true, receipt: await getReceipt(db, existing.id), idempotent: true }); }
    const preliminaryIssuer = await issuerConfig(c, loc), source = await loadSource(c, sourceType, sourceId, preliminaryIssuer.defaultVat);
    if (loc && source.location_id && loc !== source.location_id) throw Object.assign(new Error("A forrás másik telephelyhez tartozik."), { status: 403 });
    const issuer = await issuerConfig(c, source.location_id || loc), receiptNumber = await nextNumber(c, source.location_id || loc), issuedAt = new Date().toISOString();
    const snap = snapshotFor(sourceType, sourceId, source, issuer, receiptNumber, issuedAt, "SALE");
    const pdf = await generateReceiptPdf(snap as ReceiptPdfDocument), pdfHash = crypto.createHash("sha256").update(pdf).digest("hex");
    const recipient = String(req.body?.customer_email || source.customer_email || "").trim();
    result = (await c.query(`INSERT INTO vir_receipts(location_id,source_type,source_id,source_number,receipt_number,document_type,status,issued_at,issuer_name,issuer_tax_number,issuer_address,currency,gross_total,vat_breakdown,line_snapshot,customer_name,customer_email,document_hash,pdf_sha256,pdf_data,created_by) VALUES($1,$2,$3,$4,$5,'SALE','ISSUED',$6,$7,$8,$9,'HUF',$10,$11::jsonb,$12::jsonb,$13,$14,$15,$16,$17,$18) RETURNING id`, [source.location_id || loc, sourceType, sourceId, source.source_number, receiptNumber, issuedAt, issuer.name, issuer.tax, issuer.address, source.gross_total, JSON.stringify(snap.vat_breakdown), JSON.stringify(snap.lines), source.customer_name, recipient || null, snap.document_hash, pdfHash, pdf, actor(req)])).rows[0];
    await event(c, result.id, "ISSUED", actor(req), { source_type: sourceType, source_id: sourceId, pdf_sha256: pdfHash });
    if (sourceType === "WORK_ORDER") await c.query(`UPDATE work_orders SET receipt_status='issued',receipt_id=$2::uuid WHERE id::text=$1`, [sourceId, result.id]);
    else await c.query(`UPDATE retail_sales SET receipt_status='issued',receipt_id=$2::uuid WHERE id::text=$1`, [sourceId, result.id]);
    await c.query("COMMIT");
    const receipt = await getReceipt(db, result.id);
    let delivery: any = null;
    if (req.body?.send_email === true) {
      if (!validEmail(recipient)) return res.status(201).json({ ok: true, receipt, delivery: { sent: false, error: "Érvényes ügyfél e-mail-cím nincs megadva." } });
      try {
        delivery = await mailReceipt(receipt, pdf, recipient);
        if (delivery.sent) await db.query(`UPDATE vir_receipts SET email_sent_at=now(),email_message_id=$2 WHERE id=$1`, [result.id, delivery.messageId || null]);
        await event(db, result.id, "EMAIL_SENT", actor(req), { to: recipient, sent: Boolean(delivery.sent), message_id: delivery.messageId || null });
      } catch (mailError: any) { delivery = { sent: false, error: String(mailError?.message || mailError) }; }
    }
    return res.status(201).json({ ok: true, receipt: await getReceipt(db, result.id), delivery });
  } catch (e: any) {
    await c.query("ROLLBACK").catch(() => undefined);
    const status = Number(e?.status || 500); return res.status(status >= 400 && status < 600 ? status : 500).json({ ok: false, code: e?.code || "RECEIPT_ISSUE_FAILED", message: e?.message || "A nyugta nem állítható ki." });
  } finally { c.release(); }
});

router.get("/documents/:id/pdf", async (req: AuthRequest, res) => {
  try {
    await ensureSchema(); const row = (await db.query(`SELECT id,location_id,receipt_number,pdf_data FROM vir_receipts WHERE id=$1::uuid`, [req.params.id])).rows[0];
    if (!row) return res.status(404).json({ ok: false, message: "A nyugta nem található." });
    const loc = scopedLocation(req, res, row.location_id); if (loc === undefined) return; if (loc && loc !== String(row.location_id || "")) return res.status(403).json({ ok: false, message: "Másik telephely nyugtája nem érhető el." });
    res.setHeader("Content-Type", "application/pdf"); res.setHeader("Content-Disposition", `inline; filename="${row.receipt_number}.pdf"`); return res.send(Buffer.from(row.pdf_data));
  } catch (e: any) { return res.status(500).json({ ok: false, message: e?.message || "A PDF nem tölthető le." }); }
});

router.post("/documents/:id/send", async (req: AuthRequest, res) => {
  try {
    await ensureSchema(); const raw = (await db.query(`SELECT * FROM vir_receipts WHERE id=$1::uuid`, [req.params.id])).rows[0]; if (!raw) return res.status(404).json({ ok: false, message: "A nyugta nem található." });
    const loc = scopedLocation(req, res, raw.location_id); if (loc === undefined) return; if (loc && loc !== String(raw.location_id || "")) return res.status(403).json({ ok: false, message: "Másik telephely nyugtája nem küldhető." });
    const to = String(req.body?.email || raw.customer_email || "").trim(); if (!validEmail(to)) return res.status(400).json({ ok: false, message: "Érvényes e-mail-cím szükséges." });
    const delivery = await mailReceipt(raw, Buffer.from(raw.pdf_data), to);
    if (delivery.sent) await db.query(`UPDATE vir_receipts SET customer_email=$2,email_sent_at=now(),email_message_id=$3 WHERE id=$1`, [raw.id, to, delivery.messageId || null]);
    await event(db, raw.id, "EMAIL_SENT", actor(req), { to, sent: Boolean(delivery.sent), message_id: delivery.messageId || null });
    return res.json({ ok: true, delivery, receipt: await getReceipt(db, raw.id) });
  } catch (e: any) { return res.status(500).json({ ok: false, message: e?.message || "A nyugta e-mailben nem küldhető." }); }
});

router.post("/documents/:id/void", async (req: AuthRequest, res) => {
  const c = await db.connect();
  try {
    await ensureSchema(); const reason = String(req.body?.reason || "").trim(); if (reason.length < 3) return res.status(400).json({ ok: false, message: "A sztornó indoka legalább 3 karakter." });
    await c.query("BEGIN");
    const original = (await c.query(`SELECT * FROM vir_receipts WHERE id=$1::uuid FOR UPDATE`, [req.params.id])).rows[0];
    if (!original) { await c.query("ROLLBACK"); return res.status(404).json({ ok: false, message: "A nyugta nem található." }); }
    if (original.document_type !== "SALE") throw Object.assign(new Error("Érvénytelenítő nyugta nem sztornózható."), { status: 409 });
    const loc = scopedLocation(req, res, original.location_id); if (loc === undefined) { await c.query("ROLLBACK"); return; }
    const existingVoid = (await c.query(`SELECT id FROM vir_receipts WHERE original_receipt_id=$1::uuid AND document_type='VOID' FOR UPDATE`, [original.id])).rows[0];
    if (existingVoid) { await c.query("COMMIT"); return res.json({ ok: true, original: await getReceipt(db, original.id), void_receipt: await getReceipt(db, existingVoid.id), idempotent: true }); }

    const reverseFinancial = req.body?.reverse_financial !== false;
    if (reverseFinancial && original.source_type === "WORK_ORDER") {
      const payments = (await c.query(`SELECT id,amount,financial_movement_id FROM work_order_payments WHERE work_order_id::text=$1 ORDER BY id FOR UPDATE`, [original.source_id])).rows;
      const unsupported = payments.filter((p: any) => money(p.amount) > 0 && !p.financial_movement_id);
      if (unsupported.length) throw Object.assign(new Error("A munkalapon előrefizetés/utalvány vagy főkönyvhöz nem kötött fizetés van. Automatikus pénzügyi sztornó helyett válassza a csak-bizonylat sztornót, majd rendezze a visszatérítést külön."), { status: 409, code: "RECEIPT_FINANCIAL_REVERSAL_UNSUPPORTED" });
      for (const p of payments) if (p.financial_movement_id) await reverseFinancialMovement(c, { movementId: String(p.financial_movement_id), actor: actor(req), reason: `Nyugta sztornó ${original.receipt_number}: ${reason}`, locationId: original.location_id, includeFees: true });
      await c.query(`UPDATE work_orders SET payment_status='unpaid',fully_paid=false,amount_paid=0,financial_closed_at=NULL,receipt_status='voided' WHERE id::text=$1`, [original.source_id]);
    } else if (reverseFinancial && original.source_type === "RETAIL_SALE") {
      throw Object.assign(new Error("A termékeladás automatikus pénzügyi visszafordítása még nem biztonságos a jelenlegi retail főkönyvi modellben. A bizonylat sztornóhoz küldje reverse_financial=false értékkel, a pénzvisszatérítést külön pénzügyi műveletként rögzítse."), { status: 409, code: "RETAIL_REVERSAL_MANUAL_REQUIRED" });
    }

    const issuer = { name: original.issuer_name, tax: original.issuer_tax_number, address: original.issuer_address };
    const source = { source_number: original.source_number, customer_name: original.customer_name, customer_email: original.customer_email, gross_total: Math.abs(Number(original.gross_total)), lines: (original.line_snapshot || []).map((x: any) => ({ description: x.description, quantity: x.quantity, gross: Math.abs(Number(x.gross)), rate: Number(x.vat_rate_percent), category: x.vat_category })) };
    const receiptNumber = await nextNumber(c, original.location_id), issuedAt = new Date().toISOString(), snap = snapshotFor(original.source_type, original.source_id, source, issuer, receiptNumber, issuedAt, "VOID", original, reason);
    const pdf = await generateReceiptPdf(snap as ReceiptPdfDocument), pdfHash = crypto.createHash("sha256").update(pdf).digest("hex");
    const voidId = (await c.query(`INSERT INTO vir_receipts(location_id,source_type,source_id,source_number,receipt_number,document_type,status,original_receipt_id,original_receipt_number,issued_at,issuer_name,issuer_tax_number,issuer_address,currency,gross_total,vat_breakdown,line_snapshot,customer_name,customer_email,correction_reason,document_hash,pdf_sha256,pdf_data,created_by) VALUES($1,$2,$3,$4,$5,'VOID','ISSUED',$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16,$17,$18,$19,$20,$21,$22) RETURNING id`, [original.location_id, original.source_type, original.source_id, original.source_number, receiptNumber, original.id, original.receipt_number, issuedAt, issuer.name, issuer.tax, issuer.address, original.currency, snap.gross_total, JSON.stringify(snap.vat_breakdown), JSON.stringify(snap.lines), original.customer_name, original.customer_email, reason, snap.document_hash, pdfHash, pdf, actor(req)])).rows[0].id;
    await c.query(`UPDATE vir_receipts SET status='VOIDED',voided_at=now(),voided_by=$2,void_reason=$3 WHERE id=$1`, [original.id, actor(req), reason]);
    if (original.source_type === "RETAIL_SALE") await c.query(`UPDATE retail_sales SET receipt_status='voided' WHERE id::text=$1`, [original.source_id]);
    await event(c, original.id, "VOIDED", actor(req), { void_receipt_id: voidId, reason, reverse_financial: reverseFinancial });
    await event(c, voidId, "ISSUED", actor(req), { original_receipt_id: original.id, reason });
    await c.query("COMMIT");

    let delivery: any = null;
    const voidReceipt = await getReceipt(db, voidId);
    if (req.body?.send_email === true && validEmail(voidReceipt?.customer_email)) {
      try { delivery = await mailReceipt(voidReceipt, pdf, voidReceipt.customer_email); if (delivery.sent) await db.query(`UPDATE vir_receipts SET email_sent_at=now(),email_message_id=$2 WHERE id=$1`, [voidId, delivery.messageId || null]); } catch (e: any) { delivery = { sent: false, error: String(e?.message || e) }; }
    }
    return res.status(201).json({ ok: true, original: await getReceipt(db, original.id), void_receipt: await getReceipt(db, voidId), financial_reversed: reverseFinancial && original.source_type === "WORK_ORDER", delivery });
  } catch (e: any) {
    await c.query("ROLLBACK").catch(() => undefined); const status = Number(e?.status || 500); return res.status(status >= 400 && status < 600 ? status : 500).json({ ok: false, code: e?.code || "RECEIPT_VOID_FAILED", message: e?.message || "A nyugta sztornója sikertelen." });
  } finally { c.release(); }
});

router.get("/documents/:id/events", async (req: AuthRequest, res) => {
  try { await ensureSchema(); const receipt = await getReceipt(db, req.params.id); if (!receipt) return res.status(404).json({ ok: false, message: "A nyugta nem található." }); const loc = scopedLocation(req, res, receipt.location_id); if (loc === undefined) return; const rows = (await db.query(`SELECT event_type,actor,payload,created_at FROM vir_receipt_events WHERE receipt_id=$1::uuid ORDER BY id`, [req.params.id])).rows; return res.json({ ok: true, rows }); }
  catch (e: any) { return res.status(500).json({ ok: false, message: e?.message || "Az auditnapló nem tölthető be." }); }
});

export default router;
