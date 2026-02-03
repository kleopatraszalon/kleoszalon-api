import { Router } from "express";
import * as dbMod from "../db";

// Pool kompatibilitás: kezeli, ha a db modul default export, vagy { pool } named export.
const pool: any = (dbMod as any).default ?? (dbMod as any).pool ?? (dbMod as any);
/**
 * Signage Admin API
 * - GET /services, PUT /services/:id/override
 * - CRUD: /deals, /videos, /quotes, /custom-services
 * - CRUD: /professionals  (és legacy alias: /)
 *
 * Cél: a frontend által hívott végpontok NE adjanak 404-et.
 * A táblanév/mezőnév eltéréseket óvatosan kezeljük (tableExists + column discovery).
 */

const router = Router();
console.log("✅ signageAdmin routes loaded v3 (2026-02-03)");

// -----------------------------
// Helpers
// -----------------------------
async function tableExists(table: string): Promise<boolean> {
  // PostgreSQL: to_regclass('public.table_name') -> null, ha nincs
  const { rows } = await pool.query(`SELECT to_regclass($1) AS reg`, [`public.${table}`]);
  return !!rows?.[0]?.reg;
}

type ColCache = { at: number; cols: Set<string> };
const colCache: Record<string, ColCache> = {};
async function getCols(table: string): Promise<Set<string>> {
  const now = Date.now();
  const cached = colCache[table];
  if (cached && now - cached.at < 60_000) return cached.cols; // 60s cache

  const { rows } = await pool.query(
    `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = $1
    `,
    [table]
  );
  const cols = new Set<string>((rows ?? []).map((r: any) => String(r.column_name)));
  colCache[table] = { at: now, cols };
  return cols;
}

function pickBool(v: any): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["true", "1", "yes", "y", "on"].includes(s)) return true;
    if (["false", "0", "no", "n", "off"].includes(s)) return false;
  }
  return undefined;
}

function pickInt(v: any): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.trunc(n);
  return undefined;
}

function pickString(v: any): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s.length ? s : undefined;
}

async function firstExistingTable(candidates: string[]): Promise<string | null> {
  for (const t of candidates) {
    if (await tableExists(t)) return t;
  }
  return null;
}

function chooseFirst(cols: Set<string>, candidates: string[]): string | null {
  for (const c of candidates) {
    if (cols.has(c)) return c;
  }
  return null;
}

// -----------------------------
// SERVICES (alap szolgáltatások + override)
// -----------------------------
router.get("/services", async (req, res) => {
  try {
    // 1) base services: tipikusan "services" tábla (a projektben van servicesRouter)
    const baseTable = (await tableExists("services")) ? "services" : null;
    if (!baseTable) return res.json({ services: [] });

    const baseCols = await getCols(baseTable);

    const idCol = chooseFirst(baseCols, ["id", "service_id"]);
    const nameCol = chooseFirst(baseCols, ["name_hu", "name", "title", "service_name"]);
    const priceCol = chooseFirst(baseCols, ["price_text", "price", "price_huf", "base_price", "price_from"]);
    const activeCol = chooseFirst(baseCols, ["enabled", "is_active", "active", "visible"]);

    if (!idCol || !nameCol) return res.json({ services: [] });

    const where = activeCol ? `WHERE COALESCE(${activeCol}::boolean, true) = true` : "";
    const baseSql = `
      SELECT
        ${idCol}::text AS id,
        ${nameCol}::text AS name
        ${priceCol ? `, ${priceCol}::text AS price_text` : `, NULL::text AS price_text`}
      FROM ${baseTable}
      ${where}
      ORDER BY ${nameCol} ASC
    `;
    const base = await pool.query(baseSql);

    // 2) override tábla (ha van)
    const overrideTable = await firstExistingTable([
      "signage_service_overrides",
      "signage_services_overrides",
      "signage_service_override",
      "signage_services_override",
    ]);

    const services = (base.rows ?? []).map((r: any) => ({
      id: String(r.id),
      name: String(r.name ?? ""),
      price_text: r.price_text ?? null,
      enabled: true,
      priority: 0,
      // extra mezők (nem árt)
      price_text_override: null as string | null,
    }));

    if (!overrideTable || services.length === 0) {
      return res.json({ services });
    }

    const oCols = await getCols(overrideTable);
    const serviceIdCol = chooseFirst(oCols, ["service_id", "services_id", "id"]);
    const enabledCol = chooseFirst(oCols, ["enabled", "show", "display"]);
    const priceOverrideCol = chooseFirst(oCols, ["price_text_override", "price_override", "price_text"]);
    const priorityCol = chooseFirst(oCols, ["priority", "sort_order", "order_index"]);

    if (!serviceIdCol) return res.json({ services });

    const ids = services.map((s: { id: string }) => s.id);
    const { rows: oRows } = await pool.query(
      `SELECT * FROM ${overrideTable} WHERE ${serviceIdCol}::text = ANY($1::text[])`,
      [ids]
    );

    const byId = new Map<string, any>();
    for (const o of oRows ?? []) {
      byId.set(String(o[serviceIdCol]), o);
    }

    const merged = services.map((s: { id: string; [k: string]: any }) => {
      const o = byId.get(s.id);
      if (!o) return s;
      const enabled = enabledCol ? (o[enabledCol] ?? true) : true;
      const pr = priorityCol ? (o[priorityCol] ?? 0) : 0;
      const po = priceOverrideCol ? (o[priceOverrideCol] ?? null) : null;
      return {
        ...s,
        enabled: enabled === null || enabled === undefined ? true : !!enabled,
        priority: Number.isFinite(Number(pr)) ? Number(pr) : 0,
        price_text_override: po ? String(po) : null,
      };
    });

    return res.json({ services: merged });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? "Failed to list services" });
  }
});

router.put("/services/:id/override", async (req, res) => {
  try {
    const id = String(req.params.id);

    const overrideTable = await firstExistingTable([
      "signage_service_overrides",
      "signage_services_overrides",
      "signage_service_override",
      "signage_services_override",
    ]);
    if (!overrideTable) {
      return res.status(500).json({ error: "Missing override table (signage_service_overrides)" });
    }

    const cols = await getCols(overrideTable);
    const serviceIdCol = chooseFirst(cols, ["service_id", "services_id"]);
    if (!serviceIdCol) return res.status(500).json({ error: "Override table has no service_id column" });

    // támogatjuk a legacy mezőneveket is
    const enabled =
      pickBool(req.body?.enabled) ??
      pickBool(req.body?.show) ??
      pickBool(req.body?.display);

    const price_text_override = pickString(req.body?.price_text_override) ?? pickString(req.body?.price_text);
    const priority = pickInt(req.body?.priority);

    // mezőnevek az override táblában (ha eltérnek, akkor a ensureSignageTables-t érdemes egységesíteni)
    const enabledCol = chooseFirst(cols, ["enabled", "show", "display"]) ?? "enabled";
    const priceCol = chooseFirst(cols, ["price_text_override", "price_override", "price_text"]) ?? "price_text_override";
    const prCol = chooseFirst(cols, ["priority", "sort_order", "order_index"]) ?? "priority";

    const sql = `
      INSERT INTO ${overrideTable} (${serviceIdCol}, ${enabledCol}, ${priceCol}, ${prCol})
      VALUES ($1, COALESCE($2, true), $3, COALESCE($4, 0))
      ON CONFLICT (${serviceIdCol})
      DO UPDATE SET
        ${enabledCol} = COALESCE(EXCLUDED.${enabledCol}, ${overrideTable}.${enabledCol}),
        ${priceCol}   = EXCLUDED.${priceCol},
        ${prCol}      = COALESCE(EXCLUDED.${prCol}, ${overrideTable}.${prCol})
      RETURNING *
    `;
    const r = await pool.query(sql, [id, enabled ?? null, price_text_override ?? null, priority ?? null]);
    return res.json({ ok: true, override: r.rows?.[0] ?? null });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? "Failed to upsert service override" });
  }
});

// -----------------------------
// GENERIC CRUD builders (deals, videos, quotes, custom-services)
// -----------------------------
async function listFrom(table: string, key: string, orderFallback: string[] = ["priority", "created_at", "id"]) {
  if (!(await tableExists(table))) return { [key]: [] };
  const cols = await getCols(table);
  const orderCol = chooseFirst(cols, orderFallback) ?? "id";
  const { rows } = await pool.query(`SELECT * FROM ${table} ORDER BY ${orderCol} ASC`);
  return { [key]: rows ?? [] };
}

async function insertInto(table: string, payload: any, returningKey: string) {
  if (!(await tableExists(table))) throw new Error(`Missing table: ${table}`);
  const cols = await getCols(table);

  // csak ismert oszlopokat engedünk be
  const keys = Object.keys(payload ?? {}).filter((k) => cols.has(k));
  if (keys.length === 0) {
    // ha semmi nem passzol, próbálunk minimálisat
    const { rows } = await pool.query(`INSERT INTO ${table} DEFAULT VALUES RETURNING *`);
    return { [returningKey]: rows?.[0] ?? null };
  }

  const vals = keys.map((_, i) => `$${i + 1}`);
  const sql = `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${vals.join(", ")}) RETURNING *`;
  const { rows } = await pool.query(sql, keys.map((k) => payload[k]));
  return { [returningKey]: rows?.[0] ?? null };
}

async function updateById(table: string, id: string, payload: any, returningKey: string) {
  if (!(await tableExists(table))) throw new Error(`Missing table: ${table}`);
  const cols = await getCols(table);
  const idCol = cols.has("id") ? "id" : (cols.has("uuid") ? "uuid" : "id");

  const keys = Object.keys(payload ?? {}).filter((k) => cols.has(k));
  if (keys.length === 0) {
    const { rows } = await pool.query(`SELECT * FROM ${table} WHERE ${idCol}::text = $1`, [id]);
    return { [returningKey]: rows?.[0] ?? null };
  }

  const set = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  const sql = `UPDATE ${table} SET ${set} WHERE ${idCol}::text = $1 RETURNING *`;
  const { rows } = await pool.query(sql, [id, ...keys.map((k) => payload[k])]);
  return { [returningKey]: rows?.[0] ?? null };
}

async function deleteById(table: string, id: string) {
  if (!(await tableExists(table))) throw new Error(`Missing table: ${table}`);
  const cols = await getCols(table);
  const idCol = cols.has("id") ? "id" : (cols.has("uuid") ? "uuid" : "id");
  const { rowCount } = await pool.query(`DELETE FROM ${table} WHERE ${idCol}::text = $1`, [id]);
  return { ok: (rowCount ?? 0) > 0 };
}

// -----------------------------
// DEALS
// -----------------------------
router.get("/deals", async (_req, res) => {
  try {
    const result = await listFrom("signage_deals", "deals");
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "Failed to list deals" });
  }
});

router.post("/deals", async (req, res) => {
  try {
    const payload = req.body ?? {};
    const result = await insertInto("signage_deals", payload, "deal");
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "Failed to create deal" });
  }
});

router.put("/deals/:id", async (req, res) => {
  try {
    const result = await updateById("signage_deals", String(req.params.id), req.body ?? {}, "deal");
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "Failed to update deal" });
  }
});

router.delete("/deals/:id", async (req, res) => {
  try {
    const result = await deleteById("signage_deals", String(req.params.id));
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "Failed to delete deal" });
  }
});

// -----------------------------
// VIDEOS
// -----------------------------
router.get("/videos", async (_req, res) => {
  try {
    const result = await listFrom("signage_videos", "videos");
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "Failed to list videos" });
  }
});

router.post("/videos", async (req, res) => {
  try {
    const result = await insertInto("signage_videos", req.body ?? {}, "video");
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "Failed to create video" });
  }
});

router.put("/videos/:id", async (req, res) => {
  try {
    const result = await updateById("signage_videos", String(req.params.id), req.body ?? {}, "video");
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "Failed to update video" });
  }
});

router.delete("/videos/:id", async (req, res) => {
  try {
    const result = await deleteById("signage_videos", String(req.params.id));
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "Failed to delete video" });
  }
});

// -----------------------------
// QUOTES
// -----------------------------
router.get("/quotes", async (_req, res) => {
  try {
    const result = await listFrom("signage_quotes", "quotes");
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "Failed to list quotes" });
  }
});

router.post("/quotes", async (req, res) => {
  try {
    const result = await insertInto("signage_quotes", req.body ?? {}, "quote");
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "Failed to create quote" });
  }
});

router.put("/quotes/:id", async (req, res) => {
  try {
    const result = await updateById("signage_quotes", String(req.params.id), req.body ?? {}, "quote");
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "Failed to update quote" });
  }
});

router.delete("/quotes/:id", async (req, res) => {
  try {
    const result = await deleteById("signage_quotes", String(req.params.id));
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "Failed to delete quote" });
  }
});

// -----------------------------
// CUSTOM SERVICES
// -----------------------------
router.get("/custom-services", async (_req, res) => {
  try {
    const result = await listFrom("signage_custom_services", "services");
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "Failed to list custom services" });
  }
});

router.post("/custom-services", async (req, res) => {
  try {
    const result = await insertInto("signage_custom_services", req.body ?? {}, "service");
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "Failed to create custom service" });
  }
});

router.put("/custom-services/:id", async (req, res) => {
  try {
    const result = await updateById("signage_custom_services", String(req.params.id), req.body ?? {}, "service");
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "Failed to update custom service" });
  }
});

router.delete("/custom-services/:id", async (req, res) => {
  try {
    const result = await deleteById("signage_custom_services", String(req.params.id));
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "Failed to delete custom service" });
  }
});

// -----------------------------
// -----------------------------
// PROFESSIONALS
// - új: /professionals
// - legacy: /  (hogy a régi frontend se törjön)
// -----------------------------
async function listProfessionals() {
  if (!(await tableExists("signage_professionals"))) return [];
  const cols = await getCols("signage_professionals");
  const orderCol = chooseFirst(cols, ["priority", "created_at", "name", "id"]) ?? "id";
  const { rows } = await pool.query(`SELECT * FROM signage_professionals ORDER BY ${orderCol} ASC`);
  return rows ?? [];
}

async function createProfessional(body: any) {
  if (!(await tableExists("signage_professionals"))) {
    throw new Error("Missing table: signage_professionals");
  }

  const cols = await getCols("signage_professionals");
  const name = pickString(body?.name) ?? "";
  const title = pickString(body?.title) ?? null;
  const note = pickString(body?.note) ?? null;

  const show = pickBool(body?.show) ?? pickBool(body?.enabled) ?? true;
  const is_free = pickBool(body?.is_free) ?? pickBool(body?.available) ?? false;
  const priority = pickInt(body?.priority) ?? 0;

  const payload: any = { name, title, note, show, is_free, priority };
  const keys = Object.keys(payload).filter((k) => cols.has(k));
  const vals = keys.map((_, i) => `$${i + 1}`);

  const { rows } = await pool.query(
    `INSERT INTO signage_professionals (${keys.join(", ")}) VALUES (${vals.join(", ")}) RETURNING *`,
    keys.map((k) => payload[k])
  );
  return rows?.[0] ?? null;
}

async function updateProfessional(id: string, body: any) {
  if (!(await tableExists("signage_professionals"))) {
    throw new Error("Missing table: signage_professionals");
  }

  const cols = await getCols("signage_professionals");
  const payload: any = {};

  if (body?.name !== undefined) payload.name = pickString(body?.name);
  if (body?.title !== undefined) payload.title = pickString(body?.title);
  if (body?.note !== undefined) payload.note = pickString(body?.note);

  const show = pickBool(body?.show) ?? pickBool(body?.enabled) ?? pickBool(body?.display);
  const is_free = pickBool(body?.is_free) ?? pickBool(body?.available);
  const priority = pickInt(body?.priority);

  if (show !== undefined) payload.show = show;
  if (is_free !== undefined) payload.is_free = is_free;
  if (priority !== undefined) payload.priority = priority;

  const keys = Object.keys(payload).filter((k) => cols.has(k));
  if (keys.length === 0) {
    const { rows } = await pool.query(`SELECT * FROM signage_professionals WHERE id::text = $1`, [id]);
    return rows?.[0] ?? null;
  }

  const set = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  const { rows } = await pool.query(
    `UPDATE signage_professionals SET ${set} WHERE id::text = $1 RETURNING *`,
    [id, ...keys.map((k) => payload[k])]
  );
  return rows?.[0] ?? null;
}

// /professionals
router.get("/professionals", async (_req, res) => {
  try {
    const professionals = await listProfessionals();
    res.json({ professionals });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "Failed to list professionals" });
  }
});

router.post("/professionals", async (req, res) => {
  try {
    const professional = await createProfessional(req.body);
    res.json({ professional });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "Failed to create professional" });
  }
});

router.put("/professionals/:id", async (req, res) => {
  try {
    const professional = await updateProfessional(String(req.params.id), req.body);
    res.json({ professional });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "Failed to update professional" });
  }
});

router.delete("/professionals/:id", async (req, res) => {
  try {
    const result = await deleteById("signage_professionals", String(req.params.id));
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "Failed to delete professional" });
  }
});

// legacy aliases: /  és /:id
router.get("/", async (_req, res) => {
  try {
    const professionals = await listProfessionals();
    res.json({ professionals });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "Failed to list professionals" });
  }
});

router.post("/", async (req, res) => {
  try {
    const professional = await createProfessional(req.body);
    res.json({ professional });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "Failed to create professional" });
  }
});

router.put("/:id", async (req, res) => {
  try {
    const professional = await updateProfessional(String(req.params.id), req.body);
    res.json({ professional });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "Failed to update professional" });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const result = await deleteById("signage_professionals", String(req.params.id));
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "Failed to delete professional" });
  }
});

export default router;