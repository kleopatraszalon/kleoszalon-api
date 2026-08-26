import crypto from "crypto";
import { Router, Response } from "express";
import db from "../db";
import { requireAuth, type AuthRequest } from "../middleware/auth";
import { requireRoles } from "../middleware/requireRoles";
import { parseRoleKeys } from "../security/roles";
import { sendEmail } from "../mailer";
import { generateReceiptPdf, type ReceiptPdfDocument, type ReceiptPdfLine } from "../services/receiptDocumentPdf";
import { ensureFinanceNav } from "../finance/ensureFinanceNav";

const router = Router();
router.use(requireAuth);
router.use(requireRoles("admin", "manager", "accounting", "bookkeeper", "location_manager", "salon_manager", "receptionist"));

const GLOBAL = new Set(["admin", "manager", "accounting", "bookkeeper"]);
const money = (v: unknown) => Math.round(Number(v || 0) * 100) / 100;
const pct = (v: unknown, fallback = 27) => {
  let n = Number(v);
  if (!Number.isFinite(n)) n = fallback;
  if (n > 0 && n <= 1) n *= 100;
  return Math.round(n * 1000) / 1000;
};
const vatCategory = (rate: number, raw?: unknown) => {
  const c = String(raw || "").trim().toUpperCase();
  if (["AAM", "TAM", "VAT_27", "VAT_18", "VAT_5", "VAT_0", "OTHER"].includes(c)) return c;
  if (Math.abs(rate - 27) < 0.001) return "VAT_27";
  if (Math.abs(rate - 18) < 0.001) return "VAT_18";
  if (Math.abs(rate - 5) < 0.001) return "VAT_5";
  if (Math.abs(rate) < 0.001) return "VAT_0";
  return "OTHER";
};
const vatLine = (grossValue: unknown, rateValue: unknown, categoryValue?: unknown) => {
  const gross = money(grossValue), rate = pct(rateValue), category = vatCategory(rate, categoryValue);
  const exempt = category === "AAM" || category === "TAM";
  const net = exempt ? gross : money(gross / (1 + rate / 100));
  return { vat_rate_percent: rate, vat_category: category, gross, net, vat: money(gross - net) };
};
const mergeVat = (lines: ReturnType<typeof vatLine>[]) => {
  const map = new Map<string, ReturnType<typeof vatLine>>();
  for (const line of lines) {
    const key = `${line.vat_category}|${line.vat_rate_percent}`;
    const current = map.get(key) || { ...line, gross: 0, net: 0, vat: 0 };
    current.gross = money(current.gross + line.gross);
    current.net = money(current.net + line.net);
    current.vat = money(current.vat + line.vat);
    map.set(key, current);
  }
  return [...map.values()];
};
const actor = (req: AuthRequest) => req.user?.email || String(req.user?.id || "");
const validEmail = (v: unknown) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || "").trim());

function scope(req: AuthRequest, res: Response, explicit?: unknown): string | null | undefined {
  const requested = String(explicit ?? "").trim();
  const roles = parseRoleKeys(req.user?.role);
  if (roles.some(role => GLOBAL.has(role))) return requested || null;
  const own = String(req.user?.location_id || "").trim();
  if (!own) {
    res.status(403).json({ ok: false, message: "A felhasználóhoz nincs szalon rendelve." });
    return undefined;
  }
  if (requested && requested !== own) {
    res.status(403).json({ ok: false, message: "Másik szalon nyugtája nem kezelhető." });
    return undefined;
  }
  return own;
}

async function ensureReceiptSchema() {
  await ensureFinanceNav();
  await db.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE TABLE IF NOT EXISTS vir_receipt_sequences(
      sequence_key text PRIMARY KEY,
      last_no bigint NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS vir_receipts(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      location_id text,
      legal_entity_id uuid REFERENCES legal_entities(id) ON DELETE RESTRICT,
      source_type text NOT NULL,
      source_id text NOT NULL,
      source_number text,
      receipt_number text NOT NULL UNIQUE,
      document_type text NOT NULL DEFAULT 'SALE',
      status text NOT NULL DEFAULT 'ISSUED',
      original_receipt_id uuid REFERENCES vir_receipts(id) ON DELETE RESTRICT,
      original_receipt_number text,
      issued_at timestamptz NOT NULL DEFAULT now(),
      issuer_name text NOT NULL,
      issuer_tax_number text NOT NULL,
      issuer_address text NOT NULL,
      currency text NOT NULL DEFAULT 'HUF',
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
    ALTER TABLE vir_receipts ADD COLUMN IF NOT EXISTS legal_entity_id uuid REFERENCES legal_entities(id) ON DELETE RESTRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS vir_receipts_sale_source_uq ON vir_receipts(source_type,source_id) WHERE document_type='SALE';
    CREATE UNIQUE INDEX IF NOT EXISTS vir_receipts_void_original_uq ON vir_receipts(original_receipt_id) WHERE document_type='VOID';
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
  `);
}

async function entityFor(c: any, id: string | null, locationId: string | null, issuerTax?: string | null) {
  let row: any = null;
  if (id) {
    row = (await c.query(`
      SELECT e.* FROM legal_entities e
      JOIN legal_entity_locations el ON el.legal_entity_id=e.id
      WHERE e.id=$1::uuid AND e.active=true AND el.active=true
        AND ($2::text IS NULL OR el.location_id::text=$2)
      LIMIT 1`, [id, locationId])).rows[0];
  }
  if (!row && issuerTax) {
    row = (await c.query(`SELECT * FROM legal_entities WHERE tax_number=$1 AND active=true ORDER BY created_at LIMIT 1`, [String(issuerTax).replace(/\D/g, "").slice(0, 11)])).rows[0];
  }
  if (!row) throw Object.assign(new Error("A nyugtához tartozó kibocsátó cég nem található vagy nem aktív."), { status: 409 });
  return {
    id: String(row.id),
    name: String(row.legal_name),
    tax: String(row.tax_number),
    address: [row.registered_postal_code, row.registered_city, row.registered_address_line].filter(Boolean).join(" "),
    currency: String(row.currency || "HUF"),
    defaultVat: Number(row.default_vat_rate || 27),
    prefix: String(row.receipt_prefix || "KLEO-NY").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24) || "KLEO-NY",
  };
}

async function nextNumber(c: any, entity: any) {
  const year = new Date().getFullYear();
  const key = `${entity.id}:${entity.prefix}:${year}`;
  await c.query(`INSERT INTO vir_receipt_sequences(sequence_key,last_no) VALUES($1,0) ON CONFLICT(sequence_key) DO NOTHING`, [key]);
  const no = Number((await c.query(`UPDATE vir_receipt_sequences SET last_no=last_no+1,updated_at=now() WHERE sequence_key=$1 RETURNING last_no`, [key])).rows[0].last_no);
  return `${entity.prefix}-${year}-${String(no).padStart(6, "0")}`;
}

async function event(c: any, receiptId: string, type: string, req: AuthRequest, payload: any = {}) {
  await c.query(`INSERT INTO vir_receipt_events(receipt_id,event_type,actor,payload) VALUES($1::uuid,$2,$3,$4::jsonb)`, [receiptId, type, actor(req), JSON.stringify(payload)]);
}

async function receiptRow(c: any, id: string) {
  return (await c.query(`
    SELECT id::text,location_id,legal_entity_id::text,source_type,source_id,source_number,receipt_number,
           document_type,status,original_receipt_id::text,original_receipt_number,issued_at,
           issuer_name,issuer_tax_number,issuer_address,currency,gross_total,vat_breakdown,line_snapshot,
           customer_name,customer_email,correction_reason,document_hash,pdf_sha256,email_sent_at,email_message_id,
           created_by,created_at,voided_at,voided_by,void_reason
      FROM vir_receipts WHERE id=$1::uuid`, [id])).rows[0] || null;
}

async function mailReceipt(receipt: any, pdf: Buffer, to: string) {
  const kind = receipt.document_type === "VOID" ? "érvénytelenítő nyugta" : "nyugta";
  return sendEmail({
    to,
    subject: `${receipt.issuer_name} – ${kind} ${receipt.receipt_number}`,
    text: `Kedves Vendég!\n\nCsatolva küldjük a ${receipt.receipt_number} számú ${kind} PDF példányát.\n\nÜdvözlettel:\n${receipt.issuer_name}`,
    html: `<p>Kedves Vendég!</p><p>Csatolva küldjük a <b>${receipt.receipt_number}</b> számú ${kind} PDF példányát.</p><p>Üdvözlettel:<br/>${receipt.issuer_name}</p>`,
    attachments: [{ filename: `${receipt.receipt_number}.pdf`, content: pdf, contentType: "application/pdf" }],
  });
}

async function loadSource(c: any, type: string, id: string) {
  if (type === "WORK_ORDER") {
    const row = (await c.query(`SELECT w.*,to_jsonb(w) j FROM work_orders w WHERE w.id::text=$1 FOR UPDATE`, [id])).rows[0];
    if (!row) throw Object.assign(new Error("A munkalap nem található."), { status: 404 });
    const j = row.j || row;
    if (!j.legal_entity_id) throw Object.assign(new Error("A munkalaphoz nincs kibocsátó cég kiválasztva."), { status: 409 });
    if (String(j.payment_status || "").toLowerCase() !== "paid" && !j.fully_paid) throw Object.assign(new Error("Nyugta csak teljesen kifizetett munkalapból állítható ki."), { status: 409 });
    if (["requested", "issued", "invoiced", "invoice_requested", "sent", "submitted"].includes(String(j.invoice_status || "").toLowerCase())) throw Object.assign(new Error("A munkalaphoz számla tartozik; nyugta nem állítható ki."), { status: 409 });
    const items = (await c.query(`
      SELECT wi.*,to_jsonb(wi) j,to_jsonb(p) p,to_jsonb(s) s
        FROM work_order_items wi
        LEFT JOIN products p ON p.id::text=NULLIF(to_jsonb(wi)->>'product_id','')
        LEFT JOIN services s ON s.id::text=NULLIF(to_jsonb(wi)->>'service_id','')
       WHERE wi.work_order_id::text=$1
       ORDER BY wi.created_at,wi.id`, [id])).rows;
    if (!items.length) throw Object.assign(new Error("A munkalapon nincs nyugtázható tétel."), { status: 409 });
    const itemSum = items.reduce((sum: number, item: any) => sum + Number(item.line_total || 0), 0);
    return {
      type,
      location_id: String(j.location_id || "") || null,
      legal_entity_id: String(j.legal_entity_id),
      source_number: String(j.work_order_number || row.id),
      customer_name: String(j.client_name || "") || null,
      customer_email: String(j.client_email || "") || null,
      gross_total: money(j.gross_total ?? (itemSum - Number(j.discount_amount || 0))),
      items,
      locked: Boolean(j.locked_at || j.archived_at),
    };
  }
  if (type === "RETAIL_SALE") {
    const row = (await c.query(`SELECT r.*,to_jsonb(r) j FROM retail_sales r WHERE r.id::text=$1 FOR UPDATE`, [id])).rows[0];
    if (!row) throw Object.assign(new Error("A termékeladás nem található."), { status: 404 });
    const j = row.j || row;
    if (!j.legal_entity_id) throw Object.assign(new Error("A termékeladáshoz nincs kibocsátó cég kiválasztva."), { status: 409 });
    if (Boolean(j.invoice_requested) || j.finance_invoice_id) throw Object.assign(new Error("A termékeladáshoz számla tartozik; nyugta nem állítható ki."), { status: 409 });
    if (!["paid", "completed", "closed"].includes(String(j.status || "paid").toLowerCase())) throw Object.assign(new Error("Nyugta csak lezárt/kifizetett termékeladásból állítható ki."), { status: 409 });
    const items = (await c.query(`
      SELECT i.*,to_jsonb(i) j,to_jsonb(p) p
        FROM retail_sale_items i
        LEFT JOIN products p ON p.id::text=i.product_id::text
       WHERE i.sale_id::text=$1
       ORDER BY i.created_at,i.id`, [id])).rows;
    if (!items.length) throw Object.assign(new Error("A termékeladásban nincs nyugtázható tétel."), { status: 409 });
    return {
      type,
      location_id: String(j.location_id || "") || null,
      legal_entity_id: String(j.legal_entity_id),
      source_number: String(j.sale_number || row.id),
      customer_name: String(j.customer_name || "") || null,
      customer_email: String(j.customer_email || "") || null,
      gross_total: money(j.gross_total),
      items,
      locked: false,
    };
  }
  throw Object.assign(new Error("Érvénytelen nyugtaforrás."), { status: 400 });
}

function sourceLines(source: any, defaultVat: number) {
  const raw = source.items.map((row: any) => {
    const x = row.j || row, product = row.p || {}, service = row.s || {};
    const gross = money(x.line_total ?? x.gross_amount ?? 0);
    const rate = pct(x.vat_rate ?? product.vat_rate ?? service.vat_rate, defaultVat);
    return {
      description: String(x.item_name || x.product_name || product.name || service.name || "Tétel"),
      quantity: Number(x.quantity || 1),
      gross,
      rate,
      category: x.vat_category ?? product.vat_category ?? service.vat_category,
    };
  });
  const rawTotal = money(raw.reduce((sum: number, line: any) => sum + line.gross, 0));
  const target = money(source.gross_total);
  let allocated = 0;
  return raw.map((line: any, index: number) => {
    const gross = index === raw.length - 1 ? money(target - allocated) : money(rawTotal ? line.gross * target / rawTotal : 0);
    allocated = money(allocated + gross);
    return { ...line, gross };
  });
}

router.post("/documents/issue", async (req: AuthRequest, res: Response) => {
  const c = await db.connect();
  let pdf: Buffer | null = null;
  let receipt: any = null;
  try {
    await ensureReceiptSchema();
    const type = String(req.body?.source_type || "").toUpperCase(), id = String(req.body?.source_id || "").trim();
    if (!["WORK_ORDER", "RETAIL_SALE"].includes(type) || !id) return res.status(400).json({ ok: false, message: "A nyugtaforrás kötelező." });
    const requestedScope = scope(req, res, req.body?.location_id);
    if (requestedScope === undefined) return;
    await c.query("BEGIN");
    const existing = (await c.query(`SELECT id::text FROM vir_receipts WHERE source_type=$1 AND source_id=$2 AND document_type='SALE' FOR UPDATE`, [type, id])).rows[0];
    if (existing) {
      await c.query("COMMIT");
      return res.json({ ok: true, receipt: await receiptRow(db, existing.id), idempotent: true });
    }
    const source = await loadSource(c, type, id);
    if (requestedScope && source.location_id && requestedScope !== source.location_id) throw Object.assign(new Error("A forrás másik szalonhoz tartozik."), { status: 403 });
    const entity = await entityFor(c, source.legal_entity_id, source.location_id || requestedScope);
    const receiptNumber = await nextNumber(c, entity), issuedAt = new Date().toISOString();
    const lines = sourceLines(source, entity.defaultVat);
    const breakdown = mergeVat(lines.map((line: any) => vatLine(line.gross, line.rate, line.category)));
    const pdfLines: ReceiptPdfLine[] = lines.map((line: any) => ({ description: line.description, quantity: line.quantity, gross: line.gross, vat_rate_percent: line.rate, vat_category: vatCategory(line.rate, line.category) }));
    const base = {
      source_type: type, source_id: id, source_number: source.source_number, receipt_number: receiptNumber,
      document_type: "SALE" as const, issued_at: issuedAt, issuer_name: entity.name, issuer_tax_number: entity.tax,
      issuer_address: entity.address, currency: entity.currency, gross_total: money(source.gross_total), vat_breakdown: breakdown,
      lines: pdfLines, customer_name: source.customer_name, customer_email: String(req.body?.customer_email || source.customer_email || "").trim() || null,
      original_receipt_number: null, correction_reason: null,
    };
    const documentHash = crypto.createHash("sha256").update(JSON.stringify(base)).digest("hex");
    pdf = await generateReceiptPdf({ ...base, document_hash: documentHash } as ReceiptPdfDocument);
    const pdfHash = crypto.createHash("sha256").update(pdf).digest("hex");
    receipt = (await c.query(`
      INSERT INTO vir_receipts(location_id,legal_entity_id,source_type,source_id,source_number,receipt_number,document_type,status,issued_at,
        issuer_name,issuer_tax_number,issuer_address,currency,gross_total,vat_breakdown,line_snapshot,customer_name,customer_email,
        document_hash,pdf_sha256,pdf_data,created_by)
      VALUES($1,$2::uuid,$3,$4,$5,$6,'SALE','ISSUED',$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15,$16,$17,$18,$19,$20)
      RETURNING id::text`, [source.location_id || requestedScope, entity.id, type, id, source.source_number, receiptNumber, issuedAt,
      entity.name, entity.tax, entity.address, entity.currency, source.gross_total, JSON.stringify(breakdown), JSON.stringify(pdfLines),
      source.customer_name, base.customer_email, documentHash, pdfHash, pdf, actor(req)])).rows[0];
    await event(c, receipt.id, "ISSUED", req, { source_type: type, source_id: id, legal_entity_id: entity.id, pdf_sha256: pdfHash });
    if (type === "WORK_ORDER" && !source.locked) await c.query(`UPDATE work_orders SET receipt_status='issued',receipt_id=$2::uuid WHERE id::text=$1`, [id, receipt.id]);
    if (type === "RETAIL_SALE") await c.query(`UPDATE retail_sales SET receipt_status='issued',receipt_id=$2::uuid WHERE id::text=$1`, [id, receipt.id]);
    await c.query("COMMIT");
    receipt = await receiptRow(db, receipt.id);

    let delivery: any = null;
    const sendNow = req.body?.send_email === true;
    if (sendNow && pdf) {
      const recipient = String(receipt.customer_email || "").trim();
      if (!validEmail(recipient)) delivery = { sent: false, error: "Érvényes ügyfél e-mail-cím nincs megadva." };
      else {
        try {
          delivery = await mailReceipt(receipt, pdf, recipient);
          if (delivery?.sent) await db.query(`UPDATE vir_receipts SET email_sent_at=now(),email_message_id=$2 WHERE id=$1::uuid`, [receipt.id, delivery.messageId || null]);
          await event(db, receipt.id, "EMAIL_SENT", req, { to: recipient, sent: Boolean(delivery?.sent), message_id: delivery?.messageId || null });
          receipt = await receiptRow(db, receipt.id);
        } catch (mailError: any) { delivery = { sent: false, error: String(mailError?.message || mailError) }; }
      }
    }
    return res.status(201).json({ ok: true, receipt, legal_entity: { id: entity.id, legal_name: entity.name, tax_number: entity.tax }, delivery });
  } catch (error: any) {
    await c.query("ROLLBACK").catch(() => undefined);
    const status = Number(error?.status || 500);
    return res.status(status >= 400 && status < 600 ? status : 500).json({ ok: false, code: error?.code || "RECEIPT_ISSUE_FAILED", message: error?.message || "A nyugta nem állítható ki." });
  } finally { c.release(); }
});

async function refundWorkOrder(c: any, original: any, req: AuthRequest, reason: string) {
  const workOrder = (await c.query(`SELECT w.*,to_jsonb(w) j FROM work_orders w WHERE w.id::text=$1 FOR UPDATE`, [original.source_id])).rows[0];
  if (!workOrder) throw Object.assign(new Error("A nyugtához tartozó munkalap nem található."), { status: 409 });
  const j = workOrder.j || workOrder;
  const locked = Boolean(j.locked_at || j.archived_at);
  const payments = (await c.query(`
    SELECT wp.*,
      GREATEST(COALESCE(wp.refunded_amount,0),COALESCE((SELECT SUM(r.amount) FROM work_order_payment_refunds r WHERE r.payment_id=wp.id),0))::numeric effective_refunded_amount
      FROM work_order_payments wp
     WHERE wp.work_order_id::text=$1
     ORDER BY wp.paid_at,wp.id FOR UPDATE`, [original.source_id])).rows;
  if (!payments.length) throw Object.assign(new Error("A munkalaphoz nem található visszatéríthető fizetés."), { status: 409 });

  let refundedTotal = 0;
  for (const payment of payments) {
    const available = money(Number(payment.amount || 0) - Number(payment.effective_refunded_amount || 0));
    if (!(available > 0)) continue;
    const accountId = String(payment.finance_account_id || "").trim() || null;
    if (!accountId) throw Object.assign(new Error("A visszatérítéshez minden fizetésnél pénzügyi számla szükséges."), { status: 409, code: "RECEIPT_REFUND_ACCOUNT_REQUIRED" });
    let shift: any = null;
    if (String(payment.payment_method || "").toLowerCase() === "cash") {
      shift = (await c.query(`SELECT * FROM cash_register_shifts WHERE location_id=$1 AND status='open' ORDER BY opened_at DESC LIMIT 1`, [String(original.location_id)])).rows[0];
      if (!shift) throw Object.assign(new Error("Készpénzes nyugta sztornójához nyitott pénztári műszak szükséges."), { status: 409, code: "RECEIPT_REFUND_OPEN_SHIFT_REQUIRED" });
    }
    const idempotencyKey = `receipt-void:${original.id}:${payment.id}`;
    const movement = (await c.query(`
      INSERT INTO financial_movements(location_id,legal_entity_id,account_id,direction,amount,occurred_at,reference_type,reference_id,note,created_by,
        payment_method_code,document_type_code,payment_status,idempotency_key,posting_group_id)
      VALUES($1,$2::uuid,$3::uuid,'expense',$4,now(),'cashier_refund',$5,$6,$7,$8,'refund','posted',$9,gen_random_uuid())
      RETURNING id`, [original.location_id, original.legal_entity_id, accountId, available, String(original.source_id),
      `Nyugta sztornó ${original.receipt_number}: ${reason}`, actor(req), String(payment.payment_method_code || payment.payment_method || "other"), `${idempotencyKey}:ledger`])).rows[0];
    const refund = (await c.query(`
      INSERT INTO work_order_payment_refunds(payment_id,work_order_id,location_id,finance_account_id,cashier_shift_id,amount,reason,refund_method,
        created_by,financial_movement_id,idempotency_key,integrity_required)
      VALUES($1::uuid,$2,$3,$4::uuid,$5,$6,$7,$8,$9,$10::uuid,$11,true)
      RETURNING id`, [payment.id, String(payment.work_order_id), String(original.location_id), accountId, shift?.id || payment.cashier_shift_id || null,
      available, reason, String(payment.payment_method_code || payment.payment_method || "other"), actor(req), movement.id, idempotencyKey])).rows[0];
    if (String(payment.payment_method || "").toLowerCase() === "cash") {
      await c.query(`
        INSERT INTO cash_register_movements(location_id,business_date,direction,amount,reason_code,note,created_by,transaction_type_code,reference_no,
          finance_account_id,cashier_shift_id,financial_movement_id,idempotency_key,integrity_required)
        VALUES($1,CURRENT_DATE,'out',$2,'refund',$3,$4,'refund',$5,$6::uuid,$7,$8::uuid,$9,true)`, [String(original.location_id), available,
        `Nyugta sztornó ${original.receipt_number}: ${reason}`, actor(req), String(payment.id), accountId, shift.id, movement.id, `${idempotencyKey}:cash`]);
    }
    await c.query(`INSERT INTO finance_integrity_events(event_type,location_key,subject_type,subject_id,actor,reason,evidence)
      VALUES('payment_refunded',$1,'work_order_payment_refund',$2,$3,$4,$5::jsonb)`, [String(original.location_id), String(refund.id), actor(req), reason,
      JSON.stringify({ payment_id: payment.id, movement_id: movement.id, receipt_id: original.id, legal_entity_id: original.legal_entity_id, amount: available })]);
    refundedTotal = money(refundedTotal + available);
  }
  if (!(refundedTotal > 0)) throw Object.assign(new Error("A munkalap fizetése már teljes egészében visszatérített."), { status: 409 });

  const paid = money((await c.query(`SELECT COALESCE(SUM(wp.amount-GREATEST(COALESCE(wp.refunded_amount,0),COALESCE((SELECT SUM(r.amount) FROM work_order_payment_refunds r WHERE r.payment_id=wp.id),0))),0)::numeric paid FROM work_order_payments wp WHERE wp.work_order_id=$1`, [original.source_id])).rows[0]?.paid);
  if (!locked) {
    const status = paid <= 0 ? "refunded" : "partial";
    await c.query(`UPDATE work_orders SET amount_paid=$2,payment_status=$3,fully_paid=false,receipt_status='voided',updated_at=now() WHERE id::text=$1`, [original.source_id, paid, status]);
  }
  return { refunded_total: refundedTotal, amount_paid: paid, locked_work_order_header_unchanged: locked };
}

router.post("/documents/:id/void", async (req: AuthRequest, res: Response) => {
  const c = await db.connect();
  let pdf: Buffer | null = null;
  try {
    await ensureReceiptSchema();
    const reason = String(req.body?.reason || "").trim();
    if (reason.length < 3) return res.status(400).json({ ok: false, message: "A sztornó indoka legalább 3 karakter." });
    await c.query("BEGIN");
    const original = (await c.query(`SELECT * FROM vir_receipts WHERE id=$1::uuid FOR UPDATE`, [req.params.id])).rows[0];
    if (!original) { await c.query("ROLLBACK"); return res.status(404).json({ ok: false, message: "A nyugta nem található." }); }
    if (original.document_type !== "SALE") throw Object.assign(new Error("Érvénytelenítő nyugta nem sztornózható."), { status: 409 });
    const requestedScope = scope(req, res, original.location_id);
    if (requestedScope === undefined) { await c.query("ROLLBACK"); return; }
    const existing = (await c.query(`SELECT id::text FROM vir_receipts WHERE original_receipt_id=$1::uuid AND document_type='VOID' FOR UPDATE`, [original.id])).rows[0];
    if (existing) {
      await c.query("COMMIT");
      return res.json({ ok: true, original: await receiptRow(db, original.id), void_receipt: await receiptRow(db, existing.id), idempotent: true });
    }

    const reverseFinancial = req.body?.reverse_financial !== false;
    let refund: any = null;
    if (reverseFinancial && original.source_type === "WORK_ORDER") refund = await refundWorkOrder(c, original, req, reason);
    if (reverseFinancial && original.source_type === "RETAIL_SALE") throw Object.assign(new Error("A termékeladás automatikus pénzügyi visszatérítése még nem biztonságos. Válassza a csak-bizonylat sztornót, majd rögzítse a pénzvisszatérítést külön pénzügyi műveletként."), { status: 409, code: "RETAIL_REVERSAL_MANUAL_REQUIRED" });

    const entity = await entityFor(c, original.legal_entity_id ? String(original.legal_entity_id) : null, original.location_id ? String(original.location_id) : null, original.issuer_tax_number);
    const receiptNumber = await nextNumber(c, entity), issuedAt = new Date().toISOString();
    const originalLines = Array.isArray(original.line_snapshot) ? original.line_snapshot : [];
    const pdfLines: ReceiptPdfLine[] = originalLines.map((line: any) => ({
      description: String(line.description || "Tétel"), quantity: Number(line.quantity || 1), gross: -Math.abs(money(line.gross)),
      vat_rate_percent: Number(line.vat_rate_percent || 0), vat_category: String(line.vat_category || vatCategory(Number(line.vat_rate_percent || 0))),
    }));
    const breakdown = mergeVat(pdfLines.map(line => vatLine(line.gross, line.vat_rate_percent, line.vat_category)));
    const base = {
      source_type: original.source_type, source_id: original.source_id, source_number: original.source_number,
      receipt_number: receiptNumber, document_type: "VOID" as const, issued_at: issuedAt,
      issuer_name: original.issuer_name, issuer_tax_number: original.issuer_tax_number, issuer_address: original.issuer_address,
      currency: original.currency || entity.currency, gross_total: -Math.abs(money(original.gross_total)), vat_breakdown: breakdown, lines: pdfLines,
      customer_name: original.customer_name, customer_email: original.customer_email, original_receipt_number: original.receipt_number, correction_reason: reason,
    };
    const documentHash = crypto.createHash("sha256").update(JSON.stringify(base)).digest("hex");
    pdf = await generateReceiptPdf({ ...base, document_hash: documentHash } as ReceiptPdfDocument);
    const pdfHash = crypto.createHash("sha256").update(pdf).digest("hex");
    const voidId = String((await c.query(`
      INSERT INTO vir_receipts(location_id,legal_entity_id,source_type,source_id,source_number,receipt_number,document_type,status,
        original_receipt_id,original_receipt_number,issued_at,issuer_name,issuer_tax_number,issuer_address,currency,gross_total,vat_breakdown,
        line_snapshot,customer_name,customer_email,correction_reason,document_hash,pdf_sha256,pdf_data,created_by)
      VALUES($1,$2::uuid,$3,$4,$5,$6,'VOID','ISSUED',$7::uuid,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17,$18,$19,$20,$21,$22,$23)
      RETURNING id::text`, [original.location_id, entity.id, original.source_type, original.source_id, original.source_number, receiptNumber, original.id,
      original.receipt_number, issuedAt, original.issuer_name, original.issuer_tax_number, original.issuer_address, original.currency || entity.currency,
      base.gross_total, JSON.stringify(breakdown), JSON.stringify(pdfLines), original.customer_name, original.customer_email, reason, documentHash, pdfHash, pdf, actor(req)])).rows[0].id);
    await c.query(`UPDATE vir_receipts SET status='VOIDED',voided_at=now(),voided_by=$2,void_reason=$3 WHERE id=$1::uuid`, [original.id, actor(req), reason]);
    if (original.source_type === "RETAIL_SALE") await c.query(`UPDATE retail_sales SET receipt_status='voided' WHERE id::text=$1`, [original.source_id]);
    if (original.source_type === "WORK_ORDER" && !reverseFinancial) {
      const state = (await c.query(`SELECT to_jsonb(w) j FROM work_orders w WHERE id::text=$1`, [original.source_id])).rows[0]?.j || {};
      if (!state.locked_at && !state.archived_at) await c.query(`UPDATE work_orders SET receipt_status='voided' WHERE id::text=$1`, [original.source_id]);
    }
    await event(c, original.id, "VOIDED", req, { void_receipt_id: voidId, reason, reverse_financial: reverseFinancial, refund });
    await event(c, voidId, "ISSUED", req, { original_receipt_id: original.id, legal_entity_id: entity.id, reason });
    await c.query("COMMIT");

    let delivery: any = null;
    let voidReceipt = await receiptRow(db, voidId);
    if (req.body?.send_email === true && pdf && validEmail(voidReceipt?.customer_email)) {
      try {
        delivery = await mailReceipt(voidReceipt, pdf, String(voidReceipt.customer_email));
        if (delivery?.sent) await db.query(`UPDATE vir_receipts SET email_sent_at=now(),email_message_id=$2 WHERE id=$1::uuid`, [voidId, delivery.messageId || null]);
        await event(db, voidId, "EMAIL_SENT", req, { to: voidReceipt.customer_email, sent: Boolean(delivery?.sent), message_id: delivery?.messageId || null });
        voidReceipt = await receiptRow(db, voidId);
      } catch (mailError: any) { delivery = { sent: false, error: String(mailError?.message || mailError) }; }
    }
    return res.status(201).json({ ok: true, original: await receiptRow(db, original.id), void_receipt: voidReceipt, financial_reversed: Boolean(refund), refund, delivery });
  } catch (error: any) {
    await c.query("ROLLBACK").catch(() => undefined);
    const status = Number(error?.status || 500);
    return res.status(status >= 400 && status < 600 ? status : 500).json({ ok: false, code: error?.code || "RECEIPT_VOID_FAILED", message: error?.message || "A nyugta sztornója sikertelen." });
  } finally { c.release(); }
});

export default router;
