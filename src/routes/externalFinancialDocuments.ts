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
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
router.use(requireAuth);
router.use(requireRoles("admin", "manager", "accounting", "bookkeeper", "location_manager", "salon_manager"));

const GLOBAL = new Set(["admin", "manager", "accounting", "bookkeeper"]);
const SOURCES = new Set(["invee", "google_drive", "altegio", "file_upload", "manual"]);
const DOC_TYPES = new Set(["invoice", "receipt", "credit_note", "void_receipt", "transaction", "other"]);
const PROVIDERS = new Set(["internal", "invee_manual", "nav_epg", "hardware_epg"]);
const NAV_OWNERS = new Set(["vir", "external", "not_applicable"]);
const money = (v: unknown) => Math.round((Number(v) || 0) * 100) / 100;
const text = (v: unknown) => String(v ?? "").trim();
const actor = (req: AuthRequest) => req.user?.email || String(req.user?.id || "");
const hash = (buf: Buffer) => crypto.createHash("sha256").update(buf).digest("hex");
const norm = (v: unknown) => text(v).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
const parseNumber = (v: unknown) => {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const s = text(v).replace(/\s/g, "").replace(/(?<=\d)\.(?=\d{3}(\D|$))/g, "").replace(",", ".").replace(/[^0-9.+-]/g, "");
  const n = Number(s); return Number.isFinite(n) ? n : 0;
};
const isoDate = (v: unknown): string | null => {
  const s = text(v); if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const hu = s.match(/^(\d{4})[.\/-](\d{1,2})[.\/-](\d{1,2})/); if (hu) return `${hu[1]}-${hu[2].padStart(2, "0")}-${hu[3].padStart(2, "0")}`;
  const d = new Date(s); return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : null;
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

    CREATE TABLE IF NOT EXISTS external_financial_documents(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      legal_entity_id uuid NOT NULL REFERENCES legal_entities(id) ON DELETE RESTRICT,
      location_id uuid REFERENCES locations(id) ON DELETE RESTRICT,
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

function isGlobal(req: AuthRequest) { return parseRoleKeys(req.user?.role).some((r) => GLOBAL.has(r)); }
async function canUseEntity(req: AuthRequest, entityId: string, locationId?: string | null) {
  if (isGlobal(req)) return true;
  const own = text(req.user?.location_id); if (!own) return false;
  if (locationId && locationId !== own) return false;
  return Boolean((await db.query(`SELECT 1 FROM legal_entity_locations WHERE legal_entity_id=$1::uuid AND location_id::text=$2 AND active=true`, [entityId, own])).rows[0]);
}
async function requireEntity(req: AuthRequest, res: Response, entityId: string, locationId?: string | null) {
  if (!entityId) { res.status(400).json({ ok: false, message: "A kibocsátó cég kiválasztása kötelező." }); return false; }
  if (!(await canUseEntity(req, entityId, locationId))) { res.status(403).json({ ok: false, message: "Ehhez a céghez vagy telephelyhez nincs jogosultsága." }); return false; }
  return true;
}
async function event(documentId: string, req: AuthRequest, eventType: string, payload: unknown = {}) {
  await db.query(`INSERT INTO external_financial_document_events(document_id,event_type,actor,payload) VALUES($1::uuid,$2,$3,$4::jsonb)`, [documentId, eventType, actor(req), JSON.stringify(payload || {})]);
}

function rowValue(row: Record<string, unknown>, names: string[]) {
  const normalized = new Map(Object.entries(row).map(([k, v]) => [norm(k), v]));
  for (const name of names) { const v = normalized.get(norm(name)); if (v !== undefined && v !== null && text(v) !== "") return v; }
  return null;
}
function rowToDocument(row: Record<string, unknown>, defaults: any = {}) {
  const number = rowValue(row, ["document_number","invoice_number","receipt_number","bizonylatszam","bizonylat_szam","szamlaszam","szamla_sorszam","nyugtaszam","number","id"]);
  const rawType = norm(rowValue(row, ["document_type","type","tipus","bizonylat_tipus"]) || defaults.document_type || "other");
  const documentType = rawType.includes("invoice") || rawType.includes("szamla") ? "invoice" : rawType.includes("receipt") || rawType.includes("nyugta") ? "receipt" : rawType.includes("credit") || rawType.includes("storno") ? "credit_note" : DOC_TYPES.has(rawType) ? rawType : defaults.document_type || "other";
  const net = parseNumber(rowValue(row,["net_amount","netto","netto_osszeg","net"]));
  const vat = parseNumber(rowValue(row,["vat_amount","afa","afa_osszeg","tax_amount","vat"]));
  let gross = parseNumber(rowValue(row,["gross_amount","brutto","brutto_osszeg","total","amount","osszeg"]));
  if (!gross && (net || vat)) gross = net + vat;
  return {
    document_type: documentType,
    external_document_number: text(number) || defaults.external_document_number || null,
    issue_date: isoDate(rowValue(row,["issue_date","date","datum","kiallitas_datum","created_at"])) || defaults.issue_date || null,
    counterparty_name: text(rowValue(row,["counterparty_name","customer_name","supplier_name","partner","vevo","szallito","nev"])) || defaults.counterparty_name || null,
    counterparty_tax_number: text(rowValue(row,["tax_number","counterparty_tax_number","adoszam","vevo_adoszam","szallito_adoszam"])) || defaults.counterparty_tax_number || null,
    currency: (text(rowValue(row,["currency","penznem"])) || defaults.currency || "HUF").toUpperCase().slice(0,3),
    net_amount: money(net || defaults.net_amount || 0), vat_amount: money(vat || defaults.vat_amount || 0), gross_amount: money(gross || defaults.gross_amount || 0),
    payment_method: text(rowValue(row,["payment_method","fizetesi_mod","payment"])) || defaults.payment_method || null,
    metadata: row,
  };
}
function xmlTag(xml: string, names: string[]) {
  for (const n of names) { const safe=n.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"); const m=xml.match(new RegExp(`<(?:\\w+:)?${safe}[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${safe}>`,"i")); if(m)return m[1].replace(/<[^>]+>/g,"").trim(); }
  return null;
}
function xmlToDocument(xml: string) {
  const net=parseNumber(xmlTag(xml,["invoiceNetAmount","netAmount","nettoOsszeg"])); const vat=parseNumber(xmlTag(xml,["invoiceVatAmount","vatAmount","afaOsszeg"]));
  return { document_type:"invoice", external_document_number:xmlTag(xml,["invoiceNumber","invoiceNo","szamlaSorszam"]), issue_date:isoDate(xmlTag(xml,["invoiceIssueDate","issueDate","kiallitasDatum"])), counterparty_name:xmlTag(xml,["customerName","supplierName","name"]), counterparty_tax_number:xmlTag(xml,["taxpayerId","taxNumber","adoszam"]), currency:(xmlTag(xml,["currencyCode","currency","penznem"])||"HUF").toUpperCase().slice(0,3), net_amount:money(net), vat_amount:money(vat), gross_amount:money(parseNumber(xmlTag(xml,["invoiceGrossAmount","grossAmount","bruttoOsszeg"]))||net+vat), payment_method:null, metadata:{xml_import:true} };
}
function fileDocuments(fileName: string, mime: string, buf: Buffer) {
  const ext = fileName.toLowerCase().split(".").pop() || "";
  if (ext === "csv" || ext === "xlsx" || ext === "xls") {
    const wb = XLSX.read(buf, { type: "buffer", cellDates: true }); const ws = wb.Sheets[wb.SheetNames[0]]; const rows = XLSX.utils.sheet_to_json<Record<string,unknown>>(ws, { defval: null });
    return rows.map((r) => rowToDocument(r));
  }
  if (ext === "xml" || /xml/i.test(mime)) return [xmlToDocument(buf.toString("utf8"))];
  return [{ document_type: /pdf/i.test(mime) || ext === "pdf" ? "invoice" : "other", external_document_number: fileName.replace(/\.[^.]+$/, ""), issue_date: null, counterparty_name: null, counterparty_tax_number: null, currency: "HUF", net_amount:0, vat_amount:0, gross_amount:0, payment_method:null, metadata:{manual_review_required:true,file_only:true} }];
}

type InsertInput = ReturnType<typeof rowToDocument> & { legal_entity_id:string; location_id?:string|null; source:string; external_id?:string|null; source_url?:string|null; source_file_id?:string|null; file_name?:string|null; mime_type?:string|null; content_sha256?:string|null; nav_reporting_owner?:string; nav_excluded?:boolean; metadata?:Record<string,unknown> };
async function insertDocument(req: AuthRequest, input: InsertInput, file?: Buffer | null) {
  const navOwner = NAV_OWNERS.has(text(input.nav_reporting_owner)) ? text(input.nav_reporting_owner) : "external";
  const navExcluded = navOwner === "external" ? true : input.nav_excluded !== false;
  const q = await db.query(`INSERT INTO external_financial_documents(legal_entity_id,location_id,source,document_type,external_id,external_document_number,issue_date,counterparty_name,counterparty_tax_number,currency,net_amount,vat_amount,gross_amount,payment_method,source_url,source_file_id,file_name,mime_type,content_sha256,nav_reporting_owner,nav_excluded,metadata,created_by)
    VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7::date,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22::jsonb,$23)
    ON CONFLICT DO NOTHING RETURNING id::text`, [input.legal_entity_id,input.location_id||null,input.source,input.document_type,input.external_id||null,input.external_document_number||null,input.issue_date||null,input.counterparty_name||null,input.counterparty_tax_number||null,input.currency||"HUF",input.net_amount||0,input.vat_amount||0,input.gross_amount||0,input.payment_method||null,input.source_url||null,input.source_file_id||null,input.file_name||null,input.mime_type||null,input.content_sha256||null,navOwner,navExcluded,JSON.stringify(input.metadata||{}),actor(req)]);
  const id = q.rows[0]?.id ? String(q.rows[0].id) : null;
  if (id && file && input.file_name && input.mime_type) await db.query(`INSERT INTO external_financial_document_files(document_id,payload,file_name,mime_type,size_bytes) VALUES($1::uuid,$2,$3,$4,$5) ON CONFLICT(document_id) DO NOTHING`,[id,file,input.file_name,input.mime_type,file.length]);
  if (id) await event(id,req,"IMPORTED",{source:input.source,nav_reporting_owner:navOwner,nav_excluded:navExcluded});
  return id;
}

async function settingsFor(entityId:string,locationId?:string|null){await ensureSchema();return (await db.query(`SELECT * FROM legal_entity_document_settings WHERE legal_entity_id=$1::uuid AND (location_id::text=$2 OR location_id IS NULL) ORDER BY location_id NULLS LAST LIMIT 1`,[entityId,locationId||""])).rows[0]||null;}

async function googleToken() {
  const direct=text(process.env.GOOGLE_DRIVE_ACCESS_TOKEN); if(direct)return direct;
  const email=text(process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL), key=text(process.env.GOOGLE_DRIVE_PRIVATE_KEY).replace(/\\n/g,"\n");
  if(!email||!key)throw Object.assign(new Error("A Google Drive szolgáltatásfiók nincs konfigurálva."),{status:409,code:"GOOGLE_DRIVE_NOT_CONFIGURED"});
  const assertion=jwt.sign({iss:email,scope:"https://www.googleapis.com/auth/drive.readonly",aud:"https://oauth2.googleapis.com/token"},key,{algorithm:"RS256",expiresIn:"55m"});
  const body=new URLSearchParams({grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer",assertion});
  const r=await axios.post("https://oauth2.googleapis.com/token",body.toString(),{headers:{"Content-Type":"application/x-www-form-urlencoded"},timeout:15000}); return String(r.data?.access_token||"");
}
async function driveBytes(token:string,file:any){
  const sheets=file.mimeType==="application/vnd.google-apps.spreadsheet"; const url=sheets?`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}/export`:`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}`;
  const r=await axios.get(url,{headers:{Authorization:`Bearer ${token}`},params:sheets?{mimeType:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}:{alt:"media"},responseType:"arraybuffer",timeout:30000}); return Buffer.from(r.data);
}

router.get("/status",async(req:AuthRequest,res:Response)=>{try{await ensureSchema();return res.json({ok:true,providers:{invee:{mode:"manual_external",api:false},google_drive:{configured:Boolean(process.env.GOOGLE_DRIVE_ACCESS_TOKEN||(process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL&&process.env.GOOGLE_DRIVE_PRIVATE_KEY))},altegio:{configured:Boolean(process.env.ALTEGIO_PARTNER_TOKEN&&process.env.ALTEGIO_USER_TOKEN),base_url:"https://api.alteg.io/api/v1"}},nav_guard:"external documents are stored outside vir_receipts and are excluded from VIR receipt NAV batches by default"});}catch(e:any){return res.status(500).json({ok:false,message:e?.message})}});

router.get("/settings",async(req:AuthRequest,res:Response)=>{try{await ensureSchema();const entityId=text(req.query.legal_entity_id),locationId=text(req.query.location_id)||null;if(!await requireEntity(req,res,entityId,locationId))return;return res.json({ok:true,settings:await settingsFor(entityId,locationId)});}catch(e:any){return res.status(500).json({ok:false,message:e?.message})}});
router.put("/settings",async(req:AuthRequest,res:Response)=>{try{await ensureSchema();const entityId=text(req.body?.legal_entity_id),locationId=text(req.body?.location_id)||null;if(!await requireEntity(req,res,entityId,locationId))return;const provider=PROVIDERS.has(text(req.body?.receipt_provider))?text(req.body.receipt_provider):"internal";const navOwner=NAV_OWNERS.has(text(req.body?.nav_reporting_owner))?text(req.body.nav_reporting_owner):(provider==="internal"?"vir":"external");const q=await db.query(`INSERT INTO legal_entity_document_settings(legal_entity_id,location_id,receipt_provider,drive_folder_id,altegio_location_id,external_account_ref,nav_reporting_owner,active,updated_by) VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(legal_entity_id,COALESCE(location_id,'00000000-0000-0000-0000-000000000000'::uuid)) DO UPDATE SET receipt_provider=EXCLUDED.receipt_provider,drive_folder_id=EXCLUDED.drive_folder_id,altegio_location_id=EXCLUDED.altegio_location_id,external_account_ref=EXCLUDED.external_account_ref,nav_reporting_owner=EXCLUDED.nav_reporting_owner,active=EXCLUDED.active,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING *`,[entityId,locationId,provider,text(req.body?.drive_folder_id)||null,text(req.body?.altegio_location_id)||null,text(req.body?.external_account_ref)||null,navOwner,req.body?.active!==false,actor(req)]);return res.json({ok:true,settings:q.rows[0]});}catch(e:any){return res.status(500).json({ok:false,message:e?.message})}});

router.get("/documents",async(req:AuthRequest,res:Response)=>{try{await ensureSchema();const entityId=text(req.query.legal_entity_id),locationId=text(req.query.location_id)||null;if(entityId&&!await requireEntity(req,res,entityId,locationId))return;const params:any[]=[];const where:string[]=[];if(entityId){params.push(entityId);where.push(`d.legal_entity_id=$${params.length}::uuid`)}if(locationId){params.push(locationId);where.push(`d.location_id::text=$${params.length}`)}if(req.query.status){params.push(text(req.query.status));where.push(`d.status=$${params.length}`)}if(req.query.source){params.push(text(req.query.source));where.push(`d.source=$${params.length}`)}if(!isGlobal(req)){params.push(text(req.user?.location_id));where.push(`d.location_id::text=$${params.length}`)}const rows=(await db.query(`SELECT d.*,e.legal_name,l.name location_name,(f.document_id IS NOT NULL) has_file FROM external_financial_documents d JOIN legal_entities e ON e.id=d.legal_entity_id LEFT JOIN locations l ON l.id=d.location_id LEFT JOIN external_financial_document_files f ON f.document_id=d.id ${where.length?`WHERE ${where.join(" AND ")}`:""} ORDER BY d.issue_date DESC NULLS LAST,d.created_at DESC LIMIT 500`,params)).rows;return res.json({ok:true,rows});}catch(e:any){return res.status(500).json({ok:false,message:e?.message})}});

router.post("/documents",async(req:AuthRequest,res:Response)=>{try{await ensureSchema();const entityId=text(req.body?.legal_entity_id),locationId=text(req.body?.location_id)||null;if(!await requireEntity(req,res,entityId,locationId))return;const source=SOURCES.has(text(req.body?.source))?text(req.body.source):"invee";const base=rowToDocument(req.body||{},req.body||{});const id=await insertDocument(req,{...base,legal_entity_id:entityId,location_id:locationId,source,external_id:text(req.body?.external_id)||text(req.body?.external_document_number)||null,source_url:text(req.body?.source_url)||null,source_file_id:null,file_name:null,mime_type:null,content_sha256:null,nav_reporting_owner:"external",nav_excluded:true,metadata:{...(req.body?.metadata||{}),manual_entry:true}});if(!id)return res.status(409).json({ok:false,code:"DUPLICATE",message:"Ez a külső bizonylat már szerepel a VIR-ben."});return res.status(201).json({ok:true,id});}catch(e:any){return res.status(e?.status||500).json({ok:false,code:e?.code,message:e?.message})}});

router.post("/upload",upload.single("file"),async(req:AuthRequest,res:Response)=>{try{await ensureSchema();const entityId=text(req.body?.legal_entity_id),locationId=text(req.body?.location_id)||null;if(!await requireEntity(req,res,entityId,locationId))return;if(!req.file?.buffer)return res.status(400).json({ok:false,message:"Fájl szükséges."});const source=SOURCES.has(text(req.body?.source))?text(req.body.source):"file_upload";const docs=fileDocuments(req.file.originalname,req.file.mimetype,req.file.buffer);let imported=0,duplicates=0;for(let i=0;i<docs.length;i++){const d=docs[i] as any;const oneFile=docs.length===1?req.file.buffer:null;const sha=docs.length===1?hash(req.file.buffer):null;const id=await insertDocument(req,{...d,legal_entity_id:entityId,location_id:locationId,source,external_id:d.external_document_number?`${source}:${d.external_document_number}`:docs.length===1?`${source}:sha256:${sha}`:null,file_name:docs.length===1?req.file.originalname:null,mime_type:docs.length===1?req.file.mimetype:null,content_sha256:sha,nav_reporting_owner:"external",nav_excluded:true,metadata:{...(d.metadata||{}),source_row:i+1}},oneFile);id?imported++:duplicates++;}return res.json({ok:true,source,rows:docs.length,imported,duplicates,review_required:true});}catch(e:any){return res.status(e?.status||500).json({ok:false,code:e?.code,message:e?.message})}});

router.post("/google-drive/sync",async(req:AuthRequest,res:Response)=>{try{await ensureSchema();const entityId=text(req.body?.legal_entity_id),locationId=text(req.body?.location_id)||null;if(!await requireEntity(req,res,entityId,locationId))return;const settings=await settingsFor(entityId,locationId),folderId=text(req.body?.folder_id)||text(settings?.drive_folder_id)||text(process.env.GOOGLE_DRIVE_FOLDER_ID);if(!folderId)return res.status(409).json({ok:false,code:"DRIVE_FOLDER_MISSING",message:"Ehhez a céghez nincs Google Drive mappa beállítva."});const token=await googleToken();const list=await axios.get("https://www.googleapis.com/drive/v3/files",{headers:{Authorization:`Bearer ${token}`},params:{q:`'${folderId.replace(/'/g,"\\'")}' in parents and trashed=false`,pageSize:250,fields:"files(id,name,mimeType,modifiedTime,size,webViewLink)"},timeout:20000});let imported=0,duplicates=0,skipped=0;for(const f of Array.isArray(list.data?.files)?list.data.files:[]){const ext=text(f.name).toLowerCase().split(".").pop()||"";const supported=["pdf","xml","csv","xlsx","xls"].includes(ext)||f.mimeType==="application/vnd.google-apps.spreadsheet";if(!supported){skipped++;continue}const buf=await driveBytes(token,f);const effectiveName=f.mimeType==="application/vnd.google-apps.spreadsheet"?`${f.name}.xlsx`:f.name;const mime=f.mimeType==="application/vnd.google-apps.spreadsheet"?"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":f.mimeType;const docs=fileDocuments(effectiveName,mime,buf);for(let i=0;i<docs.length;i++){const d=docs[i] as any;const single=docs.length===1;const id=await insertDocument(req,{...d,legal_entity_id:entityId,location_id:locationId,source:"google_drive",external_id:single?`drive:${f.id}`:`drive:${f.id}:${i+1}`,source_url:f.webViewLink||null,source_file_id:f.id,file_name:single?effectiveName:null,mime_type:single?mime:null,content_sha256:single?hash(buf):null,nav_reporting_owner:"external",nav_excluded:true,metadata:{...(d.metadata||{}),drive_modified_time:f.modifiedTime,source_row:i+1}},single?buf:null);id?imported++:duplicates++;}}return res.json({ok:true,folder_id:folderId,files:(list.data?.files||[]).length,imported,duplicates,skipped,review_required:true});}catch(e:any){return res.status(e?.status||500).json({ok:false,code:e?.code,message:e?.response?.data?.error?.message||e?.message})}});

router.post("/altegio/sync",async(req:AuthRequest,res:Response)=>{try{await ensureSchema();const entityId=text(req.body?.legal_entity_id),locationId=text(req.body?.location_id)||null;if(!await requireEntity(req,res,entityId,locationId))return;const settings=await settingsFor(entityId,locationId),altegioLocation=text(req.body?.altegio_location_id)||text(settings?.altegio_location_id);if(!altegioLocation)return res.status(409).json({ok:false,code:"ALTEGIO_LOCATION_MISSING",message:"Ehhez a céghez nincs Altegio location ID beállítva."});const partner=text(process.env.ALTEGIO_PARTNER_TOKEN),user=text(process.env.ALTEGIO_USER_TOKEN);if(!partner||!user)return res.status(409).json({ok:false,code:"ALTEGIO_NOT_CONFIGURED",message:"Az Altegio API partner/user token nincs konfigurálva az API környezetben."});const from=text(req.body?.from)||new Date(Date.now()-31*86400000).toISOString().slice(0,10),to=text(req.body?.to)||new Date().toISOString().slice(0,10);const headers={Accept:"application/vnd.api.v2+json",Authorization:`Bearer ${partner}, User ${user}`};const all:any[]=[];for(let page=1;page<=20;page++){const r=await axios.get(`https://api.alteg.io/api/v1/finance_transactions/${encodeURIComponent(altegioLocation)}`,{headers,params:{page,count:200,start_date:from,end_date:to},timeout:20000});const data=Array.isArray(r.data?.data)?r.data.data:Array.isArray(r.data)?r.data:[];all.push(...data);if(data.length<200)break;}const grouped=new Map<string,any>();for(const t of all){const key=String(t.document_id||t.id);const g=grouped.get(key)||{document_id:key,date:t.date,amount:0,items:[],client:t.client,account:t.account};g.amount+=Number(t.amount||0);g.items.push(t);grouped.set(key,g)}let imported=0,duplicates=0;for(const g of grouped.values()){const d:any={document_type:"transaction",external_document_number:`ALT-${g.document_id}`,issue_date:isoDate(g.date),counterparty_name:text(g.client?.name)||null,counterparty_tax_number:null,currency:"HUF",net_amount:0,vat_amount:0,gross_amount:money(g.amount),payment_method:text(g.account?.title)||null,metadata:{altegio_document_id:g.document_id,transactions:g.items}};const id=await insertDocument(req,{...d,legal_entity_id:entityId,location_id:locationId,source:"altegio",external_id:`altegio:${altegioLocation}:${g.document_id}`,source_url:null,source_file_id:null,file_name:null,mime_type:null,content_sha256:null,nav_reporting_owner:"external",nav_excluded:true,metadata:d.metadata});id?imported++:duplicates++;}return res.json({ok:true,from,to,altegio_location_id:altegioLocation,transactions:all.length,documents:grouped.size,imported,duplicates,review_required:true});}catch(e:any){return res.status(e?.status||500).json({ok:false,code:e?.code,message:e?.response?.data?.meta?.message||e?.response?.data?.message||e?.message})}});

router.patch("/documents/:id",async(req:AuthRequest,res:Response)=>{try{await ensureSchema();const before=(await db.query(`SELECT * FROM external_financial_documents WHERE id=$1::uuid`,[req.params.id])).rows[0];if(!before)return res.status(404).json({ok:false,message:"A bizonylat nem található."});if(!await requireEntity(req,res,String(before.legal_entity_id),before.location_id?String(before.location_id):null))return;const type=DOC_TYPES.has(text(req.body?.document_type))?text(req.body.document_type):before.document_type;const q=await db.query(`UPDATE external_financial_documents SET document_type=$2,external_document_number=$3,issue_date=$4::date,counterparty_name=$5,counterparty_tax_number=$6,currency=$7,net_amount=$8,vat_amount=$9,gross_amount=$10,payment_method=$11,work_order_id=$12,updated_at=now() WHERE id=$1::uuid RETURNING *`,[req.params.id,type,text(req.body?.external_document_number)||null,isoDate(req.body?.issue_date),text(req.body?.counterparty_name)||null,text(req.body?.counterparty_tax_number)||null,(text(req.body?.currency)||"HUF").toUpperCase().slice(0,3),money(req.body?.net_amount),money(req.body?.vat_amount),money(req.body?.gross_amount),text(req.body?.payment_method)||null,text(req.body?.work_order_id)||null]);await event(String(req.params.id),req,"EDITED",{before:{external_document_number:before.external_document_number,gross_amount:before.gross_amount}});return res.json({ok:true,document:q.rows[0]});}catch(e:any){return res.status(500).json({ok:false,message:e?.message})}});
router.post("/documents/:id/approve",async(req:AuthRequest,res:Response)=>{try{await ensureSchema();const d=(await db.query(`SELECT * FROM external_financial_documents WHERE id=$1::uuid`,[req.params.id])).rows[0];if(!d)return res.status(404).json({ok:false,message:"A bizonylat nem található."});if(!await requireEntity(req,res,String(d.legal_entity_id),d.location_id?String(d.location_id):null))return;if(!d.external_document_number||!d.issue_date)return res.status(409).json({ok:false,message:"Jóváhagyás előtt a bizonylatszám és a kiállítás dátuma kötelező."});const q=await db.query(`UPDATE external_financial_documents SET status='approved',reviewed_by=$2,reviewed_at=now(),updated_at=now(),nav_excluded=CASE WHEN nav_reporting_owner='external' THEN true ELSE nav_excluded END WHERE id=$1::uuid RETURNING *`,[req.params.id,actor(req)]);await event(String(req.params.id),req,"APPROVED",{nav_excluded:q.rows[0].nav_excluded});return res.json({ok:true,document:q.rows[0]});}catch(e:any){return res.status(500).json({ok:false,message:e?.message})}});
router.post("/documents/:id/reject",async(req:AuthRequest,res:Response)=>{try{await ensureSchema();const d=(await db.query(`SELECT * FROM external_financial_documents WHERE id=$1::uuid`,[req.params.id])).rows[0];if(!d)return res.status(404).json({ok:false,message:"A bizonylat nem található."});if(!await requireEntity(req,res,String(d.legal_entity_id),d.location_id?String(d.location_id):null))return;const q=await db.query(`UPDATE external_financial_documents SET status='rejected',reviewed_by=$2,reviewed_at=now(),metadata=metadata||$3::jsonb,updated_at=now() WHERE id=$1::uuid RETURNING *`,[req.params.id,actor(req),JSON.stringify({rejection_reason:text(req.body?.reason)||null})]);await event(String(req.params.id),req,"REJECTED",{reason:text(req.body?.reason)});return res.json({ok:true,document:q.rows[0]});}catch(e:any){return res.status(500).json({ok:false,message:e?.message})}});
router.get("/documents/:id/file",async(req:AuthRequest,res:Response)=>{try{await ensureSchema();const d=(await db.query(`SELECT * FROM external_financial_documents WHERE id=$1::uuid`,[req.params.id])).rows[0];if(!d)return res.status(404).json({ok:false,message:"A bizonylat nem található."});if(!await requireEntity(req,res,String(d.legal_entity_id),d.location_id?String(d.location_id):null))return;const f=(await db.query(`SELECT * FROM external_financial_document_files WHERE document_id=$1::uuid`,[req.params.id])).rows[0];if(!f)return res.status(404).json({ok:false,message:"Ehhez a bizonylathoz nincs archivált fájl."});res.setHeader("Content-Type",f.mime_type);res.setHeader("Content-Disposition",`inline; filename*=UTF-8''${encodeURIComponent(f.file_name)}`);return res.send(f.payload);}catch(e:any){return res.status(500).json({ok:false,message:e?.message})}});

export default router;
