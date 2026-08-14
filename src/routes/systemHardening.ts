import { Router, Response } from "express";
import db from "../db";
import { AuthRequest, requireAuth } from "../middleware/auth";
import { requireAdmin } from "../middleware/requireRoles";
import { ensureSystemAuditSchema, writeSystemAudit } from "../audit/systemAudit";

type EntityDef = {
  key: string;
  labelHu: string;
  labelEn: string;
  table: string;
  module: string;
  activeCandidates: string[];
  protectSystemRows?: boolean;
};

const defs: EntityDef[] = [
  { key: "clients", labelHu: "Ügyfelek", labelEn: "Customers", table: "clients", module: "crm", activeCandidates: ["is_active", "active"] },
  { key: "employees", labelHu: "Munkatársak", labelEn: "Staff", table: "employees", module: "hr", activeCandidates: ["active", "is_active"] },
  { key: "salons", labelHu: "Szalonok", labelEn: "Locations", table: "locations", module: "administration", activeCandidates: ["is_active", "active"] },
  { key: "departments", labelHu: "Részlegek", labelEn: "Departments", table: "master_departments", module: "administration", activeCandidates: ["active", "is_active"] },
  { key: "equipment-types", labelHu: "Eszköztípusok", labelEn: "Equipment types", table: "master_equipment_types", module: "administration", activeCandidates: ["active", "is_active"] },
  { key: "equipment", labelHu: "Eszközök", labelEn: "Equipment", table: "master_equipment", module: "administration", activeCandidates: ["active", "is_active"] },
  { key: "suppliers", labelHu: "Beszállítók", labelEn: "Suppliers", table: "suppliers", module: "administration", activeCandidates: ["active", "is_active"] },
  { key: "warehouses", labelHu: "Raktárak", labelEn: "Warehouses", table: "inventory_warehouses", module: "inventory", activeCandidates: ["active", "is_active"], protectSystemRows: true },
  { key: "units", labelHu: "Mennyiségi egységek", labelEn: "Units", table: "inventory_units", module: "inventory", activeCandidates: ["active", "is_active"], protectSystemRows: true },
  { key: "price-types", labelHu: "Ártípusok", labelEn: "Price types", table: "master_price_types", module: "administration", activeCandidates: ["active", "is_active"], protectSystemRows: true },
  { key: "leave-types", labelHu: "Szabadságtípusok", labelEn: "Leave types", table: "master_leave_types", module: "hr", activeCandidates: ["active", "is_active"], protectSystemRows: true },
  { key: "movement-types", labelHu: "Készletmozgás-típusok", labelEn: "Inventory movement types", table: "master_inventory_movement_types", module: "inventory", activeCandidates: ["active", "is_active"], protectSystemRows: true },
  { key: "payment-methods", labelHu: "Fizetési módok", labelEn: "Payment methods", table: "finance_payment_methods", module: "finance", activeCandidates: ["active", "is_active"], protectSystemRows: true },
  { key: "financial-transaction-types", labelHu: "Pénzügyi tranzakciótípusok", labelEn: "Financial transaction types", table: "finance_document_types", module: "finance", activeCandidates: ["active", "is_active"], protectSystemRows: true },
];

const byKey = new Map(defs.map((def) => [def.key, def]));
const router = Router();
let lifecycleSchemaReady: Promise<void> | null = null;

function qi(value: string) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) throw new Error("Invalid SQL identifier");
  return `"${value}"`;
}

async function tableExists(table: string) {
  const { rows } = await db.query(
    `SELECT EXISTS(
       SELECT 1
       FROM pg_class c
       JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relname=$1 AND c.relkind IN ('r','p')
     ) ok`,
    [table],
  );
  return Boolean(rows[0]?.ok);
}

async function activeColumn(def: EntityDef) {
  const { rows } = await db.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1 AND column_name=ANY($2::text[])`,
    [def.table, def.activeCandidates],
  );
  const found = new Set(rows.map((row: any) => String(row.column_name)));
  return def.activeCandidates.find((column) => found.has(column)) || null;
}

export function ensureRecordLifecycleSchema() {
  if (!lifecycleSchemaReady) {
    lifecycleSchemaReady = (async () => {
      await ensureSystemAuditSchema();
      for (const def of defs) {
        if (!(await tableExists(def.table))) continue;
        await db.query(`
          ALTER TABLE ${qi(def.table)} ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
          ALTER TABLE ${qi(def.table)} ADD COLUMN IF NOT EXISTS deleted_by text;
          ALTER TABLE ${qi(def.table)} ADD COLUMN IF NOT EXISTS delete_reason text;
          CREATE INDEX IF NOT EXISTS ${qi(`${def.table}_deleted_at_idx`)}
            ON ${qi(def.table)}(deleted_at) WHERE deleted_at IS NOT NULL;
        `);
      }
    })().catch((error) => {
      lifecycleSchemaReady = null;
      throw error;
    });
  }
  return lifecycleSchemaReady;
}

async function getRow(def: EntityDef, id: string) {
  if (!(await tableExists(def.table))) return null;
  const { rows } = await db.query(
    `SELECT to_jsonb(x) data FROM ${qi(def.table)} x WHERE id::text=$1 LIMIT 1`,
    [id],
  );
  return rows[0]?.data || null;
}

function displayName(row: any) {
  return String(row?.full_name || row?.name || row?.code || row?.email || row?.phone || row?.item_number || row?.id || "");
}

function isSystemRow(def: EntityDef, row: any) {
  if (!def.protectSystemRows) return false;
  return Boolean(row?.system || row?.is_system || row?.system_record);
}

function summary(def: EntityDef, row: any) {
  return {
    entity: def.key,
    entity_label: def.labelHu,
    entity_label_hu: def.labelHu,
    entity_label_en: def.labelEn,
    id: String(row?.id || ""),
    name: displayName(row),
    deleted_at: row?.deleted_at || null,
    deleted_by: row?.deleted_by || null,
    delete_reason: row?.delete_reason || null,
    location_id: row?.location_id || null,
  };
}

function requestedLimit(req: AuthRequest) {
  const raw = Number(req.query.limit || 300);
  return Math.max(20, Math.min(500, Number.isFinite(raw) ? raw : 300));
}

router.use(requireAuth, requireAdmin);
router.use(async (_req, _res, next) => {
  try {
    await ensureRecordLifecycleSchema();
    next();
  } catch (error) {
    next(error);
  }
});

router.get("/entities", async (_req, res, next) => {
  try {
    const out = [];
    for (const def of defs) {
      if (!(await tableExists(def.table))) continue;
      const { rows } = await db.query(
        `SELECT count(*)::int count FROM ${qi(def.table)} WHERE deleted_at IS NOT NULL`,
      );
      out.push({
        key: def.key,
        label: def.labelHu,
        label_hu: def.labelHu,
        label_en: def.labelEn,
        deleted_count: Number(rows[0]?.count || 0),
      });
    }
    res.json(out);
  } catch (error) {
    next(error);
  }
});

router.get("/archived", async (req: AuthRequest, res, next) => {
  try {
    const entityKey = String(req.query.entity || "").trim();
    const q = String(req.query.q || "").trim().toLowerCase();
    const limit = requestedLimit(req);
    const selected = entityKey ? [byKey.get(entityKey)].filter(Boolean) as EntityDef[] : defs;
    if (entityKey && !selected.length) return res.status(404).json({ message: "Ismeretlen adattípus." });

    const out: any[] = [];
    for (const def of selected) {
      if (!(await tableExists(def.table))) continue;
      const { rows } = await db.query(
        `SELECT to_jsonb(x) data FROM ${qi(def.table)} x
         WHERE deleted_at IS NOT NULL
         ORDER BY deleted_at DESC
         LIMIT $1`,
        [limit],
      );
      for (const item of rows) {
        const row = item.data;
        const itemSummary = summary(def, row);
        const haystack = `${itemSummary.name} ${row?.email || ""} ${row?.phone || ""} ${row?.code || ""} ${itemSummary.delete_reason || ""}`.toLowerCase();
        if (!q || haystack.includes(q)) out.push(itemSummary);
      }
    }
    out.sort((a, b) => String(b.deleted_at || "").localeCompare(String(a.deleted_at || "")));
    res.json(out.slice(0, limit));
  } catch (error) {
    next(error);
  }
});

router.post("/:entity/:id/archive", async (req: AuthRequest, res: Response, next) => {
  try {
    const def = byKey.get(req.params.entity);
    if (!def) return res.status(404).json({ message: "Ismeretlen adattípus." });
    const before = await getRow(def, req.params.id);
    if (!before) return res.status(404).json({ message: "A rekord nem található." });
    if (before.deleted_at) return res.status(409).json({ message: "A rekord már a lomtárban van." });
    if (isSystemRow(def, before)) return res.status(409).json({ message: "A rendszer által fenntartott rekord nem inaktiválható." });

    const reason = String(req.body?.reason || req.body?.note || "").trim() || "Adminisztrátori inaktiválás";
    const actor = req.user?.email || String(req.user?.id || "");
    const active = await activeColumn(def);
    const sets = ["deleted_at=now()", "deleted_by=$2", "delete_reason=$3"];
    if (active) sets.unshift(`${qi(active)}=false`);
    await db.query(
      `UPDATE ${qi(def.table)} SET ${sets.join(",")} WHERE id::text=$1`,
      [req.params.id, actor, reason],
    );
    const after = await getRow(def, req.params.id);
    await writeSystemAudit(req, {
      moduleKey: def.module,
      entityType: def.key,
      entityId: req.params.id,
      action: "soft_delete",
      severity: "warning",
      summary: `${def.labelHu}: ${displayName(before)} inaktiválva`,
      before,
      after,
      metadata: { reason, lifecycle: "soft-delete" },
      locationId: before.location_id,
    });
    res.json({ ok: true, record: summary(def, after) });
  } catch (error) {
    next(error);
  }
});

router.post("/:entity/:id/restore", async (req: AuthRequest, res: Response, next) => {
  try {
    const def = byKey.get(req.params.entity);
    if (!def) return res.status(404).json({ message: "Ismeretlen adattípus." });
    const before = await getRow(def, req.params.id);
    if (!before) return res.status(404).json({ message: "A rekord nem található." });
    if (!before.deleted_at) return res.status(409).json({ message: "A rekord nincs a lomtárban." });

    const active = await activeColumn(def);
    const sets = ["deleted_at=NULL", "deleted_by=NULL", "delete_reason=NULL"];
    if (active) sets.unshift(`${qi(active)}=true`);
    await db.query(
      `UPDATE ${qi(def.table)} SET ${sets.join(",")} WHERE id::text=$1`,
      [req.params.id],
    );
    const after = await getRow(def, req.params.id);
    await writeSystemAudit(req, {
      moduleKey: def.module,
      entityType: def.key,
      entityId: req.params.id,
      action: "restore",
      severity: "info",
      summary: `${def.labelHu}: ${displayName(before)} visszaállítva`,
      before,
      after,
      metadata: { lifecycle: "restore" },
      locationId: before.location_id,
    });
    res.json({ ok: true, record: summary(def, after) });
  } catch (error) {
    next(error);
  }
});

export default router;
