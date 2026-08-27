import { Router, Response } from "express";
import multer from "multer";
import axios from "axios";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import * as XLSX from "xlsx";
import db from "../db";
import { requireAuth, type AuthRequest } from "../middleware/auth";
import { requireRoles } from "../middleware/requireRoles";
import { parseRoleKeys } from "../security/roles";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });
router.use(requireAuth);
router.use(requireRoles("admin", "manager", "accounting", "bookkeeper", "location_manager", "salon_manager"));

const GLOBAL = new Set(["admin", "manager", "accounting", "bookkeeper"]);
const SOURCES = new Set(["invee", "google_drive", "altegio", "file_upload", "manual"]);
const DOC_TYPES = new Set(["invoice", "receipt", "credit_note", "void_receipt", "transaction", "other"]);
const PROVIDERS = new Set(["internal", "invee_manual", "nav_epg", "hardware_epg"]);
const NAV_OWNERS = new Set(["vir", "external", "not_applicable"]);
const FILE_EXTENSIONS = new Set(["csv", "xlsx", "xls", "xml", "pdf"]);

const money = (v: unknown) => Math.round((Number(v) || 0) * 100) / 100;
const text = (v: unknown) => String(v ?? "").trim();
const actor = (req: AuthRequest) => req.user?.email || String(req.user?.id || "");
const sha256 = (value: Buffer | string) => crypto.createHash("sha256").update(value).digest("hex");
const norm = (v: unknown) => text(v)
  .normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "_")
  .replace(/^_|_$/g, "");

const parseNumber = (v: unknown) => {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const raw = text(v).replace(/\u00a0/g, " ").replace(/\s/g, "");
  if (!raw) return 0;
  const normalized = raw
    .replace(/(?<=\d)\.(?=\d{3}(\D|$))/g, "")
    .replace(/(?<=\d),(?=\d{3}(\D|$))/g, "")
    .replace(",", ".")
    .replace(/[^0-9.+-]/g, "");
  const n = Number(normalized);
  return Number.isFinite(n) ? n : 0;
};

const isoDate = (v: unknown): string | null => {
  if (v instanceof Date && Number.isFinite(v.getTime())) return v.toISOString().slice(0, 10);
  const s = text(v);
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const hu = s.match(/^(\d{4})[.\/-](\d{1,2})[.\/-](\d{1,2})/);
  if (hu) return `${hu[1]}-${hu[2].padStart(2, "0")}-${hu[3].padStart(2, "0")}`;
  const eu = s.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})/);
  if (eu) return `${eu[3]}-${eu[2].padStart(2, "0")}-${eu[1].padStart(2, "0")}`;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : null;
};

let schemaReady: Promise<void> | null = null;
async function ensureSchema() {
  if (!schemaReady) schemaReady = db.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    CREATE TABLE IF NOT EXISTS legal_entity_document_settings(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      legal_entity_id uuid NOT NULL REFERENCES legal_entities(id) ON DELETE CASCADE,
      location_id uuid REFERENCES locations(id) ON DELETE CASCADE,
      receipt_provider text NOT NULL DEFAULT 'internal',
      drive_folder_id text,
      altegio_location_id text,
      external_account_ref text,
      nav_reporting_owner text NOT NULL DEFAULT 'external',
      active boolean NOT NULL DEFAULT true,
      updated_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK(receipt_provider IN('internal','invee_manual','nav_epg','hardware_epg')),
      CHECK(nav_reporting_owner IN('vir','external','not_applicable'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_legal_entity_document_settings_scope
      ON legal_entity_document_settings(legal_entity_id,COALESCE(location_id,'00000000-0000-0000-0000-000000000000'::uuid));

    CREATE TABLE IF NOT EXISTS external_financial_import_batches(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      legal_entity_id uuid NOT NULL REFERENCES legal_entities(id) ON DELETE RESTRICT,
      location_id uuid REFERENCES locations(id) ON DELETE RESTRICT,
      source text NOT NULL,
      import_profile text NOT NULL DEFAULT 'generic_file',
      file_name text NOT NULL,
      mime_type text NOT NULL,
      content_sha256 text NOT NULL,
      payload bytea NOT NULL,
      imported_count integer NOT NULL DEFAULT 0,
      duplicate_count integer NOT NULL DEFAULT 0,
      created_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      CHECK(source IN('invee','google_drive','altegio','file_upload','manual'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_external_import_batch_hash
      ON external_financial_import_batches(legal_entity_id,source,content_sha256);

    CREATE TABLE IF NOT EXISTS external_financial_documents(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      legal_entity_id uuid NOT NULL REFERENCES legal_entities(id) ON DELETE RESTRICT,
      location_id uuid REFERENCES locations(id) ON DELETE RESTRICT,
      import_batch_id uuid REFERENCES external_financial_import_batches(id) ON DELETE SET NULL,
      source text NOT NULL,
      document_type text NOT NULL DEFAULT 'other',
      external_id text,
      external_document_number text,
      issue_date date,
      counterparty_name text,
      counterparty_tax_number text,
      currency text NOT NULL DEFAULT 'HUF',
      net_amount numeric(14,2) NOT NULL DEFAULT 0,
      vat_amount numeric(14,2) NOT NULL DEFAULT 0,
      gross_amount numeric(14,2) NOT NULL DEFAULT 0,
      payment_method text,
      work_order_id text,
      source_url text,
      source_file_id text,
      file_name text,
      mime_type text,
      content_sha256 text,
      status text NOT NULL DEFAULT 'pending_review',
      nav_reporting_owner text NOT NULL DEFAULT 'external',
      nav_excluded boolean NOT NULL DEFAULT true,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_by text,
      reviewed_by text,
      reviewed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK(source IN('invee','google_drive','altegio','file_upload','manual')),
      CHECK(document_type IN('invoice','receipt','credit_note','void_receipt','transaction','other')),
      CHECK(status IN('pending_review','approved','rejected','duplicate','voided')),
      CHECK(nav_reporting_owner IN('vir','external','not_applicable')),
      CHECK(nav_reporting_owner<>'external' OR nav_excluded=true)
    );
    ALTER TABLE external_financial_documents ADD COLUMN IF NOT EXISTS import_batch_id uuid REFERENCES external_financial_import_batches(id) ON DELETE SET NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_external_document_source_id
      ON external_financial_documents(legal_entity_id,source,external_id) WHERE external_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_external_document_hash
      ON external_financial_documents(legal_entity_id,content_sha256) WHERE content_sha256 IS NOT NULL;
    CREATE INDEX IF NOT EXISTS external_financial_documents_review_idx
      ON external_financial_documents(status,legal_entity_id,issue_date DESC,created_at DESC);

    CREATE TABLE IF NOT EXISTS external_financial_document_files(
      document_id uuid PRIMARY KEY REFERENCES external_financial_documents(id) ON DELETE CASCADE,
      payload bytea NOT NULL,
      file_name text NOT NULL,
      mime_type text NOT NULL,
      size_bytes bigint NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS external_financial_document_events(
      id bigserial PRIMARY KEY,
      document_id uuid NOT NULL REFERENCES external_financial_documents(id) ON DELETE CASCADE,
      event_type text NOT NULL,
      actor text,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `).then(() => undefined).catch((e) => { schemaReady = null; throw e; });
  return schemaReady;
}

function isGlobal(req: AuthRequest) {
  return parseRoleKeys(req.user?.role).some((r) => GLOBAL.has(r));
}
async function canUseEntity(req: AuthRequest, entityId: string, locationId?: string | null) {
  if (isGlobal(req)) return true;
  const own = text(req.user?.location_id);
  if (!own) return false;
  if (locationId && locationId !== own) return false;
  return Boolean((await db.query(
    `SELECT 1 FROM legal_entity_locations WHERE legal_entity_id=$1::uuid AND location_id::text=$2 AND active=true`,
    [entityId, own],
  )).rows[0]);
}
async function requireEntity(req: AuthRequest, res: Response, entityId: string, locationId?: string | null) {
  if (!entityId) {
    res.status(400).json({ ok: false, message: "A könyvelési cég kiválasztása kötelező." });
    return false;
  }
  if (!(await canUseEntity(req, entityId, locationId))) {
    res.status(403).json({ ok: false, message: "Ehhez a céghez vagy telephelyhez nincs jogosultsága." });
    return false;
  }
  return true;
}
async function event(documentId: string, req: AuthRequest, eventType: string, payload: unknown = {}) {
  await db.query(
    `INSERT INTO external_financial_document_events(document_id,event_type,actor,payload) VALUES($1::uuid,$2,$3,$4::jsonb)`,
    [documentId, eventType, actor(req), JSON.stringify(payload || {})],
  );
}

function rowValue(row: Record<string, unknown>, names: string[]) {
  const normalized = new Map(Object.entries(row).map(([k, v]) => [norm(k), v]));
  for (const name of names) {
    const v = normalized.get(norm(name));
    if (v !== undefined && v !== null && text(v) !== "") return v;
  }
  return null;
}

function commonRowToDocument(row: Record<string, unknown>, defaults: any = {}) {
  const number = rowValue(row, [
    "document_number", "invoice_number", "receipt_number", "bizonylatszam", "bizonylat_szam",
    "szamlaszam", "szamla_sorszam", "nyugtaszam", "number", "transaction_number", "transaction_id", "id",
  ]);
  const rawType = norm(rowValue(row, ["document_type", "type", "tipus", "bizonylat_tipus", "transaction_type"]) || defaults.document_type || "other");
  const documentType = rawType.includes("invoice") || rawType.includes("szamla") ? "invoice"
    : rawType.includes("receipt") || rawType.includes("nyugta") ? "receipt"
    : rawType.includes("credit") || rawType.includes("storno") || rawType.includes("refund") ? "credit_note"
    : DOC_TYPES.has(rawType) ? rawType : defaults.document_type || "other";
  const net = parseNumber(rowValue(row, ["net_amount", "netto", "netto_osszeg", "net"]));
  const vat = parseNumber(rowValue(row, ["vat_amount", "afa", "afa_osszeg", "tax_amount", "vat"]));
  let gross = parseNumber(rowValue(row, ["gross_amount", "brutto", "brutto_osszeg", "total", "amount", "osszeg", "sum"]));
  if (!gross && (net || vat)) gross = net + vat;
  return {
    document_type: documentType,
    external_document_number: text(number) || defaults.external_document_number || null,
    issue_date: isoDate(rowValue(row, ["issue_date", "date", "datum", "kiallitas_datum", "created_at", "datetime"])) || defaults.issue_date || null,
    counterparty_name: text(rowValue(row, ["counterparty_name", "customer_name", "supplier_name", "partner", "vevo", "szallito", "nev", "client"])) || defaults.counterparty_name || null,
    counterparty_tax_number: text(rowValue(row, ["tax_number", "counterparty_tax_number", "adoszam", "vevo_adoszam", "szallito_adoszam"])) || defaults.counterparty_tax_number || null,
    currency: (text(rowValue(row, ["currency", "penznem"])) || defaults.currency || "HUF").toUpperCase().slice(0, 3),
    net_amount: money(net || defaults.net_amount || 0),
    vat_amount: money(vat || defaults.vat_amount || 0),
    gross_amount: money(gross || defaults.gross_amount || 0),
    payment_method: text(rowValue(row, ["payment_method", "fizetesi_mod", "payment", "payment_type", "cashbox", "account"])) || defaults.payment_method || null,
    metadata: row,
  };
}

type ParsedDocument = ReturnType<typeof commonRowToDocument> & {
  external_id?: string | null;
  sheet_name?: string | null;
  row_number?: number | null;
};

function altegioRowToDocument(row: Record<string, unknown>): ParsedDocument {
  const id = rowValue(row, [
    "transaction_id", "transaction id", "id", "record_id", "record id", "visit_id", "visit id",
    "appointment_id", "appointment id", "sale_id", "sale id", "document_id", "document id",
  ]);
  const income = parseNumber(rowValue(row, ["income", "bevetel", "bevétel", "credit", "incoming"]));
  const expense = parseNumber(rowValue(row, ["expense", "kiadas", "kiadás", "debit", "outgoing"]));
  const explicitAmount = parseNumber(rowValue(row, [
    "amount", "sum", "total", "gross_amount", "osszeg", "összeg", "payment_amount", "payment amount",
    "paid", "payment", "price", "cost",
  ]));
  const amount = explicitAmount || (income || expense ? income - expense : 0);
  const dateValue = rowValue(row, [
    "date", "datum", "dátum", "datetime", "date_time", "date and time", "created_at", "created",
    "transaction_date", "transaction date", "visit_date", "visit date", "sale_date", "sale date",
  ]);
  const client = rowValue(row, [
    "client", "client_name", "client name", "customer", "customer_name", "customer name", "guest",
    "guest_name", "guest name", "partner", "counterparty", "name", "nev", "név",
  ]);
  const payment = rowValue(row, [
    "payment_method", "payment method", "payment_type", "payment type", "account", "cashbox",
    "cash desk", "cash_desk", "fizetesi_mod", "fizetési mód",
  ]);
  const type = rowValue(row, ["type", "transaction_type", "transaction type", "category", "operation", "operation_type", "operation type"]);
  const number = rowValue(row, [
    "document_number", "document number", "receipt_number", "receipt number", "invoice_number", "invoice number",
    "bizonylatszam", "bizonylatszám", "nyugtaszam", "nyugtaszám", "szamlaszam", "számlaszám",
  ]);
  const currency = text(rowValue(row, ["currency", "currency_code", "currency code", "penznem", "pénznem"]) || "HUF").toUpperCase().slice(0, 3);
  const sourceComment = text(rowValue(row, ["comment", "description", "note", "service", "service_name", "service name", "details"]));

  return {
    document_type: "transaction",
    external_document_number: text(number) || text(id) || null,
    issue_date: isoDate(dateValue),
    counterparty_name: text(client) || sourceComment || null,
    counterparty_tax_number: null,
    currency,
    net_amount: 0,
    vat_amount: 0,
    gross_amount: money(amount),
    payment_method: text(payment) || null,
    external_id: text(id) || null,
    metadata: {
      ...row,
      altegio_export: true,
      altegio_operation_type: text(type) || null,
      altegio_income: money(income),
      altegio_expense: money(expense),
      altegio_description: sourceComment || null,
    },
  };
}

function xmlTag(xml: string, names: string[]) {
  for (const n of names) {
    const safe = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = xml.match(new RegExp(`<(?:\\w+:)?${safe}[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${safe}>`, "i"));
    if (m) return m[1].replace(/<[^>]+>/g, "").trim();
  }
  return null;
}
function xmlToDocument(xml: string): ParsedDocument {
  const net = parseNumber(xmlTag(xml, ["invoiceNetAmount", "netAmount", "nettoOsszeg"]));
  const vat = parseNumber(xmlTag(xml, ["invoiceVatAmount", "vatAmount", "afaOsszeg"]));
  return {
    document_type: "invoice",
    external_document_number: xmlTag(xml, ["invoiceNumber", "invoiceNo", "szamlaSorszam"]),
    issue_date: isoDate(xmlTag(xml, ["invoiceIssueDate", "issueDate", "kiallitasDatum"])),
    counterparty_name: xmlTag(xml, ["customerName", "supplierName", "name"]),
    counterparty_tax_number: xmlTag(xml, ["taxpayerId", "taxNumber", "adoszam"]),
    currency: (xmlTag(xml, ["currencyCode", "currency", "penznem"]) || "HUF").toUpperCase().slice(0, 3),
    net_amount: money(net),
    vat_amount: money(vat),
    gross_amount: money(parseNumber(xmlTag(xml, ["invoiceGrossAmount", "grossAmount", "bruttoOsszeg"])) || net + vat),
    payment_method: null,
    metadata: { xml_import: true },
  };
}

function workbookDocuments(fileName: string, buf: Buffer, profile: "generic" | "altegio"): ParsedDocument[] {
  const workbook = XLSX.read(buf, { type: "buffer", cellDates: true });
  const result: ParsedDocument[] = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null, raw: false });
    rows.forEach((row, index) => {
      if (!Object.values(row).some((v) => text(v))) return;
      const parsed = profile === "altegio" ? altegioRowToDocument(row) : commonRowToDocument(row);
      result.push({
        ...parsed,
        sheet_name: sheetName,
        row_number: index + 2,
        metadata: {
          ...parsed.metadata,
          import_file_name: fileName,
          sheet_name: sheetName,
          row_number: index + 2,
        },
      });
    });
  }
  return result;
}

function fileDocuments(fileName: string, mime: string, buf: Buffer, profile: "generic" | "altegio" = "generic") {
  const ext = fileName.toLowerCase().split(".").pop() || "";
  if (!FILE_EXTENSIONS.has(ext)) throw Object.assign(new Error("Nem támogatott fájltípus. Használjon CSV, XLS, XLSX, XML vagy PDF fájlt."), { status: 400 });
  if (ext === "csv" || ext === "xlsx" || ext === "xls") return workbookDocuments(fileName, buf, profile);
  if (profile === "altegio") throw Object.assign(new Error("Az Altegio export importhoz CSV, XLS vagy XLSX fájl szükséges."), { status: 400, code: "ALTEGIO_EXPORT_FORMAT" });
  if (ext === "xml" || /xml/i.test(mime)) return [xmlToDocument(buf.toString("utf8"))];
  return [{
    document_type: /pdf/i.test(mime) || ext === "pdf" ? "invoice" : "other",
    external_document_number: fileName.replace(/\.[^.]+$/, ""),
    issue_date: null,
    counterparty_name: null,
    counterparty_tax_number: null,
    currency: "HUF",
    net_amount: 0,
    vat_amount: 0,
    gross_amount: 0,
    payment_method: null,
    metadata: { manual_review_required: true, file_only: true, import_file_name: fileName },
  } as ParsedDocument];
}

type InsertInput = ParsedDocument & {
  legal_entity_id: string;
  location_id?: string | null;
  import_batch_id?: string | null;
  source: string;
  external_id?: string | null;
  source_url?: string | null;
  source_file_id?: string | null;
  file_name?: string | null;
  mime_type?: string | null;
  content_sha256?: string | null;
  nav_reporting_owner?: string;
  nav_excluded?: boolean;
};

async function insertDocument(req: AuthRequest, input: InsertInput, file?: Buffer | null) {
  const navOwner = NAV_OWNERS.has(text(input.nav_reporting_owner)) ? text(input.nav_reporting_owner) : "external";
  const navExcluded = navOwner === "external" ? true : input.nav_excluded !== false;
  const q = await db.query(`
    INSERT INTO external_financial_documents(
      legal_entity_id,location_id,import_batch_id,source,document_type,external_id,external_document_number,issue_date,
      counterparty_name,counterparty_tax_number,currency,net_amount,vat_amount,gross_amount,payment_method,source_url,
      source_file_id,file_name,mime_type,content_sha256,nav_reporting_owner,nav_excluded,metadata,created_by
    ) VALUES(
      $1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8::date,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23::jsonb,$24
    ) ON CONFLICT DO NOTHING RETURNING id::text`, [
      input.legal_entity_id, input.location_id || null, input.import_batch_id || null, input.source, input.document_type,
      input.external_id || null, input.external_document_number || null, input.issue_date || null, input.counterparty_name || null,
      input.counterparty_tax_number || null, input.currency || "HUF", input.net_amount || 0, input.vat_amount || 0,
      input.gross_amount || 0, input.payment_method || null, input.source_url || null, input.source_file_id || null,
      input.file_name || null, input.mime_type || null, input.content_sha256 || null, navOwner, navExcluded,
      JSON.stringify(input.metadata || {}), actor(req),
    ]);
  const id = q.rows[0]?.id ? String(q.rows[0].id) : null;
  if (id && file && input.file_name && input.mime_type) {
    await db.query(`INSERT INTO external_financial_document_files(document_id,payload,file_name,mime_type,size_bytes) VALUES($1::uuid,$2,$3,$4,$5) ON CONFLICT(document_id) DO NOTHING`, [id, file, input.file_name, input.mime_type, file.length]);
  }
  if (id) await event(id, req, "IMPORTED", { source: input.source, nav_reporting_owner: navOwner, nav_excluded: navExcluded, import_batch_id: input.import_batch_id || null });
  return id;
}

async function settingsFor(entityId: string, locationId?: string | null) {
  await ensureSchema();
  return (await db.query(`SELECT * FROM legal_entity_document_settings WHERE legal_entity_id=$1::uuid AND (location_id::text=$2 OR location_id IS NULL) ORDER BY location_id NULLS LAST LIMIT 1`, [entityId, locationId || ""])).rows[0] || null;
}

async function createImportBatch(req: AuthRequest, args: {
  entityId: string;
  locationId?: string | null;
  source: string;
  profile: string;
  fileName: string;
  mimeType: string;
  buffer: Buffer;
}) {
  const digest = sha256(args.buffer);
  const existing = (await db.query(`SELECT id::text,imported_count,duplicate_count FROM external_financial_import_batches WHERE legal_entity_id=$1::uuid AND source=$2 AND content_sha256=$3`, [args.entityId, args.source, digest])).rows[0];
  if (existing) return { duplicateBatch: true, batchId: String(existing.id), digest, imported: Number(existing.imported_count || 0), duplicates: Number(existing.duplicate_count || 0) };
  const q = await db.query(`INSERT INTO external_financial_import_batches(legal_entity_id,location_id,source,import_profile,file_name,mime_type,content_sha256,payload,created_by) VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9) RETURNING id::text`, [args.entityId, args.locationId || null, args.source, args.profile, args.fileName, args.mimeType, digest, args.buffer, actor(req)]);
  return { duplicateBatch: false, batchId: String(q.rows[0].id), digest, imported: 0, duplicates: 0 };
}

async function importBuffer(req: AuthRequest, args: {
  entityId: string;
  locationId?: string | null;
  source: string;
  profile: "generic" | "altegio";
  fileName: string;
  mimeType: string;
  buffer: Buffer;
  sourceFileId?: string | null;
  sourceUrl?: string | null;
}) {
  await ensureSchema();
  const batch = await createImportBatch(req, {
    entityId: args.entityId,
    locationId: args.locationId,
    source: args.source,
    profile: args.profile === "altegio" ? "altegio_export" : "generic_file",
    fileName: args.fileName,
    mimeType: args.mimeType,
    buffer: args.buffer,
  });
  if (batch.duplicateBatch) return { imported: 0, duplicates: Math.max(1, batch.imported + batch.duplicates), duplicate_batch: true, batch_id: batch.batchId };

  const docs = fileDocuments(args.fileName, args.mimeType, args.buffer, args.profile);
  let imported = 0;
  let duplicates = 0;
  for (let index = 0; index < docs.length; index += 1) {
    const doc = docs[index];
    const rowIdentity = doc.external_id || `${batch.digest}:${doc.sheet_name || "file"}:${doc.row_number || index + 1}`;
    const rowHash = sha256(`${batch.digest}|${rowIdentity}|${JSON.stringify(doc.metadata || {})}`);
    const id = await insertDocument(req, {
      ...doc,
      legal_entity_id: args.entityId,
      location_id: args.locationId || null,
      import_batch_id: batch.batchId,
      source: args.source,
      external_id: text(doc.external_id) || rowIdentity,
      source_url: args.sourceUrl || null,
      source_file_id: args.sourceFileId || null,
      file_name: args.fileName,
      mime_type: args.mimeType,
      content_sha256: rowHash,
      nav_reporting_owner: "external",
      nav_excluded: true,
      metadata: {
        ...doc.metadata,
        import_profile: args.profile === "altegio" ? "altegio_export" : "generic_file",
        source_file_sha256: batch.digest,
      },
    });
    if (id) imported += 1; else duplicates += 1;
  }
  await db.query(`UPDATE external_financial_import_batches SET imported_count=$2,duplicate_count=$3 WHERE id=$1::uuid`, [batch.batchId, imported, duplicates]);
  return { imported, duplicates, rows: docs.length, duplicate_batch: false, batch_id: batch.batchId };
}

async function googleToken() {
  const direct = text(process.env.GOOGLE_DRIVE_ACCESS_TOKEN);
  if (direct) return direct;
  const email = text(process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL);
  const key = text(process.env.GOOGLE_DRIVE_PRIVATE_KEY).replace(/\\n/g, "\n");
  if (!email || !key) throw Object.assign(new Error("A Google Drive szolgáltatásfiók nincs konfigurálva."), { status: 409, code: "GOOGLE_DRIVE_NOT_CONFIGURED" });
  const assertion = jwt.sign({ iss: email, scope: "https://www.googleapis.com/auth/drive.readonly", aud: "https://oauth2.googleapis.com/token" }, key, { algorithm: "RS256", expiresIn: "55m" });
  const body = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion });
  const r = await axios.post("https://oauth2.googleapis.com/token", body.toString(), { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 15000 });
  return String(r.data?.access_token || "");
}
async function driveBytes(token: string, file: any) {
  const sheets = file.mimeType === "application/vnd.google-apps.spreadsheet";
  const url = sheets ? `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}/export` : `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}`;
  const r = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}` },
    params: sheets ? { mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } : { alt: "media" },
    responseType: "arraybuffer",
    timeout: 30000,
  });
  return Buffer.from(r.data);
}

router.get("/status", async (_req: AuthRequest, res: Response) => {
  try {
    await ensureSchema();
    return res.json({
      ok: true,
      providers: {
        invee: { mode: "manual_external", api: false },
        google_drive: { configured: Boolean(process.env.GOOGLE_DRIVE_ACCESS_TOKEN || (process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_DRIVE_PRIVATE_KEY)) },
        altegio: { mode: "export_file", api: false, configured: true, accepted: ["csv", "xls", "xlsx"] },
      },
      nav_guard: "A külső bizonylatok nem kerülnek a vir_receipts táblába és alapértelmezetten ki vannak zárva a VIR saját NAV nyugtakötegeiből.",
    });
  } catch (e: any) {
    return res.status(500).json({ ok: false, message: e?.message });
  }
});

router.get("/settings", async (req: AuthRequest, res: Response) => {
  try {
    await ensureSchema();
    const entityId = text(req.query.legal_entity_id);
    const locationId = text(req.query.location_id) || null;
    if (!(await requireEntity(req, res, entityId, locationId))) return;
    return res.json({ ok: true, settings: await settingsFor(entityId, locationId) });
  } catch (e: any) {
    return res.status(500).json({ ok: false, message: e?.message });
  }
});

router.put("/settings", async (req: AuthRequest, res: Response) => {
  try {
    await ensureSchema();
    const entityId = text(req.body?.legal_entity_id);
    const locationId = text(req.body?.location_id) || null;
    if (!(await requireEntity(req, res, entityId, locationId))) return;
    const provider = PROVIDERS.has(text(req.body?.receipt_provider)) ? text(req.body.receipt_provider) : "internal";
    const navOwner = NAV_OWNERS.has(text(req.body?.nav_reporting_owner)) ? text(req.body.nav_reporting_owner) : (provider === "internal" ? "vir" : "external");
    const values = [entityId, locationId, provider, text(req.body?.drive_folder_id) || null, text(req.body?.external_account_ref) || null, navOwner, req.body?.active !== false, actor(req)];
    let q = await db.query(`UPDATE legal_entity_document_settings SET receipt_provider=$3,drive_folder_id=$4,altegio_location_id=NULL,external_account_ref=$5,nav_reporting_owner=$6,active=$7,updated_by=$8,updated_at=now() WHERE legal_entity_id=$1::uuid AND location_id IS NOT DISTINCT FROM $2::uuid RETURNING *`, values);
    if (!q.rows[0]) {
      q = await db.query(`INSERT INTO legal_entity_document_settings(legal_entity_id,location_id,receipt_provider,drive_folder_id,altegio_location_id,external_account_ref,nav_reporting_owner,active,updated_by) VALUES($1::uuid,$2::uuid,$3,$4,NULL,$5,$6,$7,$8) RETURNING *`, values);
    }
    return res.json({ ok: true, settings: q.rows[0] });
  } catch (e: any) {
    return res.status(500).json({ ok: false, message: e?.message });
  }
});

router.get("/documents", async (req: AuthRequest, res: Response) => {
  try {
    await ensureSchema();
    const entityId = text(req.query.legal_entity_id);
    const locationId = text(req.query.location_id) || null;
    if (entityId && !(await requireEntity(req, res, entityId, locationId))) return;
    const params: any[] = [];
    const where: string[] = [];
    if (entityId) { params.push(entityId); where.push(`d.legal_entity_id=$${params.length}::uuid`); }
    if (locationId) { params.push(locationId); where.push(`d.location_id::text=$${params.length}`); }
    if (req.query.status) { params.push(text(req.query.status)); where.push(`d.status=$${params.length}`); }
    if (req.query.source) { params.push(text(req.query.source)); where.push(`d.source=$${params.length}`); }
    if (!isGlobal(req)) { params.push(text(req.user?.location_id)); where.push(`d.location_id::text=$${params.length}`); }
    const rows = (await db.query(`
      SELECT d.*,e.legal_name,l.name location_name,
             (f.document_id IS NOT NULL OR b.id IS NOT NULL) has_file,
             b.import_profile,b.file_name import_file_name,b.content_sha256 import_file_sha256
        FROM external_financial_documents d
        JOIN legal_entities e ON e.id=d.legal_entity_id
        LEFT JOIN locations l ON l.id=d.location_id
        LEFT JOIN external_financial_document_files f ON f.document_id=d.id
        LEFT JOIN external_financial_import_batches b ON b.id=d.import_batch_id
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY d.issue_date DESC NULLS LAST,d.created_at DESC LIMIT 500`, params)).rows;
    return res.json({ ok: true, rows });
  } catch (e: any) {
    return res.status(500).json({ ok: false, message: e?.message });
  }
});

router.post("/documents", async (req: AuthRequest, res: Response) => {
  try {
    await ensureSchema();
    const entityId = text(req.body?.legal_entity_id);
    const locationId = text(req.body?.location_id) || null;
    if (!(await requireEntity(req, res, entityId, locationId))) return;
    const source = SOURCES.has(text(req.body?.source)) ? text(req.body.source) : "invee";
    const base = commonRowToDocument(req.body || {}, req.body || {});
    const id = await insertDocument(req, {
      ...base,
      legal_entity_id: entityId,
      location_id: locationId,
      source,
      external_id: text(req.body?.external_id) || text(req.body?.external_document_number) || null,
      source_url: text(req.body?.source_url) || null,
      source_file_id: null,
      file_name: null,
      mime_type: null,
      content_sha256: null,
      nav_reporting_owner: "external",
      nav_excluded: true,
      metadata: { ...(req.body?.metadata || {}), manual_entry: true },
    });
    if (!id) return res.status(409).json({ ok: false, code: "DUPLICATE", message: "Ez a külső bizonylat már szerepel a VIR-ben." });
    return res.status(201).json({ ok: true, id });
  } catch (e: any) {
    return res.status(e?.status || 500).json({ ok: false, code: e?.code, message: e?.message });
  }
});

router.post("/upload", upload.single("file"), async (req: AuthRequest, res: Response) => {
  try {
    const entityId = text(req.body?.legal_entity_id);
    const locationId = text(req.body?.location_id) || null;
    if (!(await requireEntity(req, res, entityId, locationId))) return;
    if (!req.file) return res.status(400).json({ ok: false, message: "Fájl feltöltése kötelező." });
    const source = SOURCES.has(text(req.body?.source)) ? text(req.body.source) : "file_upload";
    const profile: "generic" | "altegio" = source === "altegio" ? "altegio" : "generic";
    const result = await importBuffer(req, {
      entityId,
      locationId,
      source,
      profile,
      fileName: req.file.originalname,
      mimeType: req.file.mimetype || "application/octet-stream",
      buffer: req.file.buffer,
    });
    return res.json({ ok: true, ...result, source, profile: profile === "altegio" ? "altegio_export" : "generic_file" });
  } catch (e: any) {
    return res.status(e?.status || 500).json({ ok: false, code: e?.code, message: e?.message || "A fájl nem importálható." });
  }
});

router.post("/altegio/import", upload.single("file"), async (req: AuthRequest, res: Response) => {
  try {
    const entityId = text(req.body?.legal_entity_id);
    const locationId = text(req.body?.location_id) || null;
    if (!(await requireEntity(req, res, entityId, locationId))) return;
    if (!req.file) return res.status(400).json({ ok: false, message: "Válassza ki az Altegio exportfájlt." });
    const ext = req.file.originalname.toLowerCase().split(".").pop() || "";
    if (!["csv", "xls", "xlsx"].includes(ext)) return res.status(400).json({ ok: false, code: "ALTEGIO_EXPORT_FORMAT", message: "Az Altegio export import CSV, XLS vagy XLSX fájlt fogad." });
    const result = await importBuffer(req, {
      entityId,
      locationId,
      source: "altegio",
      profile: "altegio",
      fileName: req.file.originalname,
      mimeType: req.file.mimetype || "application/octet-stream",
      buffer: req.file.buffer,
    });
    return res.json({
      ok: true,
      ...result,
      source: "altegio",
      mode: "export_file",
      message: result.duplicate_batch ? "Ez az Altegio exportfájl már korábban be lett olvasva." : "Az Altegio exportfájl beolvasása elkészült.",
    });
  } catch (e: any) {
    return res.status(e?.status || 500).json({ ok: false, code: e?.code, message: e?.message || "Az Altegio exportfájl nem importálható." });
  }
});

router.post("/altegio/sync", (_req: AuthRequest, res: Response) => {
  return res.status(410).json({
    ok: false,
    code: "ALTEGIO_API_DISABLED",
    message: "A VIR nem használ élő Altegio API-kapcsolatot. Exportálja az adatokat Altegio-ból CSV/XLS/XLSX fájlba, majd töltse fel az Altegio export importnál.",
  });
});

router.post("/google-drive/sync", async (req: AuthRequest, res: Response) => {
  try {
    await ensureSchema();
    const entityId = text(req.body?.legal_entity_id);
    const locationId = text(req.body?.location_id) || null;
    if (!(await requireEntity(req, res, entityId, locationId))) return;
    const settings = await settingsFor(entityId, locationId);
    const folderId = text(req.body?.folder_id) || text(settings?.drive_folder_id);
    if (!folderId) return res.status(409).json({ ok: false, code: "DRIVE_FOLDER_REQUIRED", message: "A céghez nincs Google Drive mappa beállítva." });
    const token = await googleToken();
    let pageToken = "";
    let imported = 0;
    let duplicates = 0;
    let skipped = 0;
    do {
      const r = await axios.get("https://www.googleapis.com/drive/v3/files", {
        headers: { Authorization: `Bearer ${token}` },
        params: {
          q: `'${folderId.replace(/'/g, "\\'")}' in parents and trashed=false`,
          fields: "nextPageToken,files(id,name,mimeType,webViewLink,modifiedTime)",
          pageSize: 100,
          pageToken: pageToken || undefined,
        },
        timeout: 20000,
      });
      for (const file of r.data?.files || []) {
        try {
          const name = String(file.name || "drive-file");
          const ext = name.toLowerCase().split(".").pop() || "";
          const isSheet = file.mimeType === "application/vnd.google-apps.spreadsheet";
          if (!isSheet && !FILE_EXTENSIONS.has(ext)) { skipped += 1; continue; }
          const bytes = await driveBytes(token, file);
          const fileName = isSheet ? `${name}.xlsx` : name;
          const mimeType = isSheet ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : String(file.mimeType || "application/octet-stream");
          const result = await importBuffer(req, {
            entityId,
            locationId,
            source: "google_drive",
            profile: "generic",
            fileName,
            mimeType,
            buffer: bytes,
            sourceFileId: String(file.id),
            sourceUrl: text(file.webViewLink) || null,
          });
          imported += Number(result.imported || 0);
          duplicates += Number(result.duplicates || 0);
        } catch {
          skipped += 1;
        }
      }
      pageToken = String(r.data?.nextPageToken || "");
    } while (pageToken);
    return res.json({ ok: true, imported, duplicates, skipped });
  } catch (e: any) {
    return res.status(e?.status || 500).json({ ok: false, code: e?.code, message: e?.message || "A Google Drive szinkron sikertelen." });
  }
});

router.patch("/documents/:id", async (req: AuthRequest, res: Response) => {
  try {
    await ensureSchema();
    const id = text(req.params.id);
    const current = (await db.query(`SELECT * FROM external_financial_documents WHERE id=$1::uuid`, [id])).rows[0];
    if (!current) return res.status(404).json({ ok: false, message: "A bizonylat nem található." });
    if (!(await requireEntity(req, res, String(current.legal_entity_id), current.location_id ? String(current.location_id) : null))) return;
    const type = DOC_TYPES.has(text(req.body?.document_type)) ? text(req.body.document_type) : current.document_type;
    const q = await db.query(`UPDATE external_financial_documents SET document_type=$2,external_document_number=$3,issue_date=$4::date,counterparty_name=$5,counterparty_tax_number=$6,currency=$7,net_amount=$8,vat_amount=$9,gross_amount=$10,payment_method=$11,work_order_id=$12,updated_at=now() WHERE id=$1::uuid RETURNING *`, [
      id, type, text(req.body?.external_document_number) || null, isoDate(req.body?.issue_date), text(req.body?.counterparty_name) || null,
      text(req.body?.counterparty_tax_number) || null, (text(req.body?.currency) || "HUF").toUpperCase().slice(0, 3), money(req.body?.net_amount),
      money(req.body?.vat_amount), money(req.body?.gross_amount), text(req.body?.payment_method) || null, text(req.body?.work_order_id) || null,
    ]);
    await event(id, req, "UPDATED", { fields: ["document_type", "external_document_number", "issue_date", "counterparty_name", "amounts", "payment_method", "work_order_id"] });
    return res.json({ ok: true, document: q.rows[0] });
  } catch (e: any) {
    return res.status(500).json({ ok: false, message: e?.message || "A bizonylat nem módosítható." });
  }
});

router.post("/documents/:id/approve", async (req: AuthRequest, res: Response) => {
  try {
    await ensureSchema();
    const id = text(req.params.id);
    const current = (await db.query(`SELECT * FROM external_financial_documents WHERE id=$1::uuid`, [id])).rows[0];
    if (!current) return res.status(404).json({ ok: false, message: "A bizonylat nem található." });
    if (!(await requireEntity(req, res, String(current.legal_entity_id), current.location_id ? String(current.location_id) : null))) return;
    if (!current.external_document_number || !current.issue_date) return res.status(409).json({ ok: false, message: "Jóváhagyás előtt a bizonylatszám és a dátum kötelező." });
    const q = await db.query(`UPDATE external_financial_documents SET status='approved',nav_reporting_owner='external',nav_excluded=true,reviewed_by=$2,reviewed_at=now(),updated_at=now() WHERE id=$1::uuid RETURNING *`, [id, actor(req)]);
    await event(id, req, "APPROVED", { nav_reporting_owner: "external", nav_excluded: true });
    return res.json({ ok: true, document: q.rows[0] });
  } catch (e: any) {
    return res.status(500).json({ ok: false, message: e?.message || "A bizonylat nem hagyható jóvá." });
  }
});

router.post("/documents/:id/reject", async (req: AuthRequest, res: Response) => {
  try {
    await ensureSchema();
    const id = text(req.params.id);
    const current = (await db.query(`SELECT * FROM external_financial_documents WHERE id=$1::uuid`, [id])).rows[0];
    if (!current) return res.status(404).json({ ok: false, message: "A bizonylat nem található." });
    if (!(await requireEntity(req, res, String(current.legal_entity_id), current.location_id ? String(current.location_id) : null))) return;
    const reason = text(req.body?.reason);
    if (!reason) return res.status(400).json({ ok: false, message: "Az elutasítás oka kötelező." });
    const q = await db.query(`UPDATE external_financial_documents SET status='rejected',nav_excluded=true,reviewed_by=$2,reviewed_at=now(),updated_at=now() WHERE id=$1::uuid RETURNING *`, [id, actor(req)]);
    await event(id, req, "REJECTED", { reason });
    return res.json({ ok: true, document: q.rows[0] });
  } catch (e: any) {
    return res.status(500).json({ ok: false, message: e?.message || "A bizonylat nem utasítható el." });
  }
});

router.get("/documents/:id/file", async (req: AuthRequest, res: Response) => {
  try {
    await ensureSchema();
    const id = text(req.params.id);
    const current = (await db.query(`SELECT * FROM external_financial_documents WHERE id=$1::uuid`, [id])).rows[0];
    if (!current) return res.status(404).json({ ok: false, message: "A bizonylat nem található." });
    if (!(await requireEntity(req, res, String(current.legal_entity_id), current.location_id ? String(current.location_id) : null))) return;
    let file = (await db.query(`SELECT payload,file_name,mime_type FROM external_financial_document_files WHERE document_id=$1::uuid`, [id])).rows[0];
    if (!file && current.import_batch_id) file = (await db.query(`SELECT payload,file_name,mime_type FROM external_financial_import_batches WHERE id=$1::uuid`, [current.import_batch_id])).rows[0];
    if (!file) return res.status(404).json({ ok: false, message: "Ehhez a bizonylathoz nincs archivált forrásfájl." });
    res.setHeader("Content-Type", file.mime_type || "application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(file.file_name || "document")}`);
    return res.send(file.payload);
  } catch (e: any) {
    return res.status(500).json({ ok: false, message: e?.message || "A fájl nem tölthető le." });
  }
});

export default router;
