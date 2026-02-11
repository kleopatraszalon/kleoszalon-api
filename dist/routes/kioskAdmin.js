"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db = __importStar(require("../db"));
const pool = (db.pool ?? db.default);
const router = (0, express_1.Router)();
function isUuid(v) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(v || ""));
}
async function ensureKioskTables() {
    await pool.query(`
    CREATE TABLE IF NOT EXISTS kiosk_menus (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      location_id uuid NULL,
      name text NOT NULL DEFAULT 'Kiosk menü',
      theme jsonb NOT NULL DEFAULT '{}'::jsonb,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS kiosk_menu_sections (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      menu_id uuid NOT NULL REFERENCES kiosk_menus(id) ON DELETE CASCADE,
      title_hu text NOT NULL,
      display_order int NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS kiosk_menu_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      section_id uuid NOT NULL REFERENCES kiosk_menu_sections(id) ON DELETE CASCADE,
      service_id uuid NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
      display_order int NOT NULL DEFAULT 0,
      enabled boolean NOT NULL DEFAULT true,
      UNIQUE(section_id, service_id)
    );
  `);
}
router.use(async (_req, _res, next) => {
    try {
        await ensureKioskTables();
        next();
    }
    catch (e) {
        console.error("ensureKioskTables hiba:", e);
        next(e);
    }
});
/**
 * GET /api/admin/kiosk/menu?locationId=...
 * Visszaadja az aktív menüt és a szerkeszthető struktúrát.
 */
router.get("/menu", async (req, res) => {
    const { locationId } = req.query;
    if (!locationId)
        return res.status(400).json({ ok: false, error: "locationId kötelező" });
    if (!isUuid(locationId))
        return res.status(400).json({ ok: false, error: "locationId nem érvényes UUID" });
    if (!isUuid(locationId))
        return res.status(400).json({ ok: false, error: "locationId nem érvényes UUID" });
    const { rows: menuRows } = await pool.query(`
    SELECT id, name, theme, is_active
    FROM kiosk_menus
    WHERE (location_id = $1 OR location_id IS NULL)
    ORDER BY (location_id IS NULL) ASC, updated_at DESC
    LIMIT 1
    `, [locationId]);
    const menu = menuRows?.[0] || null;
    const { rows: services } = await pool.query(`
    SELECT s.id, COALESCE(s.name_hu, s.name) AS name, s.base_price, s.duration_minutes,
           st.id AS service_type_id, COALESCE(st.name_hu, st.name, 'Egyéb') AS service_type_name
    FROM services s
    LEFT JOIN service_types st ON st.id = s.service_type_id
    WHERE s.is_active = true AND (s.location_id = $1 OR s.location_id IS NULL)
    ORDER BY st.display_order NULLS LAST, s.display_order NULLS LAST, name
    `, [locationId]);
    let sections = [];
    if (menu?.id) {
        const { rows } = await pool.query(`
      SELECT sec.id AS section_id, sec.title_hu, sec.display_order,
             mi.service_id, mi.enabled, mi.display_order AS item_order
      FROM kiosk_menu_sections sec
      LEFT JOIN kiosk_menu_items mi ON mi.section_id = sec.id
      WHERE sec.menu_id = $1
      ORDER BY sec.display_order ASC, mi.display_order ASC
      `, [menu.id]);
        const by = new Map();
        for (const r of rows) {
            if (!by.has(r.section_id)) {
                const sec = { id: r.section_id, title: r.title_hu, order: r.display_order, items: [] };
                by.set(r.section_id, sec);
                sections.push(sec);
            }
            if (r.service_id) {
                by.get(r.section_id).items.push({ serviceId: r.service_id, enabled: r.enabled, order: r.item_order });
            }
        }
    }
    return res.json({ ok: true, menu, sections, services });
});
/**
 * POST /api/admin/kiosk/menu/init
 * Létrehoz egy default menüt a locationId-hoz, service_types alapján szekciókkal.
 */
router.post("/menu/init", async (req, res) => {
    const { locationId, name } = req.body;
    if (!locationId)
        return res.status(400).json({ ok: false, error: "locationId kötelező" });
    if (!isUuid(locationId))
        return res.status(400).json({ ok: false, error: "locationId nem érvényes UUID" });
    if (!isUuid(locationId))
        return res.status(400).json({ ok: false, error: "locationId nem érvényes UUID" });
    await pool.query("BEGIN");
    try {
        const { rows: mRows } = await pool.query(`
      INSERT INTO kiosk_menus(location_id, name, theme, is_active)
      VALUES ($1, $2, '{}'::jsonb, true)
      RETURNING id
      `, [locationId, name || "Kiosk menü"]);
        const menuId = mRows[0].id;
        const { rows: types } = await pool.query(`
      SELECT id, COALESCE(name_hu, name, 'Egyéb') AS title, COALESCE(display_order, 0) AS ord
      FROM service_types
      ORDER BY COALESCE(display_order, 0) ASC
      `);
        // create one section per type
        const typeToSection = new Map();
        let idx = 0;
        for (const t of types) {
            const { rows: sRows } = await pool.query(`INSERT INTO kiosk_menu_sections(menu_id, title_hu, display_order) VALUES ($1,$2,$3) RETURNING id`, [menuId, t.title, idx++]);
            typeToSection.set(t.id, sRows[0].id);
        }
        // 'Egyéb' fallback
        const { rows: otherRows } = await pool.query(`INSERT INTO kiosk_menu_sections(menu_id, title_hu, display_order) VALUES ($1,$2,$3) RETURNING id`, [menuId, "Egyéb", idx++]);
        const otherId = otherRows[0].id;
        const { rows: services } = await pool.query(`
      SELECT id, service_type_id
      FROM services
      WHERE is_active = true AND (location_id = $1 OR location_id IS NULL)
      `, [locationId]);
        let order = 0;
        for (const s of services) {
            const secId = (s.service_type_id && typeToSection.get(s.service_type_id)) || otherId;
            await pool.query(`INSERT INTO kiosk_menu_items(section_id, service_id, display_order, enabled) VALUES ($1,$2,$3,true)
         ON CONFLICT(section_id, service_id) DO UPDATE SET enabled=true, display_order=EXCLUDED.display_order`, [secId, s.id, order++]);
        }
        await pool.query("COMMIT");
        return res.status(201).json({ ok: true, menuId });
    }
    catch (e) {
        await pool.query("ROLLBACK");
        console.error("kiosk init hiba:", e);
        return res.status(500).json({ ok: false, error: "init_failed" });
    }
});
/**
 * PUT /api/admin/kiosk/menu/:menuId/theme
 * theme: json (pl. primaryColor, logoUrl, welcomeText, etc.)
 */
router.put("/menu/:menuId/theme", async (req, res) => {
    const { menuId } = req.params;
    const theme = req.body?.theme ?? {};
    await pool.query(`UPDATE kiosk_menus SET theme=$2::jsonb, updated_at=now() WHERE id=$1`, [menuId, JSON.stringify(theme)]);
    res.json({ ok: true });
});
/**
 * PUT /api/admin/kiosk/menu/:menuId/items
 * Bulk enable/disable: { sectionId, items: [{serviceId, enabled, order}] }[]
 */
router.put("/menu/:menuId/items", async (req, res) => {
    const { menuId } = req.params;
    const sections = (req.body?.sections ?? []);
    await pool.query("BEGIN");
    try {
        // verify menu exists
        const { rowCount } = await pool.query(`SELECT 1 FROM kiosk_menus WHERE id=$1`, [menuId]);
        if (!rowCount) {
            await pool.query("ROLLBACK");
            return res.status(404).json({ ok: false, error: "menu_not_found" });
        }
        for (const sec of sections) {
            const sectionId = sec.sectionId;
            const items = Array.isArray(sec.items) ? sec.items : [];
            for (const it of items) {
                await pool.query(`
          INSERT INTO kiosk_menu_items(section_id, service_id, display_order, enabled)
          VALUES ($1,$2,$3,$4)
          ON CONFLICT(section_id, service_id)
          DO UPDATE SET display_order=EXCLUDED.display_order, enabled=EXCLUDED.enabled
          `, [sectionId, it.serviceId, Number(it.order ?? 0), Boolean(it.enabled)]);
            }
        }
        await pool.query(`UPDATE kiosk_menus SET updated_at=now() WHERE id=$1`, [menuId]);
        await pool.query("COMMIT");
        res.json({ ok: true });
    }
    catch (e) {
        await pool.query("ROLLBACK");
        console.error("kiosk items save hiba:", e);
        res.status(500).json({ ok: false, error: "save_failed" });
    }
});
exports.default = router;
