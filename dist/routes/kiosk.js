"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.kioskRouter = void 0;
const express_1 = require("express");
const db_1 = require("../db");
exports.kioskRouter = (0, express_1.Router)();
/**
 * Local vs Render adatbázis eltérések miatt NEM hivatkozhatunk olyan oszlopra,
 * ami egy adott környezetben nem létezik (még COALESCE-ben sem!), mert 42703-al elszáll.
 * Ezért oszlopfeloldást végzünk "próbálkozással" (SELECT <col> LIMIT 1) és cache-eljük.
 */
const _colCache = new Map();
async function resolveColumn(table, candidates) {
    const key = `${table}:${candidates.join(",")}`;
    if (_colCache.has(key))
        return _colCache.get(key) ?? null;
    for (const col of candidates) {
        try {
            // injection védelem: mi adjuk a jelölteket, nem user input.
            await db_1.pool.query(`SELECT ${col} FROM ${table} LIMIT 1`);
            _colCache.set(key, col);
            return col;
        }
        catch (e) {
            // 42703 = undefined_column
            if (e?.code === "42703")
                continue;
            // más hiba (pl. table missing, permission) -> ne nyeljük le csendben
            throw e;
        }
    }
    _colCache.set(key, null);
    return null;
}
async function resolveServicesDurationColumn() {
    return resolveColumn("services", [
        "duration_min",
        "duration_minutes",
        "base_duration_minutes",
        "duration",
        "base_duration",
    ]);
}
async function resolveServicesPriceColumn() {
    return resolveColumn("services", [
        "base_price",
        "price",
        "price_huf",
        "price_hu",
    ]);
}
async function resolveServicesNameColumn(lang) {
    if (lang === "en") {
        return resolveColumn("services", ["name_en", "name"]);
    }
    if (lang === "ru") {
        return resolveColumn("services", ["name_ru", "name"]);
    }
    return resolveColumn("services", ["name_hu", "name"]);
}
async function fetchKioskServices(locationId) {
    // csak whitelistelt oszlopnév mehet be a SQL-be (injection védelem)
    const durationCol = await resolveServicesDurationColumn();
    const durationExpr = durationCol ? `COALESCE(s.${durationCol}, 0)` : `0`;
    // Megjegyzés: a /kiosk/services jelenleg a publikus szolgáltatás-listára támaszkodik.
    // Később: kiosk_menus + kiosk_menu_sections + kiosk_menu_items.
    const r = await db_1.pool.query(`SELECT
        s.id,
        s.name_hu,
        s.name_en,
        s.description_hu,
        s.description_en,
        COALESCE(s.base_price, 0) AS base_price,
        ${durationExpr} AS duration_minutes,
        COALESCE(s.category, '') AS category,
        COALESCE(s.photo_url, '') AS photo_url
      FROM services s
      WHERE ($1::uuid IS NULL OR s.location_id = $1)
      ORDER BY COALESCE(s.sort_order, 0) ASC, s.name_hu ASC`, [locationId ?? null]);
    // Csoportosítás kategóriák szerint a kiosk UI-hoz
    const byCat = {};
    for (const row of r.rows ?? []) {
        const cat = String(row.category || "").trim() || "Egyéb";
        (byCat[cat] || (byCat[cat] = [])).push(row);
    }
    return Object.entries(byCat)
        .sort(([a], [b]) => a.localeCompare(b, "hu"))
        .map(([name, items]) => ({ name, items }));
}
/**
 * KIOSK – szolgáltatások (kategória = parent szolgáltatás)
 * GET /api/kiosk/services?lang=hu&locationId=<uuid>
 *
 * Visszaad: { ok:true, categories:[{id,name,imageKey,items:[...] }]}
 */
exports.kioskRouter.get("/services", async (req, res) => {
    const { locationId, lang } = req.query;
    const language = (lang === "en" || lang === "ru") ? lang : "hu";
    // Oszlopnevek adatbázisonként eltérhetnek (local vs Render), ezért futásidőben felderítjük.
    const nameCol = await resolveServicesNameColumn(language);
    const priceCol = await resolveServicesPriceColumn();
    const nameExpr = nameCol ? `s.${nameCol}` : "''";
    const parentNameExpr = nameCol ? `p.${nameCol}` : "''";
    const priceExpr = priceCol ? `s.${priceCol}` : "NULL";
    try {
        const durationCol = await resolveServicesDurationColumn();
        const durationExpr = durationCol ? `COALESCE(s.${durationCol}::int, 0)` : "0::int";
        // Egyes adatbázisokban nincs parent_id a services táblán (pl. régi séma).
        // Ilyenkor nem kategorizálunk parent alapján, hanem a (ha létezik) `category` mező szerint csoportosítunk.
        const parentIdCol = await resolveColumn("services", ["parent_id"]);
        // Schema kompatibilitás: különböző DB-kben eltérhetnek az aktív / foglalható jelzők.
        // - active: active | is_active
        // - is_bookable: is_bookable | bookable | bookable_flag
        const activeCol = await resolveColumn("services", ["active", "is_active"]);
        const bookableCol = await resolveColumn("services", ["is_bookable", "bookable", "bookable_flag"]);
        // Ha egyik oszlop sincs, akkor ne szűrjünk rájuk (TRUE).
        const activeExpr = activeCol ? `COALESCE(s.${activeCol}, TRUE) = TRUE` : "TRUE";
        const bookableExpr = bookableCol ? `COALESCE(s.${bookableCol}, TRUE) = TRUE` : "TRUE";
        const params = [];
        let where = `${activeExpr} AND ${bookableExpr}`;
        // opcionális telephely-szűrés: service_locations táblán (ha van), különben fallback.
        // Biztonság: ha nincs ilyen tábla a DB-ben, ez a query hibát dobna – ezért TRY-CATCH-ben vagyunk.
        if (locationId) {
            params.push(locationId);
            where += ` AND EXISTS (SELECT 1 FROM service_locations sl WHERE sl.service_id = s.id AND sl.location_id = $${params.length})`;
        }
        // parent = kategória (services.parent_id). Ha nincs ilyen oszlop, akkor `category` alapján groupolunk.
        const categoryCol = await resolveColumn("services", ["category", "category_name"]);
        const categoryExpr = categoryCol ? `s.${categoryCol}::text` : `''`;
        const q = parentIdCol
            ? `
      WITH base AS (
        SELECT
          s.id,
          ${nameExpr} AS name,
          ${priceExpr} AS base_price,
          ${durationExpr} AS duration_min,
          s.${parentIdCol} AS parent_id
        FROM services s
        WHERE ${where}
      ),
      cats AS (
        SELECT
          COALESCE(p.id, 'other'::text) AS cat_id,
          COALESCE(${parentNameExpr}, 'Egyéb') AS cat_name
        FROM base b
        LEFT JOIN services p ON p.id = b.parent_id
        GROUP BY COALESCE(p.id, 'other'::text), COALESCE(${parentNameExpr}, 'Egyéb')
      )
      SELECT
        c.cat_id,
        c.cat_name,
        b.id AS service_id,
        b.name AS service_name,
        b.base_price,
        b.duration_min
      FROM cats c
      LEFT JOIN base b
        ON (b.parent_id = c.cat_id::uuid) OR (c.cat_id = 'other' AND b.parent_id IS NULL)
      ORDER BY c.cat_name, b.name;
    `
            : `
      SELECT
        COALESCE(NULLIF(TRIM(${categoryExpr}), ''), 'Egyéb') AS cat_name,
        s.id AS service_id,
        ${nameExpr} AS service_name,
        ${priceExpr} AS base_price,
        ${durationExpr} AS duration_min
      FROM services s
      WHERE ${where}
      ORDER BY cat_name, service_name;
    `;
        const { rows } = await db_1.pool.query(q, params);
        // group to categories
        const by = {};
        for (const r of rows) {
            const cid = r.cat_id ?? String(r.cat_name || "Egyéb");
            if (!by[cid]) {
                // imageKey: ugyanaz, mint a category slug (rövid név). Adminban később felülírható.
                const slug = String(r.cat_name || "egyeb")
                    .toLowerCase()
                    .replace(/[^\p{L}\p{N}]+/gu, "-")
                    .replace(/^-+|-+$/g, "");
                by[cid] = { id: cid, name: r.cat_name, imageKey: `cat_${slug}`, items: [] };
            }
            if (r.service_id) {
                const sslug = String(r.service_name || "")
                    .toLowerCase()
                    .replace(/[^\p{L}\p{N}]+/gu, "-")
                    .replace(/^-+|-+$/g, "");
                by[cid].items.push({
                    id: r.service_id,
                    name: r.service_name,
                    price: r.base_price ?? null,
                    durationMin: r.duration_min ?? null,
                    imageKey: `svc_${sslug}`,
                });
            }
        }
        res.json({ ok: true, language, categories: Object.values(by) });
    }
    catch (err) {
        console.error("Kiosk services hiba:", err);
        res.status(500).json({ ok: false, error: "kiosk_services_failed" });
    }
});
/**
 * KIOSK – menü config (később adminból jön; most fallback a /services-ből)
 * GET /api/kiosk/menu?lang=hu&locationId=<uuid>
 */
exports.kioskRouter.get("/menu", async (req, res, next) => {
    // Jelenleg ugyanazt adja vissza, mint /services – a UI erre épül.
    // Később: kiosk_menus + kiosk_menu_sections + kiosk_menu_items.
    // Express Router-nek van .handle(req,res,next) metódusa, de a TS típusdef sokszor nem exportálja.
    // Emiatt castoljuk any-re, hogy ne dobjon TS2339-et.
    return exports.kioskRouter.handle({ ...req, url: "/services" }, res, next);
});
