import { Router, Response } from "express";
import multer from "multer";
import * as XLSX from "xlsx";
import db from "../db";
import { requireAuth } from "../middleware/auth";
import { requireTenantContext, requireTenantRole, TenantAuthRequest } from "../middleware/tenantContext";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
router.use(requireAuth, requireTenantContext, requireTenantRole("owner", "admin"));

const VERSION = 19;
type Provider = "altegio" | "booksy" | "fresha" | "excel" | "csv";
type DuplicatePolicy = "review" | "skip" | "merge" | "create_new";
type FieldAliases = Record<string, string[]>;
type EntityConfig = {
  table: string;
  label: string;
  group: string;
  apply: boolean;
  fields: FieldAliases;
  dedupe: string[];
  blocked_reason?: string | null;
};
type ColumnMeta = {
  column_name: string;
  data_type: string;
  is_nullable: "YES" | "NO";
  column_default: string | null;
  is_identity: "YES" | "NO";
  is_generated: string;
  ordinal_position: number;
};
type ForeignKeyMeta = {
  column_name: string;
  referenced_table: string;
  referenced_column: string;
  tenant_scoped: boolean;
};
type TargetContract = {
  table: string;
  pk: string;
  columns: string[];
  writable_columns: string[];
  required_columns: string[];
  field_map: Record<string, string>;
  dedupe_columns: string[];
  tenant_column: string | null;
  location_column: string | null;
  foreign_keys: ForeignKeyMeta[];
  legacy_scope: boolean;
  apply_supported: boolean;
  blocked_reason: string | null;
};

const PROVIDERS: Record<Provider, any> = {
  altegio: {
    code: "altegio",
    name: "Altegio",
    mode: ["file", "native"],
    description: "Altegio export és meglévő natív importer egy helyen.",
    duplicate_visible: true,
    legacy_tools: [
      { entity: "services", method: "POST", path: "/api/services/import/altegio" },
      { entity: "products", method: "POST", path: "/api/products/import/altegio" },
    ],
  },
  booksy: { code: "booksy", name: "Booksy", mode: ["file"], description: "Booksy CSV/XLSX export migráció." },
  fresha: { code: "fresha", name: "Fresha", mode: ["file"], description: "Fresha CSV/XLSX export migráció." },
  excel: { code: "excel", name: "Excel", mode: ["file"], description: "Általános Excel import automatikus mezőfelismeréssel." },
  csv: { code: "csv", name: "CSV", mode: ["file"], description: "Általános CSV import automatikus mezőfelismeréssel." },
};

const CORE_ENTITY_CONFIG: Record<string, EntityConfig> = {
  clients: {
    table: "clients", label: "Vendégek", group: "Vendégek és CRM", apply: true,
    fields: {
      external_id: ["altegio_client_id", "external_id", "source_id", "api_id", "id"],
      name: ["full_name", "name", "nev", "név", "client_name", "ugyfel", "ügyfél"],
      email: ["email", "e-mail", "mail"], phone: ["phone", "telephone", "mobile", "telefon", "telefonszam", "telefonszám"],
      birth_date: ["birth_date", "birthday", "szuletesi_datum", "születési dátum"], notes: ["notes", "note", "megjegyzes", "megjegyzés"],
    }, dedupe: ["external_id", "email", "phone"],
  },
  employees: {
    table: "employees", label: "Munkatársak", group: "HR és munkatársak", apply: true,
    fields: {
      external_id: ["altegio_staff_id", "external_id", "source_id", "staff_id", "id"],
      name: ["full_name", "name", "nev", "név", "employee_name", "staff_name"], email: ["email", "e-mail", "mail"],
      phone: ["phone", "mobile", "telefon"], position: ["position", "job_title", "munkakor", "munkakör"],
    }, dedupe: ["external_id", "email", "phone"],
  },
  services: {
    table: "services", label: "Szolgáltatások", group: "Foglalás és szolgáltatás", apply: true,
    fields: {
      external_id: ["altegio_service_id", "altegio_api_id", "external_id", "service_id", "id", "api_id"],
      name: ["name", "nev", "név", "szolgaltatas", "szolgáltatás"], code: ["code", "kod", "kód", "sku"],
      description: ["description", "leiras", "leírás"], base_price: ["base_price", "price", "ar", "ár", "ár -tól", "price_from"],
      duration_minutes: ["duration_minutes", "duration", "idotartam", "időtartam"],
    }, dedupe: ["external_id", "code", "name"],
  },
  products: {
    table: "products", label: "Termékek", group: "Raktár és beszerzés", apply: true,
    fields: {
      external_id: ["altegio_product_key", "external_id", "product_id", "id"], name: ["name", "nev", "név", "megnevezes", "megnevezés", "megnevezés a nyugtán"],
      code: ["internal_code", "sku", "cikkszam", "cikkszám", "code"], barcode: ["barcode", "vonalkod", "vonalkód"],
      sale_price: ["sale_price", "list_price", "price", "eladasi_ar", "eladási ár", "eladási ár, ft"], purchase_price: ["purchase_price", "beszerzesi_ar", "beszerzési ár", "beszerzési ár, ft"],
    }, dedupe: ["external_id", "barcode", "code", "name"],
  },
  appointments: {
    table: "appointments", label: "Időpontok", group: "Foglalás és szolgáltatás", apply: true,
    fields: {
      external_id: ["external_id", "appointment_id", "record_id", "id"], client_id: ["client_id", "customer_id", "vendeg_id", "vendég_id"],
      employee_id: ["employee_id", "staff_id", "worker_id", "munkatars_id", "munkatárs_id"], location_id: ["location_id", "salon_id", "telephely_id"],
      start_at: ["start_at", "starts_at", "datetime", "date", "idopont", "időpont"], end_at: ["end_at", "ends_at", "end_datetime"],
      status: ["status", "allapot", "állapot"], source_channel: ["source_channel", "source", "channel", "forras", "forrás"], notes: ["notes", "note", "megjegyzes", "megjegyzés"],
    }, dedupe: ["external_id"],
  },
};

const TARGET_COLUMN_CANDIDATES: Record<string, string[]> = {
  external_id: ["altegio_client_id", "altegio_staff_id", "altegio_service_id", "altegio_api_id", "altegio_product_key", "external_id", "source_id", "api_id"],
  name: ["full_name", "name"], email: ["email"], phone: ["phone", "mobile"], birth_date: ["birth_date"], notes: ["notes", "note"],
  position: ["position", "job_title"], code: ["code", "internal_code", "sku"], barcode: ["barcode"], description: ["description", "description_short"],
  base_price: ["base_price", "list_price", "price"], duration_minutes: ["duration_minutes"], sale_price: ["sale_price", "list_price", "price"], purchase_price: ["purchase_price", "cost_price"],
  client_id: ["client_id"], employee_id: ["employee_id"], location_id: ["location_id"], start_at: ["start_at", "starts_at", "appointment_at"], end_at: ["end_at", "ends_at"],
  status: ["status"], source_channel: ["source_channel", "source"],
};

const BLOCKED_TABLE_PATTERNS: RegExp[] = [
  /^migration_/i, /^schema_migrations?$/i, /^knex_migrations/i, /^pgmigrations?$/i, /^tenants$/i, /^users$/i, /^user_roles$/i, /^roles$/i,
  /(^|_)password(s)?($|_)/i, /(^|_)refresh_tokens?$/i, /(^|_)access_tokens?$/i, /(^|_)sessions?$/i, /(^|_)secrets?$/i, /(^|_)api_keys?$/i,
];

let schemaReady: Promise<void> | null = null;
async function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = db.query(`
      CREATE EXTENSION IF NOT EXISTS pgcrypto;
      CREATE TABLE IF NOT EXISTS migration_runs(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        provider text NOT NULL CHECK(provider IN('altegio','booksy','fresha','excel','csv')), entity_type text NOT NULL, source_mode text NOT NULL DEFAULT 'file',
        status text NOT NULL DEFAULT 'draft' CHECK(status IN('draft','uploaded','analyzed','ready','applying','completed','partial','failed','rolled_back')),
        filename text, duplicate_policy text NOT NULL DEFAULT 'review' CHECK(duplicate_policy IN('review','skip','merge','create_new')),
        mapping jsonb NOT NULL DEFAULT '{}'::jsonb, target_contract jsonb NOT NULL DEFAULT '{}'::jsonb, stats jsonb NOT NULL DEFAULT '{}'::jsonb,
        schema_version integer NOT NULL DEFAULT ${VERSION}, created_by text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, rolled_back_at timestamptz
      );
      ALTER TABLE migration_runs DROP CONSTRAINT IF EXISTS migration_runs_entity_type_check;
      ALTER TABLE migration_runs ADD COLUMN IF NOT EXISTS schema_version integer NOT NULL DEFAULT ${VERSION};
      CREATE INDEX IF NOT EXISTS migration_runs_tenant_idx ON migration_runs(tenant_id,created_at DESC);
      CREATE TABLE IF NOT EXISTS migration_items(
        id bigserial PRIMARY KEY, run_id uuid NOT NULL REFERENCES migration_runs(id) ON DELETE CASCADE, row_number integer NOT NULL, source_data jsonb NOT NULL,
        mapped_data jsonb NOT NULL DEFAULT '{}'::jsonb, duplicate_target_pk text, disposition text NOT NULL DEFAULT 'pending' CHECK(disposition IN('pending','ready','duplicate','review_required','skipped','created','merged','failed')),
        error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(run_id,row_number)
      );
      CREATE INDEX IF NOT EXISTS migration_items_run_idx ON migration_items(run_id,row_number);
      CREATE TABLE IF NOT EXISTS migration_operations(
        id bigserial PRIMARY KEY, run_id uuid NOT NULL REFERENCES migration_runs(id) ON DELETE CASCADE, item_id bigint REFERENCES migration_items(id) ON DELETE SET NULL,
        action text NOT NULL CHECK(action IN('create','update')), table_name text NOT NULL, pk_column text NOT NULL, target_pk text NOT NULL, before_data jsonb, after_data jsonb, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS migration_operations_run_idx ON migration_operations(run_id,id DESC);
      CREATE TABLE IF NOT EXISTS migration_events(
        id bigserial PRIMARY KEY, run_id uuid NOT NULL REFERENCES migration_runs(id) ON DELETE CASCADE, event_type text NOT NULL, actor text, payload jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now()
      );
    `).then(() => undefined).catch((error: unknown) => { schemaReady = null; throw error; });
  }
  await schemaReady;
}

const actor = (req: TenantAuthRequest): string | null => String(req.user?.id || req.user?.email || "") || null;
const norm = (value: unknown): string => String(value ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const scalar = (value: unknown): unknown => value == null || value === "" ? null : typeof value === "object" ? JSON.stringify(value) : value;
const qid = (value: string): string => { if (!/^[a-z_][a-z0-9_]*$/i.test(value)) throw new Error("Unsafe identifier"); return `"${value}"`; };
const toErrorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error || "unknown_error");

function humanizeTable(table: string): string {
  const core = CORE_ENTITY_CONFIG[table];
  if (core) return core.label;
  return table.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}
function tableGroup(table: string): string {
  const core = CORE_ENTITY_CONFIG[table]; if (core) return core.group;
  if (/(client|crm|loyal|consent|guest|customer)/i.test(table)) return "Vendégek és CRM";
  if (/(employee|staff|hr_|position|employment|payroll|timesheet|leave|recruit|training|evaluation|compensation)/i.test(table)) return "HR és munkatársak";
  if (/(appointment|booking|service|work_order|timetable|shift)/i.test(table)) return "Foglalás és szolgáltatás";
  if (/(product|inventory|stock|warehouse|purchase|supplier|material)/i.test(table)) return "Raktár és beszerzés";
  if (/(finance|financial|invoice|payment|cash|account|receipt|transaction|tax|nav_)/i.test(table)) return "Pénzügy és pénztár";
  if (/(marketing|campaign|newsletter|daily_action|notification|wallboard|signage|promotion)/i.test(table)) return "Marketing és kommunikáció";
  if (/(knowledge|quiz|course|document|policy|procedure)/i.test(table)) return "Tudásbázis és képzés";
  if (/(equipment|asset|maintenance|device)/i.test(table)) return "Tárgyi eszköz és karbantartás";
  if (/(fitness|locker|membership|wellness)/i.test(table)) return "Fitness és wellness";
  if (/(tenant|location|setting|menu|permission|role|saas|franchise)/i.test(table)) return "Rendszer és SaaS";
  return "Egyéb VIR adat";
}
function blockedReason(table: string): string | null {
  return BLOCKED_TABLE_PATTERNS.some((pattern) => pattern.test(table)) ? "Technikai vagy hitelesítési tábla: staging/előnézet engedélyezett, közvetlen éles import biztonsági okból tiltott." : null;
}
function rowsFromFile(file: Express.Multer.File): Record<string, unknown>[] {
  const ext = (file.originalname.split(".").pop() || "").toLowerCase(); let workbook: XLSX.WorkBook;
  if (ext === "csv") workbook = XLSX.read(file.buffer.toString("utf8"), { type: "string", raw: true }); else workbook = XLSX.read(file.buffer, { type: "buffer", cellDates: false });
  const worksheet = workbook.Sheets[workbook.SheetNames[0]]; if (!worksheet) throw new Error("A fájl első munkalapja üres.");
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(worksheet, { defval: null, raw: true });
}
function autoMapping(config: EntityConfig, headers: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [canonical, aliases] of Object.entries(config.fields)) {
    const candidates = [canonical, ...aliases].map(norm); const exact = headers.find((header) => candidates.includes(norm(header)));
    const fuzzy = exact || headers.find((header) => candidates.some((candidate) => candidate && norm(header) && (norm(header).includes(candidate) || candidate.includes(norm(header)))));
    if (fuzzy) result[canonical] = fuzzy;
  }
  return result;
}
function applyMapping(source: Record<string, unknown>, mapping: Record<string, string>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [canonical, sourceKey] of Object.entries(mapping || {})) { const value = scalar(source?.[sourceKey]); if (value !== null) result[canonical] = value; }
  return result;
}
async function getColumns(table: string): Promise<ColumnMeta[]> {
  const { rows } = await db.query<ColumnMeta>(`SELECT column_name,data_type,is_nullable,column_default,is_identity,is_generated,ordinal_position FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [table]);
  return rows;
}
async function resolveEntityConfig(entity: string): Promise<EntityConfig | null> {
  if (!/^[a-z_][a-z0-9_]*$/i.test(entity)) return null; const core = CORE_ENTITY_CONFIG[entity]; if (core) return core;
  const columns = await getColumns(entity); if (!columns.length) return null; const fields: FieldAliases = {};
  for (const column of columns) { if (column.is_generated !== "NEVER" || column.is_identity === "YES") continue; fields[column.column_name] = [column.column_name, column.column_name.replace(/_/g, " ")]; }
  const columnNames = new Set(columns.map((column) => column.column_name));
  const dedupe = ["external_id", "source_id", "api_id", "email", "phone", "code", "sku", "barcode", "name"].filter((column) => columnNames.has(column));
  return { table: entity, label: humanizeTable(entity), group: tableGroup(entity), apply: true, fields, dedupe, blocked_reason: blockedReason(entity) };
}
async function getPrimaryKeyColumns(table: string): Promise<string[]> {
  const { rows } = await db.query<{ column_name: string }>(`SELECT kcu.column_name FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON kcu.constraint_schema=tc.constraint_schema AND kcu.constraint_name=tc.constraint_name AND kcu.table_name=tc.table_name WHERE tc.table_schema='public' AND tc.table_name=$1 AND tc.constraint_type='PRIMARY KEY' ORDER BY kcu.ordinal_position`, [table]);
  return rows.map((row) => String(row.column_name));
}
async function getForeignKeys(table: string): Promise<ForeignKeyMeta[]> {
  const { rows } = await db.query<ForeignKeyMeta>(`SELECT kcu.column_name,ccu.table_name AS referenced_table,ccu.column_name AS referenced_column,EXISTS(SELECT 1 FROM information_schema.columns c WHERE c.table_schema='public' AND c.table_name=ccu.table_name AND c.column_name='tenant_id') AS tenant_scoped FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON kcu.constraint_schema=tc.constraint_schema AND kcu.constraint_name=tc.constraint_name AND kcu.table_name=tc.table_name JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_schema=tc.constraint_schema AND ccu.constraint_name=tc.constraint_name WHERE tc.table_schema='public' AND tc.table_name=$1 AND tc.constraint_type='FOREIGN KEY' ORDER BY kcu.ordinal_position`, [table]);
  return rows.map((row) => ({ ...row, tenant_scoped: Boolean(row.tenant_scoped) }));
}
async function tableContract(entity: string, tenantSlug: string): Promise<TargetContract> {
  const config = await resolveEntityConfig(entity); if (!config) throw new Error(`A cél tábla nem található: ${entity}`);
  const columns = await getColumns(config.table); const names = new Set(columns.map((column) => column.column_name));
  const writableColumns = columns.filter((column) => column.is_generated === "NEVER" && column.is_identity !== "YES").map((column) => column.column_name);
  const pkColumns = await getPrimaryKeyColumns(config.table); const pk = pkColumns.length === 1 ? pkColumns[0] : ""; const fieldMap: Record<string, string> = {};
  for (const canonical of Object.keys(config.fields)) { const candidates = CORE_ENTITY_CONFIG[entity] ? (TARGET_COLUMN_CANDIDATES[canonical] || [canonical]) : [canonical]; const hit = candidates.find((candidate) => names.has(candidate)); if (hit) fieldMap[canonical] = hit; }
  const tenantColumn = names.has("tenant_id") ? "tenant_id" : null; const locationColumn = names.has("location_id") ? "location_id" : null;
  const requiredColumns = columns.filter((column) => column.is_nullable === "NO" && column.column_default == null && column.is_identity !== "YES" && column.is_generated === "NEVER").map((column) => column.column_name).filter((column) => column !== tenantColumn && column !== locationColumn);
  const mappedDedupe = config.dedupe.map((canonical) => fieldMap[canonical] || canonical).filter((column) => names.has(column)); const dedupeColumns = Array.from(new Set([pk, ...mappedDedupe].filter(Boolean)));
  const foreignKeys = await getForeignKeys(config.table); let reason = config.blocked_reason || null;
  if (!reason && pkColumns.length !== 1) reason = pkColumns.length ? "Összetett elsődleges kulcs: v19-ben csak előnézet támogatott." : "Elsődleges kulcs nélkül a visszaállítható éles import nem biztonságos.";
  if (!reason && !tenantColumn && tenantSlug !== "kleopatra") reason = `A ${config.table} tábla még nem tenant-biztos; külső SaaS tenant importja blokkolva.`;
  return { table: config.table, pk, columns: columns.map((column) => column.column_name), writable_columns: writableColumns, required_columns: requiredColumns, field_map: fieldMap, dedupe_columns: dedupeColumns, tenant_column: tenantColumn, location_column: locationColumn, foreign_keys: foreignKeys, legacy_scope: !tenantColumn, apply_supported: config.apply && !reason, blocked_reason: reason };
}
async function catalog(req: TenantAuthRequest): Promise<any[]> {
  const { rows } = await db.query<{ table_name: string; column_count: number }>(`SELECT t.table_name,count(c.column_name)::int AS column_count FROM information_schema.tables t LEFT JOIN information_schema.columns c ON c.table_schema=t.table_schema AND c.table_name=t.table_name WHERE t.table_schema='public' AND t.table_type='BASE TABLE' GROUP BY t.table_name ORDER BY t.table_name`);
  const tenantSlug = String(req.tenant?.slug || ""); const entities: any[] = [];
  for (const row of rows) { const config = await resolveEntityConfig(row.table_name); if (!config) continue; const contract = await tableContract(row.table_name, tenantSlug); entities.push({ code: row.table_name, table: row.table_name, label: config.label, group: config.group, column_count: Number(row.column_count || 0), apply_supported: contract.apply_supported, migration_mode: contract.apply_supported ? "apply" : "preview_only", blocked_reason: contract.blocked_reason, tenant_scoped: Boolean(contract.tenant_column), location_scoped: Boolean(contract.location_column), pk: contract.pk || null }); }
  return entities.sort((a, b) => String(a.group).localeCompare(String(b.group), "hu") || String(a.label).localeCompare(String(b.label), "hu"));
}
async function event(runId: string, type: string, req: TenantAuthRequest, payload: unknown = {}): Promise<void> { await db.query(`INSERT INTO migration_events(run_id,event_type,actor,payload) VALUES($1::uuid,$2,$3,$4::jsonb)`, [runId, type, actor(req), JSON.stringify(payload)]); }
async function loadRun(req: TenantAuthRequest, runId: string): Promise<any | null> { const result = await db.query(`SELECT * FROM migration_runs WHERE id=$1::uuid AND tenant_id=$2::bigint LIMIT 1`, [runId, req.tenant!.id]); return result.rows[0] || null; }
function mappedToActual(mapped: Record<string, unknown>, contract: TargetContract): Record<string, unknown> {
  const actual: Record<string, unknown> = {}; for (const [canonical, value] of Object.entries(mapped || {})) { const column = contract.field_map[canonical] || (contract.columns.includes(canonical) ? canonical : ""); if (column && contract.writable_columns.includes(column)) actual[column] = value; } return actual;
}
async function analyze(req: TenantAuthRequest, run: any): Promise<{ contract: TargetContract; stats: Record<string, unknown> }> {
  const entity = String(run.entity_type); const contract = await tableContract(entity, String(req.tenant!.slug)); const items = await db.query(`SELECT id,row_number,mapped_data FROM migration_items WHERE run_id=$1::uuid ORDER BY row_number`, [run.id]);
  let duplicates = 0, ready = 0, invalid = 0;
  for (const item of items.rows) {
    const mapped = (item.mapped_data || {}) as Record<string, unknown>; const actual = mappedToActual(mapped, contract); const missing = contract.required_columns.filter((column) => actual[column] == null || String(actual[column]).trim() === "");
    if (!Object.keys(actual).length || missing.length) { invalid++; const message = missing.length ? `Hiányzó kötelező célmező(k): ${missing.join(", ")}` : "Nincs felismerhető célmező."; await db.query(`UPDATE migration_items SET disposition='failed',error=$2,duplicate_target_pk=NULL,updated_at=now() WHERE id=$1`, [item.id, message]); continue; }
    let duplicatePk: string | null = null;
    for (const column of contract.dedupe_columns) { const value = actual[column]; if (!column || value == null || String(value).trim() === "") continue; const params: unknown[] = [String(value)]; const where = [`${qid(column)}::text=$1`]; if (contract.tenant_column) { params.push(req.tenant!.id); where.push(`${qid(contract.tenant_column)}::text=$2`); } const hit = await db.query(`SELECT ${qid(contract.pk)}::text AS pk FROM public.${qid(contract.table)} WHERE ${where.join(" AND ")} LIMIT 1`, params); if (hit.rows[0]?.pk) { duplicatePk = String(hit.rows[0].pk); break; } }
    if (duplicatePk) { duplicates++; await db.query(`UPDATE migration_items SET disposition='duplicate',duplicate_target_pk=$2,error=NULL,updated_at=now() WHERE id=$1`, [item.id, duplicatePk]); } else { ready++; await db.query(`UPDATE migration_items SET disposition='ready',duplicate_target_pk=NULL,error=NULL,updated_at=now() WHERE id=$1`, [item.id]); }
  }
  const stats = { total: items.rowCount || 0, ready, duplicates, invalid, provider: run.provider, entity_type: entity, apply_supported: contract.apply_supported, blocked_reason: contract.blocked_reason, legacy_scope: contract.legacy_scope, schema_version: VERSION };
  await db.query(`UPDATE migration_runs SET status='ready',target_contract=$2::jsonb,stats=$3::jsonb,schema_version=$4,updated_at=now() WHERE id=$1::uuid`, [run.id, JSON.stringify(contract), JSON.stringify(stats), VERSION]); return { contract, stats };
}
async function enforceScope(req: TenantAuthRequest, actual: Record<string, unknown>, contract: TargetContract): Promise<void> {
  if (contract.tenant_column) actual[contract.tenant_column] = req.tenant!.id;
  if (contract.location_column) { const requestedLocation = actual[contract.location_column]; const fallbackLocation = req.user?.location_id != null ? String(req.user.location_id) : ""; if (requestedLocation == null && fallbackLocation) actual[contract.location_column] = fallbackLocation; const locationId = actual[contract.location_column]; if (locationId != null && contract.table !== "locations") { const hit = await db.query(`SELECT 1 FROM locations WHERE id::text=$1 AND tenant_id::text=$2 LIMIT 1`, [String(locationId), String(req.tenant!.id)]); if (!hit.rowCount) throw new Error(`A location_id nem ehhez a tenanthez tartozik: ${String(locationId)}`); } }
  for (const fk of contract.foreign_keys) { const value = actual[fk.column_name]; if (value == null || !fk.tenant_scoped || fk.referenced_table === "tenants") continue; const hit = await db.query(`SELECT 1 FROM public.${qid(fk.referenced_table)} WHERE ${qid(fk.referenced_column)}::text=$1 AND tenant_id::text=$2 LIMIT 1`, [String(value), String(req.tenant!.id)]); if (!hit.rowCount) throw new Error(`Tenant-határon kívüli vagy hiányzó hivatkozás: ${fk.column_name}=${String(value)}`); }
}

router.get("/health", async (req: TenantAuthRequest, res: Response) => { await ensureSchema(); const entities = await catalog(req); return res.json({ ok: true, version: VERSION, route: "/api/vir/migration-center", tables: entities.length, writable_tables: entities.filter((entity) => entity.apply_supported).length }); });
router.get("/providers", async (req: TenantAuthRequest, res: Response) => { await ensureSchema(); const entities = await catalog(req); return res.json({ ok: true, version: VERSION, providers: Object.values(PROVIDERS), entities }); });
router.get("/catalog", async (req: TenantAuthRequest, res: Response) => { await ensureSchema(); return res.json({ ok: true, version: VERSION, entities: await catalog(req) }); });
router.get("/runs", async (req: TenantAuthRequest, res: Response) => { await ensureSchema(); const { rows } = await db.query(`SELECT id::text,provider,entity_type,source_mode,status,filename,duplicate_policy,mapping,target_contract,stats,schema_version,created_by,created_at,updated_at,completed_at,rolled_back_at FROM migration_runs WHERE tenant_id=$1::bigint ORDER BY created_at DESC LIMIT 100`, [req.tenant!.id]); return res.json({ ok: true, rows }); });
router.post("/runs", async (req: TenantAuthRequest, res: Response) => {
  await ensureSchema(); const provider = String(req.body?.provider || "").toLowerCase() as Provider; const entity = String(req.body?.entity_type || "").toLowerCase();
  if (!PROVIDERS[provider]) return res.status(400).json({ ok: false, error: "Érvénytelen migrációs forrás." }); const config = await resolveEntityConfig(entity); if (!config) return res.status(400).json({ ok: false, error: "A kiválasztott VIR céltábla nem található." });
  const policy = (["review", "skip", "merge", "create_new"].includes(String(req.body?.duplicate_policy)) ? String(req.body.duplicate_policy) : "review") as DuplicatePolicy;
  const { rows } = await db.query(`INSERT INTO migration_runs(tenant_id,provider,entity_type,source_mode,duplicate_policy,schema_version,created_by) VALUES($1::bigint,$2,$3,$4,$5,$6,$7) RETURNING id::text,*`, [req.tenant!.id, provider, entity, String(req.body?.source_mode || "file"), policy, VERSION, actor(req)]);
  await event(rows[0].id, "run_created", req, { provider, entity, duplicate_policy: policy, schema_version: VERSION }); return res.status(201).json({ ok: true, run: rows[0] });
});
router.get("/runs/:id", async (req: TenantAuthRequest, res: Response) => { await ensureSchema(); const run = await loadRun(req, String(req.params.id)); if (!run) return res.status(404).json({ ok: false, error: "Migrációs futás nem található." }); const items = await db.query(`SELECT id::text,row_number,mapped_data,duplicate_target_pk,disposition,error FROM migration_items WHERE run_id=$1::uuid ORDER BY row_number LIMIT 250`, [run.id]); const events = await db.query(`SELECT event_type,actor,payload,created_at FROM migration_events WHERE run_id=$1::uuid ORDER BY id DESC LIMIT 100`, [run.id]); return res.json({ ok: true, run, items: items.rows, events: events.rows }); });
router.post("/runs/:id/upload", upload.single("file"), async (req: TenantAuthRequest, res: Response) => {
  await ensureSchema(); const run = await loadRun(req, String(req.params.id)); if (!run) return res.status(404).json({ ok: false, error: "Migrációs futás nem található." }); if (!req.file?.buffer) return res.status(400).json({ ok: false, error: "CSV vagy Excel fájl szükséges." });
  let sourceRows: Record<string, unknown>[]; try { sourceRows = rowsFromFile(req.file); } catch (error: unknown) { return res.status(400).json({ ok: false, error: toErrorMessage(error) || "A fájl nem olvasható." }); }
  if (!sourceRows.length) return res.status(400).json({ ok: false, error: "A fájl nem tartalmaz adatsort." }); if (sourceRows.length > 50000) return res.status(413).json({ ok: false, error: "Egy migrációs futás legfeljebb 50 000 sort tartalmazhat." });
  const config = await resolveEntityConfig(String(run.entity_type)); if (!config) return res.status(409).json({ ok: false, error: "A céltábla időközben megszűnt vagy nem elérhető." }); const headers = Object.keys(sourceRows[0]); const mapping = autoMapping(config, headers); const client = await db.connect();
  try { await client.query("BEGIN"); await client.query(`DELETE FROM migration_items WHERE run_id=$1::uuid`, [run.id]); for (let index = 0; index < sourceRows.length; index++) await client.query(`INSERT INTO migration_items(run_id,row_number,source_data,mapped_data) VALUES($1::uuid,$2,$3::jsonb,$4::jsonb)`, [run.id, index + 2, JSON.stringify(sourceRows[index]), JSON.stringify(applyMapping(sourceRows[index], mapping))]); await client.query(`UPDATE migration_runs SET filename=$2,status='uploaded',mapping=$3::jsonb,updated_at=now() WHERE id=$1::uuid`, [run.id, req.file.originalname, JSON.stringify(mapping)]); await client.query("COMMIT"); }
  catch (error: unknown) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
  const fresh = await loadRun(req, run.id); const result = await analyze(req, fresh); await event(run.id, "file_analyzed", req, { filename: req.file.originalname, rows: sourceRows.length, mapping, stats: result.stats }); return res.json({ ok: true, run_id: run.id, headers, mapping, ...result });
});
router.put("/runs/:id/mapping", async (req: TenantAuthRequest, res: Response) => { await ensureSchema(); const run = await loadRun(req, String(req.params.id)); if (!run) return res.status(404).json({ ok: false, error: "Migrációs futás nem található." }); const mapping = req.body?.mapping && typeof req.body.mapping === "object" ? req.body.mapping as Record<string, string> : {}; const items = await db.query(`SELECT id,source_data FROM migration_items WHERE run_id=$1::uuid`, [run.id]); for (const item of items.rows) await db.query(`UPDATE migration_items SET mapped_data=$2::jsonb,disposition='pending',duplicate_target_pk=NULL,error=NULL,updated_at=now() WHERE id=$1`, [item.id, JSON.stringify(applyMapping(item.source_data, mapping))]); await db.query(`UPDATE migration_runs SET mapping=$2::jsonb,status='analyzed',updated_at=now() WHERE id=$1::uuid`, [run.id, JSON.stringify(mapping)]); const result = await analyze(req, await loadRun(req, run.id)); await event(run.id, "mapping_changed", req, { mapping, stats: result.stats }); return res.json({ ok: true, ...result }); });
router.patch("/runs/:id", async (req: TenantAuthRequest, res: Response) => { await ensureSchema(); const run = await loadRun(req, String(req.params.id)); if (!run) return res.status(404).json({ ok: false, error: "Migrációs futás nem található." }); const policy = String(req.body?.duplicate_policy || "") as DuplicatePolicy; if (!["review", "skip", "merge", "create_new"].includes(policy)) return res.status(400).json({ ok: false, error: "Érvénytelen duplikációs szabály." }); await db.query(`UPDATE migration_runs SET duplicate_policy=$2,updated_at=now() WHERE id=$1::uuid`, [run.id, policy]); await event(run.id, "duplicate_policy_changed", req, { duplicate_policy: policy }); return res.json({ ok: true, duplicate_policy: policy }); });
router.post("/runs/:id/apply", async (req: TenantAuthRequest, res: Response) => {
  await ensureSchema(); const run = await loadRun(req, String(req.params.id)); if (!run) return res.status(404).json({ ok: false, error: "Migrációs futás nem található." }); const contract = await tableContract(String(run.entity_type), String(req.tenant!.slug)); if (!contract.apply_supported) return res.status(409).json({ ok: false, code: "PREVIEW_ONLY_ENTITY", error: contract.blocked_reason || "Ez a céltábla csak előnézet módban érhető el." });
  const policy = String(req.body?.duplicate_policy || run.duplicate_policy || "review") as DuplicatePolicy; const items = await db.query(`SELECT * FROM migration_items WHERE run_id=$1::uuid ORDER BY row_number`, [run.id]); if (policy === "review" && items.rows.some((item: any) => item.disposition === "duplicate")) return res.status(409).json({ ok: false, code: "DUPLICATE_REVIEW_REQUIRED", error: "Duplikált sorok vannak. Válasszon: kihagyás, egyesítés vagy új rekord." });
  await db.query(`UPDATE migration_runs SET status='applying',duplicate_policy=$2,target_contract=$3::jsonb,updated_at=now() WHERE id=$1::uuid`, [run.id, policy, JSON.stringify(contract)]); let created = 0, merged = 0, skipped = 0, failed = 0;
  for (const item of items.rows) {
    try {
      if (item.disposition === "failed") { failed++; continue; } if (item.duplicate_target_pk && policy === "skip") { skipped++; await db.query(`UPDATE migration_items SET disposition='skipped',updated_at=now() WHERE id=$1`, [item.id]); continue; }
      const actual = mappedToActual((item.mapped_data || {}) as Record<string, unknown>, contract); await enforceScope(req, actual, contract); const missing = contract.required_columns.filter((column) => actual[column] == null || String(actual[column]).trim() === ""); if (missing.length) throw new Error(`Hiányzó kötelező célmező(k): ${missing.join(", ")}`);
      if (item.duplicate_target_pk && policy === "merge") {
        const before = (await db.query(`SELECT to_jsonb(t) AS row FROM public.${qid(contract.table)} t WHERE ${qid(contract.pk)}::text=$1${contract.tenant_column ? ` AND ${qid(contract.tenant_column)}::text=$2` : ""} LIMIT 1`, contract.tenant_column ? [item.duplicate_target_pk, req.tenant!.id] : [item.duplicate_target_pk])).rows[0]?.row || {};
        const columns = Object.keys(actual).filter((column) => column !== contract.pk && contract.writable_columns.includes(column)); if (!columns.length) throw new Error("Nincs frissíthető célmező."); const values: unknown[] = columns.map((column) => actual[column]); values.push(item.duplicate_target_pk); if (contract.tenant_column) values.push(req.tenant!.id); const whereIndex = columns.length + 1;
        const updated = await db.query(`UPDATE public.${qid(contract.table)} SET ${columns.map((column, index) => `${qid(column)}=$${index + 1}`).join(",")} WHERE ${qid(contract.pk)}::text=$${whereIndex}${contract.tenant_column ? ` AND ${qid(contract.tenant_column)}::text=$${whereIndex + 1}` : ""} RETURNING *`, values);
        await db.query(`INSERT INTO migration_operations(run_id,item_id,action,table_name,pk_column,target_pk,before_data,after_data) VALUES($1::uuid,$2,'update',$3,$4,$5,$6::jsonb,$7::jsonb)`, [run.id, item.id, contract.table, contract.pk, item.duplicate_target_pk, JSON.stringify(before), JSON.stringify(updated.rows[0] || {})]); await db.query(`UPDATE migration_items SET disposition='merged',error=NULL,updated_at=now() WHERE id=$1`, [item.id]); merged++;
      } else {
        if (item.duplicate_target_pk && policy === "create_new") delete actual[contract.pk]; const columns = Object.keys(actual).filter((column) => contract.writable_columns.includes(column)); if (!columns.length) throw new Error("Nincs beírható célmező."); const values = columns.map((column) => actual[column]); const inserted = await db.query(`INSERT INTO public.${qid(contract.table)}(${columns.map(qid).join(",")}) VALUES(${columns.map((_, index) => `$${index + 1}`).join(",")}) RETURNING *`, values); const row = inserted.rows[0] || {}; const pk = String(row[contract.pk]); if (!pk || pk === "undefined") throw new Error("Az új rekord elsődleges kulcsa nem olvasható vissza."); await db.query(`INSERT INTO migration_operations(run_id,item_id,action,table_name,pk_column,target_pk,after_data) VALUES($1::uuid,$2,'create',$3,$4,$5,$6::jsonb)`, [run.id, item.id, contract.table, contract.pk, pk, JSON.stringify(row)]); await db.query(`UPDATE migration_items SET disposition='created',duplicate_target_pk=$2,error=NULL,updated_at=now() WHERE id=$1`, [item.id, pk]); created++;
      }
    } catch (error: unknown) { failed++; await db.query(`UPDATE migration_items SET disposition='failed',error=$2,updated_at=now() WHERE id=$1`, [item.id, toErrorMessage(error).slice(0, 500)]); }
  }
  const status = failed ? (created || merged || skipped ? "partial" : "failed") : "completed"; const stats = { ...(run.stats || {}), created, merged, skipped, failed, apply_supported: true, schema_version: VERSION }; await db.query(`UPDATE migration_runs SET status=$2,stats=$3::jsonb,completed_at=CASE WHEN $2 IN('completed','partial') THEN now() ELSE completed_at END,updated_at=now() WHERE id=$1::uuid`, [run.id, status, JSON.stringify(stats)]); await event(run.id, "apply_finished", req, { status, ...stats }); return res.json({ ok: status !== "failed", status, stats });
});
router.post("/runs/:id/rollback", async (req: TenantAuthRequest, res: Response) => {
  await ensureSchema(); const run = await loadRun(req, String(req.params.id)); if (!run) return res.status(404).json({ ok: false, error: "Migrációs futás nem található." }); if (run.status === "rolled_back") return res.json({ ok: true, status: "rolled_back", already: true }); const operations = (await db.query(`SELECT * FROM migration_operations WHERE run_id=$1::uuid ORDER BY id DESC`, [run.id])).rows; let reverted = 0, failed = 0;
  for (const operation of operations) {
    try { const columns = await getColumns(String(operation.table_name)); const writable = new Set(columns.filter((column) => column.is_generated === "NEVER" && column.is_identity !== "YES").map((column) => column.column_name)); const hasTenant = columns.some((column) => column.column_name === "tenant_id"); const scopeSql = hasTenant ? " AND tenant_id::text=$2" : ""; const scopeParams = hasTenant ? [operation.target_pk, String(req.tenant!.id)] : [operation.target_pk]; if (operation.action === "create") await db.query(`DELETE FROM public.${qid(operation.table_name)} WHERE ${qid(operation.pk_column)}::text=$1${scopeSql}`, scopeParams); else { const before = (operation.before_data || {}) as Record<string, unknown>; const keys = Object.keys(before).filter((key) => key !== operation.pk_column && writable.has(key) && /^[a-z_][a-z0-9_]*$/i.test(key)); if (keys.length) { const values: unknown[] = keys.map((key) => before[key]); values.push(operation.target_pk); if (hasTenant) values.push(req.tenant!.id); const whereIndex = keys.length + 1; await db.query(`UPDATE public.${qid(operation.table_name)} SET ${keys.map((key, index) => `${qid(key)}=$${index + 1}`).join(",")} WHERE ${qid(operation.pk_column)}::text=$${whereIndex}${hasTenant ? ` AND tenant_id::text=$${whereIndex + 1}` : ""}`, values); } } reverted++; } catch { failed++; }
  }
  if (failed) return res.status(409).json({ ok: false, status: "partial_rollback", reverted, failed, error: "A rollback nem volt teljes; kézi ellenőrzés szükséges." }); await db.query(`UPDATE migration_runs SET status='rolled_back',rolled_back_at=now(),updated_at=now() WHERE id=$1::uuid`, [run.id]); await event(run.id, "rolled_back", req, { reverted }); return res.json({ ok: true, status: "rolled_back", reverted });
});
router.get("/runs/:id/evidence", async (req: TenantAuthRequest, res: Response) => { await ensureSchema(); const run = await loadRun(req, String(req.params.id)); if (!run) return res.status(404).json({ ok: false, error: "Migrációs futás nem található." }); const disposition = await db.query(`SELECT disposition,count(*)::int AS count FROM migration_items WHERE run_id=$1::uuid GROUP BY disposition ORDER BY disposition`, [run.id]); const operations = await db.query(`SELECT action,count(*)::int AS count FROM migration_operations WHERE run_id=$1::uuid GROUP BY action ORDER BY action`, [run.id]); const events = await db.query(`SELECT event_type,actor,payload,created_at FROM migration_events WHERE run_id=$1::uuid ORDER BY id`, [run.id]); return res.json({ ok: true, evidence: { version: VERSION, run: { id: run.id, provider: run.provider, entity_type: run.entity_type, status: run.status, filename: run.filename, duplicate_policy: run.duplicate_policy, mapping: run.mapping, target_contract: run.target_contract, stats: run.stats, schema_version: run.schema_version, created_by: run.created_by, created_at: run.created_at, completed_at: run.completed_at, rolled_back_at: run.rolled_back_at }, dispositions: disposition.rows, operations: operations.rows, events: events.rows } }); });

export default router;
