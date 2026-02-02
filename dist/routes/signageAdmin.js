"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = __importDefault(require("../db"));
// ⚠️ NYITOTT SIGNAGE ADMIN API: nincs admin/auth védelem (felhasználói kérésre).
// Erősen javasolt később IP korlátozás / jelszó / token / basic auth.
const router = (0, express_1.Router)();
// ---- Services (override) ----
router.get("/services", async (_req, res) => {
    try {
        const { rows } = await db_1.default.query(`
      SELECT
        s.id,
        s.name,
        st.name AS category_name,
        s.duration_min,
        s.price_from,
        COALESCE(o.enabled, true) AS enabled,
        COALESCE(o.priority, 0) AS priority,
        o.price_text_override
      FROM public.services s
      LEFT JOIN public.service_types st ON st.id = s.service_type_id
      LEFT JOIN public.signage_service_overrides o ON o.service_id = s.id
      WHERE COALESCE(s.is_active, TRUE)
      ORDER BY st.name NULLS LAST, s.name
      LIMIT 500;
    `);
        const services = rows.map((r) => ({
            id: r.id,
            name: r.name,
            category: r.category_name || "",
            durationMin: r.duration_min ?? null,
            price_text: r.price_text_override || (r.price_from != null ? `${Number(r.price_from).toLocaleString("hu-HU")} Ft` : ""),
            enabled: Boolean(r.enabled),
            priority: Number(r.priority || 0),
        }));
        res.json({ services });
    }
    catch (e) {
        res.status(500).json({ error: String(e?.message || e) });
    }
});
router.put("/services/:id/override", async (req, res) => {
    try {
        const serviceId = req.params.id;
        const { enabled, price_text_override, priority } = req.body || {};
        const { rows } = await db_1.default.query(`
      INSERT INTO public.signage_service_overrides (service_id, enabled, price_text_override, priority, updated_at)
      VALUES ($1, COALESCE($2, true), $3, COALESCE($4, 0), now())
      ON CONFLICT (service_id) DO UPDATE SET
        enabled = COALESCE(EXCLUDED.enabled, public.signage_service_overrides.enabled),
        price_text_override = EXCLUDED.price_text_override,
        priority = COALESCE(EXCLUDED.priority, public.signage_service_overrides.priority),
        updated_at = now()
      RETURNING *;
      `, [serviceId, enabled ?? null, price_text_override ?? null, priority ?? null]);
        res.json({ override: rows[0] });
    }
    catch (e) {
        res.status(500).json({ error: String(e?.message || e) });
    }
});
// ---- Deals ----
router.get("/deals", async (_req, res) => {
    const { rows } = await db_1.default.query(`SELECT * FROM public.signage_deals ORDER BY active DESC, priority DESC, updated_at DESC`);
    res.json({ deals: rows });
});
router.post("/deals", async (req, res) => {
    const { title, subtitle, price_text, valid_from, valid_to, active, priority } = req.body || {};
    if (!title)
        return res.status(400).json({ error: "title required" });
    const { rows } = await db_1.default.query(`INSERT INTO public.signage_deals (title, subtitle, price_text, valid_from, valid_to, active, priority)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [title, subtitle ?? "", price_text ?? "", valid_from ?? null, valid_to ?? null, active ?? true, priority ?? 0]);
    res.json({ deal: rows[0] });
});
router.put("/deals/:id", async (req, res) => {
    const id = req.params.id;
    const fields = ["title", "subtitle", "price_text", "valid_from", "valid_to", "active", "priority"];
    const sets = [];
    const vals = [];
    let i = 1;
    for (const f of fields) {
        if (req.body && Object.prototype.hasOwnProperty.call(req.body, f)) {
            sets.push(`${f} = $${i++}`);
            vals.push(req.body[f]);
        }
    }
    if (!sets.length)
        return res.json({ ok: true });
    vals.push(id);
    const { rows } = await db_1.default.query(`UPDATE public.signage_deals SET ${sets.join(", ")}, updated_at=now() WHERE id=$${i} RETURNING *`, vals);
    res.json({ deal: rows[0] });
});
router.delete("/deals/:id", async (req, res) => {
    const { rowCount } = await db_1.default.query(`DELETE FROM public.signage_deals WHERE id=$1`, [req.params.id]);
    res.json({ ok: (rowCount ?? 0) > 0 });
});
// ---- Quotes ----
router.get("/quotes", async (_req, res) => {
    const { rows } = await db_1.default.query(`SELECT * FROM public.signage_quotes ORDER BY active DESC, category, priority DESC, updated_at DESC`);
    res.json({ quotes: rows });
});
router.post("/quotes", async (req, res) => {
    const { category, text, author, active, priority } = req.body || {};
    if (!category || !["fitness", "beauty", "general"].includes(category))
        return res.status(400).json({ error: "category invalid" });
    if (!text)
        return res.status(400).json({ error: "text required" });
    const { rows } = await db_1.default.query(`INSERT INTO public.signage_quotes (category, text, author, active, priority)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`, [category, text, author ?? "", active ?? true, priority ?? 0]);
    res.json({ quote: rows[0] });
});
router.put("/quotes/:id", async (req, res) => {
    const id = req.params.id;
    const fields = ["category", "text", "author", "active", "priority"];
    const sets = [];
    const vals = [];
    let i = 1;
    for (const f of fields) {
        if (req.body && Object.prototype.hasOwnProperty.call(req.body, f)) {
            sets.push(`${f} = $${i++}`);
            vals.push(req.body[f]);
        }
    }
    if (!sets.length)
        return res.json({ ok: true });
    vals.push(id);
    const { rows } = await db_1.default.query(`UPDATE public.signage_quotes SET ${sets.join(", ")}, updated_at=now() WHERE id=$${i} RETURNING *`, vals);
    res.json({ quote: rows[0] });
});
router.delete("/quotes/:id", async (req, res) => {
    const { rowCount } = await db_1.default.query(`DELETE FROM public.signage_quotes WHERE id=$1`, [req.params.id]);
    res.json({ ok: (rowCount ?? 0) > 0 });
});
// ---- Professionals ----
router.get("/professionals", async (_req, res) => {
    const { rows } = await db_1.default.query(`SELECT * FROM public.signage_professionals ORDER BY available DESC, priority DESC, updated_at DESC`);
    res.json({ professionals: rows });
});
router.post("/professionals", async (req, res) => {
    const { name, title, note, photo_url, available, priority } = req.body || {};
    if (!name)
        return res.status(400).json({ error: "name required" });
    const { rows } = await db_1.default.query(`INSERT INTO public.signage_professionals (name, title, note, photo_url, available, priority)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [name, title ?? "", note ?? "", photo_url ?? "", available ?? true, priority ?? 0]);
    res.json({ professional: rows[0] });
});
router.put("/professionals/:id", async (req, res) => {
    const id = req.params.id;
    const fields = ["name", "title", "note", "photo_url", "available", "priority"];
    const sets = [];
    const vals = [];
    let i = 1;
    for (const f of fields) {
        if (req.body && Object.prototype.hasOwnProperty.call(req.body, f)) {
            sets.push(`${f} = $${i++}`);
            vals.push(req.body[f]);
        }
    }
    if (!sets.length)
        return res.json({ ok: true });
    vals.push(id);
    const { rows } = await db_1.default.query(`UPDATE public.signage_professionals SET ${sets.join(", ")}, updated_at=now() WHERE id=$${i} RETURNING *`, vals);
    res.json({ professional: rows[0] });
});
router.delete("/professionals/:id", async (req, res) => {
    const { rowCount } = await db_1.default.query(`DELETE FROM public.signage_professionals WHERE id=$1`, [req.params.id]);
    res.json({ ok: (rowCount ?? 0) > 0 });
});
exports.default = router;
