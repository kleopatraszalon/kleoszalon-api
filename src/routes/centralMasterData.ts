import { Router, Response } from "express";
import db from "../db";
import { AuthRequest } from "../middleware/auth";

type FieldType = "text" | "number" | "boolean" | "date" | "email" | "url" | "select" | "relation";
type FieldDef = {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  options?: Array<{ value: string; label: string }>;
  relationEntity?: string;
  relationValueKey?: string;
  placeholder?: string;
};
type EntityDef = {
  key: string;
  title: string;
  singular: string;
  description: string;
  table: string;
  activeColumn: "active" | "is_active";
  systemColumn?: string;
  lockSystemEdit?: boolean;
  orderBy: string;
  searchColumns: string[];
  fields: FieldDef[];
  listFields: string[];
  route: string;
};
type CatalogPayload = { entities: Array<Omit<EntityDef, "table" | "searchColumns" | "orderBy" | "systemColumn"> & { hasSystemRows: boolean; lockSystemEdit: boolean }>; counts: Record<string, number> };

const router = Router();
let schemaReady: Promise<void> | null = null;
const CATALOG_CACHE_TTL_MS = 60 * 1000;
let catalogGeneration = 0;
let catalogCache: { value: CatalogPayload; expiresAt: number; generation: number } | null = null;
let catalogInFlight: { generation: number; promise: Promise<CatalogPayload> } | null = null;

const opt = (...values: Array<[string, string]>) => values.map(([value, label]) => ({ value, label }));

const entities: EntityDef[] = [
  {
    key: "salons",
    title: "Szalonok",
    singular: "szalon",
    description: "Szalonok és telephelyek központi törzse. A szolgáltatási, raktári és pénzügyi modulok telephely-hivatkozásainak alapja.",
    table: "locations",
    activeColumn: "is_active",
    orderBy: "city NULLS LAST, name",
    searchColumns: ["name", "city", "address", "phone", "email"],
    route: "/masterdata/salons",
    fields: [
      { key: "name", label: "Név", type: "text", required: true },
      { key: "city", label: "Település", type: "text", required: true },
      { key: "address", label: "Cím", type: "text" },
      { key: "phone", label: "Telefonszám", type: "text" },
      { key: "email", label: "E-mail", type: "email" },
      { key: "is_active", label: "Aktív", type: "boolean" },
    ],
    listFields: ["name", "city", "address", "phone", "email", "is_active"],
  },
  {
    key: "departments",
    title: "Részlegek",
    singular: "részleg",
    description: "A termékeket, szolgáltatásokat és naptári bontást szervező részlegek. A specifikáció szerinti naptárbeosztás percben adható meg.",
    table: "master_departments",
    activeColumn: "active",
    orderBy: "sort_order, name",
    searchColumns: ["code", "name"],
    route: "/masterdata/departments",
    fields: [
      { key: "code", label: "Kód", type: "text", required: true },
      { key: "name", label: "Név", type: "text", required: true },
      { key: "calendar_slot_minutes", label: "Naptár beosztása (perc)", type: "number", required: true },
      { key: "daily_action_image_url", label: "Napi akciókép URL", type: "url" },
      { key: "sort_order", label: "Sorrend", type: "number" },
      { key: "active", label: "Aktív", type: "boolean" },
    ],
    listFields: ["code", "name", "calendar_slot_minutes", "active"],
  },
  {
    key: "equipment-types",
    title: "Eszköztípusok",
    singular: "eszköztípus",
    description: "Az eszközök központi kategóriái.",
    table: "master_equipment_types",
    activeColumn: "active",
    orderBy: "sort_order, name",
    searchColumns: ["code", "name"],
    route: "/masterdata/equipment-types",
    fields: [
      { key: "code", label: "Kód", type: "text", required: true },
      { key: "name", label: "Név", type: "text", required: true },
      { key: "sort_order", label: "Sorrend", type: "number" },
      { key: "active", label: "Aktív", type: "boolean" },
    ],
    listFields: ["code", "name", "active"],
  },
  {
    key: "equipment",
    title: "Eszközök",
    singular: "eszköz",
    description: "Globális eszköztörzs beszerzési, garancia- és szervizadatokkal. A szerviz esedékesség ebből a törzsből automatizálható.",
    table: "master_equipment",
    activeColumn: "active",
    orderBy: "name, item_number NULLS LAST",
    searchColumns: ["item_number", "name", "company_name", "distributor"],
    route: "/masterdata/assets",
    fields: [
      { key: "item_number", label: "Cikkszám / leltári szám", type: "text" },
      { key: "name", label: "Megnevezés", type: "text", required: true },
      { key: "equipment_type_id", label: "Eszköztípus", type: "relation", relationEntity: "equipment-types" },
      { key: "purchase_date", label: "Vásárlás dátuma", type: "date" },
      { key: "company_name", label: "Cégnév", type: "text" },
      { key: "distributor", label: "Forgalmazó", type: "text" },
      { key: "service_interval_days", label: "Szervizelés gyakorisága (nap)", type: "number" },
      { key: "last_service_at", label: "Utolsó szerviz", type: "date" },
      { key: "next_service_at", label: "Következő szerviz", type: "date" },
      { key: "warranty_end", label: "Garancia vége", type: "date" },
      { key: "value_amount", label: "Érték (Ft)", type: "number" },
      { key: "active", label: "Aktív", type: "boolean" },
    ],
    listFields: ["item_number", "name", "equipment_type_id", "purchase_date", "next_service_at", "warranty_end", "value_amount", "active"],
  },
  {
    key: "suppliers",
    title: "Partnerek / Beszállítók",
    singular: "beszállító",
    description: "Termékbeszállítók kapcsolattartási, banki, kedvezmény- és szavatossági paraméterekkel.",
    table: "suppliers",
    activeColumn: "active",
    orderBy: "name",
    searchColumns: ["name", "tax_number", "email", "phone", "contact_name"],
    route: "/masterdata/suppliers",
    fields: [
      { key: "name", label: "Név", type: "text", required: true },
      { key: "tax_number", label: "Adószám", type: "text" },
      { key: "phone", label: "Telefonszám", type: "text" },
      { key: "email", label: "E-mail", type: "email" },
      { key: "address", label: "Számlázási cím", type: "text" },
      { key: "contact_name", label: "Kapcsolattartó", type: "text" },
      { key: "website", label: "Weboldal", type: "url" },
      { key: "webshop_url", label: "Webshop címe", type: "url" },
      { key: "bank_name", label: "Bank", type: "text" },
      { key: "bank_account", label: "Bankszámlaszám", type: "text" },
      { key: "discount_percent", label: "Kedvezmény mértéke (%)", type: "number" },
      { key: "shelf_life_value", label: "Termék szavatossági idő", type: "number" },
      { key: "shelf_life_unit", label: "Szavatossági idő egysége", type: "select", options: opt(["day", "nap"], ["week", "hét"], ["month", "hónap"], ["year", "év"]) },
      { key: "default_lead_time_days", label: "Alapértelmezett szállítási idő (nap)", type: "number" },
      { key: "logo_url", label: "Logó / kép URL", type: "url" },
      { key: "active", label: "Aktív", type: "boolean" },
    ],
    listFields: ["name", "phone", "email", "contact_name", "discount_percent", "default_lead_time_days", "active"],
  },
  {
    key: "warehouses",
    title: "Raktárak",
    singular: "raktár",
    description: "Központi és szalononkénti raktárak. A központi rendszerraktár nem inaktiválható.",
    table: "inventory_warehouses",
    activeColumn: "active",
    systemColumn: "system",
    orderBy: "COALESCE(location_id,'') NULLS FIRST, sort_order, name",
    searchColumns: ["code", "name", "comment"],
    route: "/masterdata/warehouses",
    fields: [
      { key: "code", label: "Kód", type: "text" },
      { key: "name", label: "Név", type: "text", required: true },
      { key: "location_id", label: "Szalon", type: "relation", relationEntity: "salons" },
      { key: "warehouse_type", label: "Raktár típusa", type: "select", options: opt(["retail", "Termék"], ["consumable", "Fogyóanyag"], ["mixed", "Vegyes"], ["transit", "Átmenő"]) },
      { key: "procurement_default", label: "Beszerzéshez alapértelmezett", type: "boolean" },
      { key: "is_default_sale", label: "Alapértelmezett értékesítési raktár", type: "boolean" },
      { key: "is_default_consumption", label: "Alapértelmezett fogyóanyag-raktár", type: "boolean" },
      { key: "comment", label: "Megjegyzés", type: "text" },
      { key: "sort_order", label: "Sorrend", type: "number" },
      { key: "active", label: "Aktív", type: "boolean" },
    ],
    listFields: ["code", "name", "location_id", "warehouse_type", "procurement_default", "active"],
  },
  {
    key: "units",
    title: "Mennyiségi egységek",
    singular: "mennyiségi egység",
    description: "Készlet- és termékmennyiségek egységei.",
    table: "inventory_units",
    activeColumn: "active",
    systemColumn: "system",
    orderBy: "sort_order, name",
    searchColumns: ["code", "name"],
    route: "/masterdata/units",
    fields: [
      { key: "code", label: "Kód", type: "text", required: true },
      { key: "name", label: "Név", type: "text", required: true },
      { key: "precision_digits", label: "Tizedesjegyek", type: "number" },
      { key: "sort_order", label: "Sorrend", type: "number" },
      { key: "active", label: "Aktív", type: "boolean" },
    ],
    listFields: ["code", "name", "precision_digits", "active"],
  },
  {
    key: "price-types",
    title: "Ártípusok",
    singular: "ártípus",
    description: "Beszerzési és egyedi értékesítési ártípusok. A Beszerzési ár rendszerrekord, nem módosítható és nem inaktiválható.",
    table: "master_price_types",
    activeColumn: "active",
    systemColumn: "system",
    lockSystemEdit: true,
    orderBy: "sort_order, name",
    searchColumns: ["code", "name"],
    route: "/masterdata/price-types",
    fields: [
      { key: "code", label: "Kód", type: "text", required: true },
      { key: "name", label: "Név", type: "text", required: true },
      { key: "markup_percent", label: "Árképzés a beszerzési árhoz képest (%)", type: "number" },
      { key: "sort_order", label: "Sorrend", type: "number" },
      { key: "active", label: "Aktív", type: "boolean" },
    ],
    listFields: ["code", "name", "markup_percent", "system", "active"],
  },
  {
    key: "leave-types",
    title: "Szabadságtípusok",
    singular: "szabadságtípus",
    description: "HR szabadságtípusok fizetési százalékkal.",
    table: "master_leave_types",
    activeColumn: "active",
    systemColumn: "system",
    orderBy: "sort_order, name",
    searchColumns: ["code", "name"],
    route: "/masterdata/leave-types",
    fields: [
      { key: "code", label: "Kód", type: "text", required: true },
      { key: "name", label: "Név", type: "text", required: true },
      { key: "pay_percent", label: "Fizetési százalék", type: "number", required: true },
      { key: "sort_order", label: "Sorrend", type: "number" },
      { key: "active", label: "Aktív", type: "boolean" },
    ],
    listFields: ["code", "name", "pay_percent", "active"],
  },
  {
    key: "movement-types",
    title: "Készletmozgás-típusok",
    singular: "készletmozgás-típus",
    description: "A raktári mozgásokhoz választható központi mozgástípusok.",
    table: "master_inventory_movement_types",
    activeColumn: "active",
    systemColumn: "system",
    orderBy: "sort_order, name",
    searchColumns: ["code", "name"],
    route: "/masterdata/movement-types",
    fields: [
      { key: "code", label: "Kód", type: "text", required: true },
      { key: "name", label: "Név", type: "text", required: true },
      { key: "direction", label: "Irány", type: "select", options: opt(["in", "Bevét"], ["out", "Kiadás"], ["transfer", "Átvezetés"], ["correction", "Korrekció"]) },
      { key: "sort_order", label: "Sorrend", type: "number" },
      { key: "active", label: "Aktív", type: "boolean" },
    ],
    listFields: ["code", "name", "direction", "system", "active"],
  },
  {
    key: "payment-methods",
    title: "Fizetési módok",
    singular: "fizetési mód",
    description: "Fa struktúrában kezelhető fizetési módok, képpel és céges használati megjelöléssel.",
    table: "finance_payment_methods",
    activeColumn: "active",
    systemColumn: "system",
    orderBy: "sort_order, name",
    searchColumns: ["code", "name", "company_name", "method_type"],
    route: "/masterdata/payment-methods",
    fields: [
      { key: "code", label: "Kód", type: "text", required: true },
      { key: "name", label: "Név", type: "text", required: true },
      { key: "method_type", label: "Típus", type: "select", options: opt(["cash", "Készpénz"], ["card", "Bankkártya"], ["bank_transfer", "Átutalás"], ["voucher", "Utalvány"], ["online_card", "Online bankkártya"], ["custom", "Egyéb"]) },
      { key: "parent_id", label: "Alárendelve", type: "relation", relationEntity: "payment-methods" },
      { key: "company_name", label: "Cég / használati kör", type: "text" },
      { key: "image_url", label: "Logó / kép URL", type: "url" },
      { key: "sort_order", label: "Sorrend", type: "number" },
      { key: "active", label: "Aktív", type: "boolean" },
    ],
    listFields: ["code", "name", "method_type", "parent_id", "company_name", "active"],
  },
  {
    key: "financial-transaction-types",
    title: "Pénzügyi tranzakciótípusok",
    singular: "pénzügyi tranzakciótípus",
    description: "Bevételi és kiadási pénzmozgások típustörzse, pénztárnyitási/zárási hiány és többlet jelölésekkel.",
    table: "finance_document_types",
    activeColumn: "active",
    systemColumn: "system",
    orderBy: "sort_order, name",
    searchColumns: ["code", "name", "group_key"],
    route: "/masterdata/financial-transaction-types",
    fields: [
      { key: "code", label: "Kód", type: "text", required: true },
      { key: "name", label: "Név", type: "text", required: true },
      { key: "direction", label: "Irány", type: "select", options: opt(["income", "Bevétel"], ["expense", "Kiadás"], ["both", "Mindkettő"]) },
      { key: "payment_method_code", label: "Fizetési mód", type: "relation", relationEntity: "payment-methods", relationValueKey: "code" },
      { key: "group_key", label: "Csoport", type: "text" },
      { key: "is_transfer", label: "Bevétel / Kiadás jellegű átvezetés", type: "boolean" },
      { key: "opening_shortage", label: "Hiányzó pénz (nyitás)", type: "boolean" },
      { key: "closing_shortage", label: "Hiányzó pénz (zárás)", type: "boolean" },
      { key: "opening_surplus", label: "Extra pénz (nyitás)", type: "boolean" },
      { key: "closing_surplus", label: "Extra pénz (zárás)", type: "boolean" },
      { key: "sort_order", label: "Sorrend", type: "number" },
      { key: "active", label: "Aktív", type: "boolean" },
    ],
    listFields: ["code", "name", "direction", "payment_method_code", "is_transfer", "opening_shortage", "closing_shortage", "opening_surplus", "closing_surplus", "active"],
  },
];

const byKey = new Map(entities.map((entity) => [entity.key, entity]));
const publicEntities = entities.map(({ table, searchColumns, orderBy, systemColumn, lockSystemEdit, ...publicDef }) => ({ ...publicDef, hasSystemRows: Boolean(systemColumn), lockSystemEdit: Boolean(lockSystemEdit) }));

function actor(req: AuthRequest) {
  return req.user?.email || String(req.user?.id || "");
}

function safeIdentifier(value: string) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) throw new Error("Érvénytelen SQL azonosító.");
  return value;
}

function invalidateCatalogCache() {
  catalogGeneration += 1;
  catalogCache = null;
  catalogInFlight = null;
}

async function getCatalogPayload(): Promise<CatalogPayload> {
  const generation = catalogGeneration;
  if (catalogCache && catalogCache.generation === generation && catalogCache.expiresAt > Date.now()) return catalogCache.value;
  if (catalogInFlight && catalogInFlight.generation === generation) return catalogInFlight.promise;
  const countSql = entities.map((def, index) => `(SELECT COUNT(*)::int FROM ${safeIdentifier(def.table)} WHERE ${safeIdentifier(def.activeColumn)}=true) AS c${index}`).join(",");
  const request = db.query(`SELECT ${countSql}`).then((result) => {
    const row = result.rows[0] || {};
    const counts: Record<string, number> = {};
    entities.forEach((def, index) => { counts[def.key] = Number(row[`c${index}`] || 0); });
    const value: CatalogPayload = { entities: publicEntities, counts };
    if (catalogGeneration === generation) catalogCache = { value, expiresAt: Date.now() + CATALOG_CACHE_TTL_MS, generation };
    return value;
  }).finally(() => {
    if (catalogInFlight?.generation === generation) catalogInFlight = null;
  });
  catalogInFlight = { generation, promise: request };
  return request;
}

function dbValue(field: FieldDef, value: unknown) {
  if (value === undefined) return undefined;
  if (value === null || value === "") return field.type === "boolean" ? false : null;
  if (field.type === "number") {
    const n = Number(value);
    if (!Number.isFinite(n)) throw Object.assign(new Error(`${field.label}: érvénytelen szám.`), { status: 400 });
    return n;
  }
  if (field.type === "boolean") return Boolean(value);
  return String(value).trim();
}

async function audit(req: AuthRequest, entityKey: string, recordId: string, action: string, beforeData: unknown, afterData: unknown) {
  await db.query(
    `INSERT INTO master_data_audit(entity_key,record_id,action,actor,before_data,after_data)
     VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)`,
    [entityKey, recordId, action, actor(req), JSON.stringify(beforeData ?? null), JSON.stringify(afterData ?? null)],
  );
}

async function ensureSchema() {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    await db.query(`
      CREATE EXTENSION IF NOT EXISTS pgcrypto;

      CREATE TABLE IF NOT EXISTS locations(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,
        address text,
        city text,
        phone text,
        email text,
        is_active boolean NOT NULL DEFAULT true
      );

      CREATE TABLE IF NOT EXISTS master_departments(
        id bigserial PRIMARY KEY,
        code text NOT NULL UNIQUE,
        name text NOT NULL,
        calendar_slot_minutes integer NOT NULL DEFAULT 15 CHECK(calendar_slot_minutes BETWEEN 5 AND 240),
        daily_action_image_url text,
        sort_order integer NOT NULL DEFAULT 100,
        active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS master_equipment_types(
        id bigserial PRIMARY KEY,
        code text NOT NULL UNIQUE,
        name text NOT NULL,
        sort_order integer NOT NULL DEFAULT 100,
        active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS master_equipment(
        id bigserial PRIMARY KEY,
        item_number text,
        name text NOT NULL,
        equipment_type_id bigint REFERENCES master_equipment_types(id),
        purchase_date date,
        company_name text,
        distributor text,
        service_interval_days integer,
        last_service_at date,
        next_service_at date,
        warranty_end date,
        value_amount numeric(14,2),
        active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS master_equipment_service_idx ON master_equipment(active,next_service_at);

      CREATE TABLE IF NOT EXISTS suppliers(
        id bigserial PRIMARY KEY,
        name text NOT NULL UNIQUE,
        tax_number text,
        email text,
        phone text,
        contact_name text,
        address text,
        website text,
        payment_terms_days integer NOT NULL DEFAULT 0,
        default_lead_time_days integer NOT NULL DEFAULT 3,
        active boolean NOT NULL DEFAULT true,
        note text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS webshop_url text;
      ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS bank_name text;
      ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS bank_account text;
      ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS discount_percent numeric(7,2) NOT NULL DEFAULT 0;
      ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS shelf_life_value integer;
      ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS shelf_life_unit text;
      ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS logo_url text;

      CREATE TABLE IF NOT EXISTS inventory_warehouses(
        id bigserial PRIMARY KEY,
        location_id text,
        code text,
        name text NOT NULL,
        warehouse_type text NOT NULL DEFAULT 'mixed',
        comment text,
        is_default_sale boolean NOT NULL DEFAULT false,
        is_default_consumption boolean NOT NULL DEFAULT false,
        active boolean NOT NULL DEFAULT true,
        sort_order integer NOT NULL DEFAULT 100,
        created_by text,
        updated_by text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      ALTER TABLE inventory_warehouses ADD COLUMN IF NOT EXISTS procurement_default boolean NOT NULL DEFAULT false;
      ALTER TABLE inventory_warehouses ADD COLUMN IF NOT EXISTS system boolean NOT NULL DEFAULT false;
      CREATE UNIQUE INDEX IF NOT EXISTS inventory_warehouses_location_name_uq
        ON inventory_warehouses(COALESCE(location_id,'__central__'), lower(name));

      CREATE TABLE IF NOT EXISTS inventory_units(
        id bigserial PRIMARY KEY,
        code text NOT NULL UNIQUE,
        name text NOT NULL,
        precision_digits integer NOT NULL DEFAULT 3,
        active boolean NOT NULL DEFAULT true,
        sort_order integer NOT NULL DEFAULT 100,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      ALTER TABLE inventory_units ADD COLUMN IF NOT EXISTS system boolean NOT NULL DEFAULT false;

      CREATE TABLE IF NOT EXISTS master_price_types(
        id bigserial PRIMARY KEY,
        code text NOT NULL UNIQUE,
        name text NOT NULL,
        markup_percent numeric(9,2) NOT NULL DEFAULT 0,
        system boolean NOT NULL DEFAULT false,
        sort_order integer NOT NULL DEFAULT 100,
        active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS master_leave_types(
        id bigserial PRIMARY KEY,
        code text NOT NULL UNIQUE,
        name text NOT NULL,
        pay_percent numeric(7,2) NOT NULL DEFAULT 100,
        system boolean NOT NULL DEFAULT false,
        sort_order integer NOT NULL DEFAULT 100,
        active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS master_inventory_movement_types(
        id bigserial PRIMARY KEY,
        code text NOT NULL UNIQUE,
        name text NOT NULL,
        direction text NOT NULL DEFAULT 'correction',
        system boolean NOT NULL DEFAULT false,
        sort_order integer NOT NULL DEFAULT 100,
        active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS finance_payment_methods(
        id bigserial PRIMARY KEY,
        location_id text,
        code text NOT NULL,
        name text NOT NULL,
        method_type text NOT NULL DEFAULT 'custom',
        account_id uuid,
        fee_percent numeric(9,4) NOT NULL DEFAULT 0,
        fee_fixed numeric(14,2) NOT NULL DEFAULT 0,
        processing_days integer NOT NULL DEFAULT 0,
        brand_fees jsonb NOT NULL DEFAULT '{}'::jsonb,
        allow_installments boolean NOT NULL DEFAULT false,
        active boolean NOT NULL DEFAULT true,
        sort_order integer NOT NULL DEFAULT 100,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      ALTER TABLE finance_payment_methods ADD COLUMN IF NOT EXISTS parent_id bigint;
      ALTER TABLE finance_payment_methods ADD COLUMN IF NOT EXISTS image_url text;
      ALTER TABLE finance_payment_methods ADD COLUMN IF NOT EXISTS company_name text;
      ALTER TABLE finance_payment_methods ADD COLUMN IF NOT EXISTS system boolean NOT NULL DEFAULT false;
      CREATE UNIQUE INDEX IF NOT EXISTS uq_finance_payment_methods_scope ON finance_payment_methods(COALESCE(location_id,''),code);

      CREATE TABLE IF NOT EXISTS finance_document_types(
        id bigserial PRIMARY KEY,
        location_id text,
        code text NOT NULL,
        name text NOT NULL,
        direction text NOT NULL DEFAULT 'both',
        group_key text NOT NULL DEFAULT 'other',
        system boolean NOT NULL DEFAULT false,
        active boolean NOT NULL DEFAULT true,
        sort_order integer NOT NULL DEFAULT 100,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      ALTER TABLE finance_document_types ADD COLUMN IF NOT EXISTS payment_method_code text;
      ALTER TABLE finance_document_types ADD COLUMN IF NOT EXISTS is_transfer boolean NOT NULL DEFAULT false;
      ALTER TABLE finance_document_types ADD COLUMN IF NOT EXISTS opening_shortage boolean NOT NULL DEFAULT false;
      ALTER TABLE finance_document_types ADD COLUMN IF NOT EXISTS closing_shortage boolean NOT NULL DEFAULT false;
      ALTER TABLE finance_document_types ADD COLUMN IF NOT EXISTS opening_surplus boolean NOT NULL DEFAULT false;
      ALTER TABLE finance_document_types ADD COLUMN IF NOT EXISTS closing_surplus boolean NOT NULL DEFAULT false;
      CREATE UNIQUE INDEX IF NOT EXISTS uq_finance_document_types_scope ON finance_document_types(COALESCE(location_id,''),code);

      CREATE TABLE IF NOT EXISTS master_data_audit(
        id bigserial PRIMARY KEY,
        entity_key text NOT NULL,
        record_id text NOT NULL,
        action text NOT NULL,
        actor text,
        before_data jsonb,
        after_data jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS master_data_audit_lookup_idx ON master_data_audit(entity_key,record_id,created_at DESC);

      INSERT INTO inventory_units(code,name,precision_digits,sort_order,system) VALUES
        ('db','Darab',0,10,true),('ml','Milliliter',3,20,true),('l','Liter',3,30,true),('g','Gramm',3,40,true),('kg','Kilogramm',3,50,true),
        ('csomag','Csomag',0,60,true),('par','Pár',0,70,true),('tekercs','Tekercs',0,80,true),('ampulla','Ampulla',0,90,true)
      ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,precision_digits=EXCLUDED.precision_digits,system=true;

      INSERT INTO master_price_types(code,name,markup_percent,system,sort_order)
      VALUES('purchase','Beszerzési ár',0,true,10)
      ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,system=true;

      INSERT INTO master_leave_types(code,name,pay_percent,system,sort_order)
      VALUES('normal','Normál szabadság',100,true,10)
      ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,pay_percent=EXCLUDED.pay_percent,system=true;

      INSERT INTO master_inventory_movement_types(code,name,direction,system,sort_order) VALUES
        ('receipt','Bevételezés','in',true,10),
        ('issue','Kiadás','out',true,20),
        ('transfer','Raktárközi átvezetés','transfer',true,30),
        ('correction','Korrekció','correction',true,40)
      ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,direction=EXCLUDED.direction,system=true;

      INSERT INTO finance_payment_methods(location_id,code,name,method_type,system,sort_order) VALUES
        (NULL,'cash','Készpénz','cash',true,10),
        (NULL,'card','Bankkártya','card',true,20),
        (NULL,'transfer','Átutalás','bank_transfer',true,30),
        (NULL,'voucher','Utalvány','voucher',true,40),
        (NULL,'online','Online bankkártya','online_card',true,50)
      ON CONFLICT DO NOTHING;

      INSERT INTO finance_document_types(location_id,code,name,direction,group_key,system,payment_method_code,is_transfer,opening_shortage,closing_shortage,opening_surplus,closing_surplus,sort_order) VALUES
        (NULL,'cash_shortage_opening','Pénztárhiány – nyitás','expense','cash_adjustment',true,'cash',false,true,false,false,false,10),
        (NULL,'cash_shortage_closing','Pénztárhiány – zárás','expense','cash_adjustment',true,'cash',false,false,true,false,false,20),
        (NULL,'cash_surplus_opening','Pénztártöbblet – nyitás','income','cash_adjustment',true,'cash',false,false,false,true,false,30),
        (NULL,'cash_surplus_closing','Pénztártöbblet – zárás','income','cash_adjustment',true,'cash',false,false,false,false,true,40),
        (NULL,'cash_transfer','Pénztári átvezetés','both','transfer',true,'cash',true,false,false,false,false,50)
      ON CONFLICT DO NOTHING;

      INSERT INTO inventory_warehouses(location_id,code,name,warehouse_type,is_default_sale,is_default_consumption,procurement_default,system,sort_order,comment)
      SELECT NULL,'CENTRAL_PRODUCTS','Központi termék raktár','retail',true,false,true,true,10,'Rendszer által létrehozott központi raktár'
      WHERE NOT EXISTS(SELECT 1 FROM inventory_warehouses WHERE location_id IS NULL AND code='CENTRAL_PRODUCTS');
      UPDATE inventory_warehouses SET system=true WHERE location_id IS NULL AND code IN('CENTRAL_PRODUCTS','CENTRAL_CONSUMABLES');

      DO $$ BEGIN
        IF to_regclass('public.menus') IS NOT NULL THEN
          INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
          VALUES('masterdata','Törzsadatok','Database',NULL,145,NULL,'master_data',true)
          ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,icon=EXCLUDED.icon,route=NULL,is_active=true;

          INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
          SELECT v.code,v.name,NULL,v.route,v.order_index,m.id,v.feature_key,true
          FROM (VALUES
            ('masterdata.central','Központi törzsadatok','/masterdata',5,'master_data'),
            ('masterdata.salons','Szalonok','/masterdata/salons',10,'master_data'),
            ('masterdata.departments','Részlegek','/masterdata/departments',30,'departments'),
            ('masterdata.assets','Eszközök és eszköztípusok','/masterdata/assets',60,'assets'),
            ('masterdata.suppliers','Partnerek / Beszállítók','/masterdata/suppliers',70,'suppliers'),
            ('masterdata.leave-types','Szabadságtípusok','/masterdata/leave-types',80,'leave_types'),
            ('masterdata.units','Mennyiségi egységek','/masterdata/units',90,'units'),
            ('masterdata.price-types','Ártípusok','/masterdata/price-types',100,'price_types'),
            ('masterdata.warehouses','Raktárak','/masterdata/warehouses',110,'warehouses'),
            ('masterdata.movement-types','Készletmozgás-típusok','/masterdata/movement-types',120,'movement_types'),
            ('masterdata.payment-methods','Fizetési módok','/masterdata/payment-methods',125,'finance'),
            ('masterdata.transaction-types','Pénzügyi tranzakciótípusok','/masterdata/financial-transaction-types',130,'financial_transaction_types')
          ) AS v(code,name,route,order_index,feature_key)
          CROSS JOIN (SELECT id FROM menus WHERE code='masterdata' LIMIT 1) m
          ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,route=EXCLUDED.route,order_index=EXCLUDED.order_index,parent_id=EXCLUDED.parent_id,feature_key=EXCLUDED.feature_key,is_active=true;
        END IF;
      END $$;
    `);
  })().catch((error) => {
    schemaReady = null;
    throw error;
  });
  return schemaReady;
}

async function getRow(def: EntityDef, id: string) {
  const table = safeIdentifier(def.table);
  const { rows } = await db.query(`SELECT * FROM ${table} WHERE id::text=$1 LIMIT 1`, [id]);
  return rows[0] || null;
}

async function normalizeWarehouseDefault(record: any) {
  if (!record?.procurement_default) return;
  await db.query(
    `UPDATE inventory_warehouses SET procurement_default=false,updated_at=now()
     WHERE id<>$1 AND ((location_id IS NULL AND $2::text IS NULL) OR location_id=$2::text)`,
    [record.id, record.location_id ?? null],
  );
}

router.use(async (_req, _res, next) => {
  try {
    await ensureSchema();
    next();
  } catch (error) {
    next(error);
  }
});

router.get("/catalog", async (_req: AuthRequest, res, next) => {
  try {
    res.json(await getCatalogPayload());
  } catch (error) {
    next(error);
  }
});

router.get("/:entity/export.csv", async (req: AuthRequest, res, next) => {
  try {
    const def = byKey.get(req.params.entity);
    if (!def) return res.status(404).json({ message: "Ismeretlen törzsadattípus." });
    const table = safeIdentifier(def.table);
    const { rows } = await db.query(`SELECT * FROM ${table} ORDER BY ${def.orderBy}`);
    const fieldMap = new Map(def.fields.map((f) => [f.key, f]));
    const columns = def.listFields;
    const esc = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
    const csv = [columns.map((key) => esc(fieldMap.get(key)?.label || key)).join(";"), ...rows.map((row) => columns.map((key) => esc(row[key])).join(";"))].join("\r\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${def.key}.csv"`);
    res.send(`\uFEFF${csv}`);
  } catch (error) {
    next(error);
  }
});

router.get("/:entity", async (req: AuthRequest, res, next) => {
  try {
    const def = byKey.get(req.params.entity);
    if (!def) return res.status(404).json({ message: "Ismeretlen törzsadattípus." });
    const table = safeIdentifier(def.table);
    const active = safeIdentifier(def.activeColumn);
    const includeInactive = String(req.query.include_inactive || "") === "1";
    const q = String(req.query.q || "").trim();
    const params: unknown[] = [includeInactive, q];
    const searchSql = def.searchColumns.length
      ? `AND ($2='' OR ${def.searchColumns.map((column) => `COALESCE(${safeIdentifier(column)}::text,'') ILIKE '%'||$2||'%'`).join(" OR ")})`
      : "";
    const { rows } = await db.query(
      `SELECT * FROM ${table} WHERE ($1::boolean OR ${active}=true) ${searchSql} ORDER BY ${def.orderBy} LIMIT 1000`,
      params,
    );
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

router.post("/:entity", async (req: AuthRequest, res: Response, next) => {
  try {
    const def = byKey.get(req.params.entity);
    if (!def) return res.status(404).json({ message: "Ismeretlen törzsadattípus." });
    const body = req.body || {};
    const columns: string[] = [];
    const values: unknown[] = [];
    for (const field of def.fields) {
      const raw = body[field.key];
      if (field.required && (raw === undefined || raw === null || String(raw).trim() === "")) {
        return res.status(400).json({ message: `${field.label}: kötelező mező.` });
      }
      if (raw !== undefined) {
        columns.push(safeIdentifier(field.key));
        values.push(dbValue(field, raw));
      }
    }
    if (!columns.length) return res.status(400).json({ message: "Nincs menthető mező." });
    const table = safeIdentifier(def.table);
    const placeholders = values.map((_, index) => `$${index + 1}`).join(",");
    const { rows } = await db.query(`INSERT INTO ${table}(${columns.join(",")}) VALUES(${placeholders}) RETURNING *`, values);
    const created = rows[0];
    if (def.key === "warehouses") await normalizeWarehouseDefault(created);
    await audit(req, def.key, String(created.id), "create", null, created);
    invalidateCatalogCache();
    res.status(201).json(created);
  } catch (error: any) {
    if (error?.code === "23505") return res.status(409).json({ message: "Ezzel a kóddal vagy névvel már létezik törzsadat." });
    next(error);
  }
});

router.patch("/:entity/:id", async (req: AuthRequest, res: Response, next) => {
  try {
    const def = byKey.get(req.params.entity);
    if (!def) return res.status(404).json({ message: "Ismeretlen törzsadattípus." });
    const before = await getRow(def, req.params.id);
    if (!before) return res.status(404).json({ message: "A törzsadat nem található." });
    if (def.lockSystemEdit && def.systemColumn && before[def.systemColumn]) return res.status(409).json({ message: "Ez rendszerrekord, nem módosítható." });

    const sets: string[] = [];
    const values: unknown[] = [];
    for (const field of def.fields) {
      if (req.body?.[field.key] === undefined) continue;
      values.push(dbValue(field, req.body[field.key]));
      sets.push(`${safeIdentifier(field.key)}=$${values.length}`);
    }
    if (!sets.length) return res.status(400).json({ message: "Nincs módosítandó mező." });
    const table = safeIdentifier(def.table);
    values.push(req.params.id);
    const hasUpdatedAt = !["locations"].includes(def.table);
    const updatedSql = hasUpdatedAt ? ",updated_at=now()" : "";
    const { rows } = await db.query(`UPDATE ${table} SET ${sets.join(",")}${updatedSql} WHERE id::text=$${values.length} RETURNING *`, values);
    const updated = rows[0];
    if (def.key === "warehouses") await normalizeWarehouseDefault(updated);
    await audit(req, def.key, req.params.id, "update", before, updated);
    invalidateCatalogCache();
    res.json(updated);
  } catch (error: any) {
    if (error?.code === "23505") return res.status(409).json({ message: "Ezzel a kóddal vagy névvel már létezik törzsadat." });
    next(error);
  }
});

router.delete("/:entity/:id", async (req: AuthRequest, res: Response, next) => {
  try {
    const def = byKey.get(req.params.entity);
    if (!def) return res.status(404).json({ message: "Ismeretlen törzsadattípus." });
    const before = await getRow(def, req.params.id);
    if (!before) return res.status(404).json({ message: "A törzsadat nem található." });
    if (def.systemColumn && before[def.systemColumn]) return res.status(409).json({ message: "A rendszer által fenntartott törzsadat nem inaktiválható." });
    const table = safeIdentifier(def.table);
    const active = safeIdentifier(def.activeColumn);
    const hasUpdatedAt = !["locations"].includes(def.table);
    const { rows } = await db.query(
      `UPDATE ${table} SET ${active}=false${hasUpdatedAt ? ",updated_at=now()" : ""} WHERE id::text=$1 RETURNING *`,
      [req.params.id],
    );
    await audit(req, def.key, req.params.id, "deactivate", before, rows[0]);
    invalidateCatalogCache();
    res.json(rows[0]);
  } catch (error) {
    next(error);
  }
});

router.get("/:entity/:id/audit", async (req: AuthRequest, res, next) => {
  try {
    const def = byKey.get(req.params.entity);
    if (!def) return res.status(404).json({ message: "Ismeretlen törzsadattípus." });
    const { rows } = await db.query(
      `SELECT id,entity_key,record_id,action,actor,before_data,after_data,created_at
       FROM master_data_audit WHERE entity_key=$1 AND record_id=$2 ORDER BY created_at DESC LIMIT 100`,
      [def.key, req.params.id],
    );
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

export default router;