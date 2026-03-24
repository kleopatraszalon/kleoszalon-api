import express from "express";
import { pool } from "../db";

export const kioskRouter = express.Router();

// --- DB compat helpers ---
async function tableExists(tableName: string): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1 LIMIT 1`,
    [tableName]
  );
  return (r.rowCount || 0) > 0;
}

async function columnExists(tableName: string, columnName: string): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2 LIMIT 1`,
    [tableName, columnName]
  );
  return (r.rowCount || 0) > 0;
}

async function resolveColumn(tableName: string, candidates: string[]): Promise<string | null> {
  for (const c of candidates) {
    // eslint-disable-next-line no-await-in-loop
    if (await columnExists(tableName, c)) return c;
  }
  return null;
}

async function resolveServicesSelect(alias: string, lang: string) {
  const nameCol =
    (lang === "en" ? await resolveColumn("services", ["name_en", "name"]) :
     lang === "ru" ? await resolveColumn("services", ["name_ru", "name"]) :
     await resolveColumn("services", ["name_hu", "name"])) || "name";

  const priceCol = (await resolveColumn("services", ["base_price", "price", "base_price_ft", "amount"])) || null;
  const durationCol = (await resolveColumn("services", ["duration_minutes", "duration_min", "base_duration_minutes", "base_duration_min"])) || null;

  const activeCol = (await resolveColumn("services", ["is_active", "active", "enabled"])) || null;

  const typeIdCol = (await resolveColumn("services", ["service_type_id", "category_id"])) || null;

  const stOk = await tableExists("service_types");
  const joinSql = stOk && typeIdCol ? `LEFT JOIN service_types st ON st.id = ${alias}.${typeIdCol}` : "";

  const stNameCol =
    (lang === "en" ? "st.name_en" :
     lang === "ru" ? "st.name_ru" :
     "st.name_hu");

  const typeNameSql = stOk && typeIdCol
    ? `COALESCE(NULLIF(TRIM(${stNameCol}),''), 'Egyéb')`
    : `'Egyéb'`;

  const activeWhere = activeCol ? `${alias}.${activeCol} = TRUE` : `TRUE`;

  return {
    nameCol,
    priceSql: priceCol ? `${alias}.${priceCol}` : `NULL`,
    durationSql: durationCol ? `${alias}.${durationCol}` : `NULL`,
    activeWhere,
    typeIdSql: typeIdCol ? `${alias}.${typeIdCol}` : `NULL`,
    typeNameSql,
    joinSql,
  };
}

function safeLang(q: any): string {
  const l = String(q || "hu").toLowerCase();
  return (l === "en" || l === "ru") ? l : "hu";
}

// GET /api/kiosk/services?lang=hu&locationId=uuid
kioskRouter.get("/services", async (req, res) => {
  try {
    const lang = safeLang(req.query.lang);
    const locationId = String(req.query.locationId || "") || null;

    const sel = await resolveServicesSelect("s", lang);
    const locationCol = (await resolveColumn("services", ["location_id", "locationId"])) || null;

    const whereParts: string[] = [sel.activeWhere];
    const params: any[] = [];
    if (locationCol && locationId) {
      params.push(locationId);
      whereParts.push(`s.${locationCol} = $${params.length}`);
    }

    const sql = `
      SELECT
        s.id,
        s.${sel.nameCol} AS name,
        ${sel.priceSql} AS base_price,
        ${sel.durationSql} AS duration_minutes,
        ${sel.typeIdSql} AS cat_id,
        ${sel.typeNameSql} AS cat_name
      FROM services s
      ${sel.joinSql}
      WHERE ${whereParts.join(" AND ")}
      ORDER BY cat_name ASC, name ASC
    `;

    const rows = (await pool.query(sql, params)).rows;

    // categories list
    const categoriesMap = new Map<string, { id: string; name: string; image_path: string | null }>();
    for (const r of rows) {
      const id = String(r.cat_id || "other");
      if (!categoriesMap.has(id)) {
        categoriesMap.set(id, {
          id,
          name: String(r.cat_name || "Egyéb"),
          // frontend static mapping: /kiosk/categories/<id>.png ; can be overridden later from DB
          image_path: id !== "other" ? `/kiosk/categories/${id}.png` : null,
        });
      }
    }

    return res.json({
      ok: true,
      categories: Array.from(categoriesMap.values()),
      services: rows.map((r) => ({
        id: r.id,
        name: r.name,
        base_price: r.base_price != null ? Number(r.base_price) : null,
        duration_minutes: r.duration_minutes != null ? Number(r.duration_minutes) : null,
        category_id: r.cat_id ? String(r.cat_id) : "other",
        category_name: String(r.cat_name || "Egyéb"),
      })),
    });
  } catch (e: any) {
    console.error("Kiosk services hiba:", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// GET /api/kiosk/menu?lang=hu&locationId=uuid  (UI kompat)
kioskRouter.get("/menu", async (req, res) => {
  try {
    const lang = safeLang(req.query.lang);
    // reuse /services
    const locationId = String(req.query.locationId || "") || null;

    // call internal function by duplicating selection (avoid router.handle)
    const sel = await resolveServicesSelect("s", lang);
    const locationCol = (await resolveColumn("services", ["location_id", "locationId"])) || null;

    const whereParts: string[] = [sel.activeWhere];
    const params: any[] = [];
    if (locationCol && locationId) {
      params.push(locationId);
      whereParts.push(`s.${locationCol} = $${params.length}`);
    }

    const sql = `
      SELECT
        s.id,
        s.${sel.nameCol} AS name,
        ${sel.priceSql} AS base_price,
        ${sel.durationSql} AS duration_minutes,
        ${sel.typeIdSql} AS cat_id,
        ${sel.typeNameSql} AS cat_name
      FROM services s
      ${sel.joinSql}
      WHERE ${whereParts.join(" AND ")}
      ORDER BY cat_name ASC, name ASC
    `;
    const rows = (await pool.query(sql, params)).rows;

    const grouped: Record<string, any> = {};
    for (const r of rows) {
      const key = String(r.cat_id || "other");
      const title = String(r.cat_name || "Egyéb");
      if (!grouped[key]) grouped[key] = { id: key, title, items: [] as any[] };
      grouped[key].items.push({
        id: r.id,
        title: r.name,
        price: r.base_price != null ? Number(r.base_price) : null,
        duration_minutes: r.duration_minutes != null ? Number(r.duration_minutes) : null,
      });
    }

    return res.json({
      ok: true,
      sections: Object.values(grouped),
      services: rows.map((r) => ({
        id: r.id,
        name: r.name,
        base_price: r.base_price != null ? Number(r.base_price) : null,
        duration_minutes: r.duration_minutes != null ? Number(r.duration_minutes) : null,
        service_type_id: r.cat_id ? String(r.cat_id) : "other",
        service_type_name: String(r.cat_name || "Egyéb"),
      })),
    });
  } catch (e: any) {
    console.error("Kiosk menu hiba:", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});
