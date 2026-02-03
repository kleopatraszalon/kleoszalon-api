"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = __importDefault(require("../db"));
// ⚠️ NYITOTT SIGNAGE ADMIN API (kérésre): nincs auth/admin védelem.
const router = (0, express_1.Router)();
// SERVICES
router.get("/services", async (_req, res) => {
    try {
        const { rows } = await db_1.default.query(`SELECT *, id::text AS id_text FROM public.signage_services ORDER BY show DESC, priority DESC, updated_at DESC`);
        res.json({ services: rows.map((r) => ({ ...r, id: r.id_text })) });
    }
    catch (e) {
        res.status(500).json({ error: String(e?.message || e) });
    }
});
router.post("/services", async (req, res) => {
    try {
        const { name, category, duration_min, price_text, show, priority } = req.body || {};
        if (!name)
            return res.status(400).json({ error: "name required" });
        const { rows } = await db_1.default.query(`INSERT INTO public.signage_services (name, category, duration_min, price_text, show, priority)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *, id::text AS id`, [name, category ?? "", duration_min ?? null, price_text ?? "", show ?? true, priority ?? 0]);
        res.json({ service: rows[0] });
    }
    catch (e) {
        res.status(500).json({ error: String(e?.message || e) });
    }
});
router.put("/services/:id", async (req, res) => {
    try {
        const id = String(req.params.id);
        const fields = ["name", "category", "duration_min", "price_text", "show", "priority"];
        const sets = [];
        const vals = [];
        let i = 1;
        for (const f of fields)
            if (req.body && Object.prototype.hasOwnProperty.call(req.body, f)) {
                sets.push(`${f}=$${i++}`);
                vals.push(req.body[f]);
            }
        if (!sets.length)
            return res.json({ ok: true });
        vals.push(id);
        const { rows } = await db_1.default.query(`UPDATE public.signage_services SET ${sets.join(", ")}, updated_at=now()
       WHERE id::text = $${i}
       RETURNING *, id::text AS id`, vals);
        if (!rows[0])
            return res.status(404).json({ error: "not found" });
        res.json({ service: rows[0] });
    }
    catch (e) {
        res.status(500).json({ error: String(e?.message || e) });
    }
});
router.delete("/services/:id", async (req, res) => {
    try {
        const { rowCount } = await db_1.default.query(`DELETE FROM public.signage_services WHERE id::text = $1`, [String(req.params.id)]);
        res.json({ ok: (rowCount ?? 0) > 0 });
    }
    catch (e) {
        res.status(500).json({ error: String(e?.message || e) });
    }
});
// DEALS
router.get("/deals", async (_req, res) => {
    try {
        const { rows } = await db_1.default.query(`SELECT *, id::text AS id_text FROM public.signage_deals ORDER BY active DESC, priority DESC, updated_at DESC`);
        res.json({ deals: rows.map((r) => ({ ...r, id: r.id_text })) });
    }
    catch (e) {
        res.status(500).json({ error: String(e?.message || e) });
    }
});
router.post("/deals", async (req, res) => {
    try {
        const { title, subtitle, price_text, valid_from, valid_to, active, priority } = req.body || {};
        if (!title)
            return res.status(400).json({ error: "title required" });
        const { rows } = await db_1.default.query(`INSERT INTO public.signage_deals (title, subtitle, price_text, valid_from, valid_to, active, priority)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *, id::text AS id`, [title, subtitle ?? "", price_text ?? "", valid_from ?? null, valid_to ?? null, active ?? true, priority ?? 0]);
        res.json({ deal: rows[0] });
    }
    catch (e) {
        res.status(500).json({ error: String(e?.message || e) });
    }
});
router.put("/deals/:id", async (req, res) => {
    try {
        const id = String(req.params.id);
        const fields = ["title", "subtitle", "price_text", "valid_from", "valid_to", "active", "priority"];
        const sets = [];
        const vals = [];
        let i = 1;
        for (const f of fields)
            if (req.body && Object.prototype.hasOwnProperty.call(req.body, f)) {
                sets.push(`${f}=$${i++}`);
                vals.push(req.body[f]);
            }
        if (!sets.length)
            return res.json({ ok: true });
        vals.push(id);
        const { rows } = await db_1.default.query(`UPDATE public.signage_deals SET ${sets.join(", ")}, updated_at=now() WHERE id::text=$${i} RETURNING *, id::text AS id`, vals);
        if (!rows[0])
            return res.status(404).json({ error: "not found" });
        res.json({ deal: rows[0] });
    }
    catch (e) {
        res.status(500).json({ error: String(e?.message || e) });
    }
});
router.delete("/deals/:id", async (req, res) => {
    try {
        const { rowCount } = await db_1.default.query(`DELETE FROM public.signage_deals WHERE id::text=$1`, [String(req.params.id)]);
        res.json({ ok: (rowCount ?? 0) > 0 });
    }
    catch (e) {
        res.status(500).json({ error: String(e?.message || e) });
    }
});
// PROFESSIONALS
router.get("/professionals", async (_req, res) => {
    try {
        const { rows } = await db_1.default.query(`SELECT *, id::text AS id_text FROM public.signage_professionals ORDER BY show DESC, available DESC, priority DESC, updated_at DESC`);
        res.json({ professionals: rows.map((r) => ({ ...r, id: r.id_text })) });
    }
    catch (e) {
        res.status(500).json({ error: String(e?.message || e) });
    }
});
router.post("/professionals", async (req, res) => {
    try {
        const { name, title, note, photo_url, show, available, priority } = req.body || {};
        if (!name)
            return res.status(400).json({ error: "name required" });
        const { rows } = await db_1.default.query(`INSERT INTO public.signage_professionals (name, title, note, photo_url, show, available, priority)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *, id::text AS id`, [name, title ?? "", note ?? "", photo_url ?? "", show ?? true, available ?? true, priority ?? 0]);
        res.json({ professional: rows[0] });
    }
    catch (e) {
        res.status(500).json({ error: String(e?.message || e) });
    }
});
router.put("/professionals/:id", async (req, res) => {
    try {
        const id = String(req.params.id);
        const fields = ["name", "title", "note", "photo_url", "show", "available", "priority"];
        const sets = [];
        const vals = [];
        let i = 1;
        for (const f of fields)
            if (req.body && Object.prototype.hasOwnProperty.call(req.body, f)) {
                sets.push(`${f}=$${i++}`);
                vals.push(req.body[f]);
            }
        if (!sets.length)
            return res.json({ ok: true });
        vals.push(id);
        const { rows } = await db_1.default.query(`UPDATE public.signage_professionals SET ${sets.join(", ")}, updated_at=now() WHERE id::text=$${i} RETURNING *, id::text AS id`, vals);
        if (!rows[0])
            return res.status(404).json({ error: "not found" });
        res.json({ professional: rows[0] });
    }
    catch (e) {
        res.status(500).json({ error: String(e?.message || e) });
    }
});
router.delete("/professionals/:id", async (req, res) => {
    try {
        const { rowCount } = await db_1.default.query(`DELETE FROM public.signage_professionals WHERE id::text=$1`, [String(req.params.id)]);
        res.json({ ok: (rowCount ?? 0) > 0 });
    }
    catch (e) {
        res.status(500).json({ error: String(e?.message || e) });
    }
});
// QUOTES
router.get("/quotes", async (_req, res) => {
    try {
        const { rows } = await db_1.default.query(`SELECT *, id::text AS id_text FROM public.signage_quotes ORDER BY active DESC, category, priority DESC, updated_at DESC`);
        res.json({ quotes: rows.map((r) => ({ ...r, id: r.id_text })) });
    }
    catch (e) {
        res.status(500).json({ error: String(e?.message || e) });
    }
});
router.post("/quotes", async (req, res) => {
    try {
        const { category, text, author, active, priority } = req.body || {};
        if (!category || !["fitness", "beauty", "general"].includes(category))
            return res.status(400).json({ error: "category invalid" });
        if (!text)
            return res.status(400).json({ error: "text required" });
        const { rows } = await db_1.default.query(`INSERT INTO public.signage_quotes (category, text, author, active, priority)
       VALUES ($1,$2,$3,$4,$5) RETURNING *, id::text AS id`, [category, text, author ?? "", active ?? true, priority ?? 0]);
        res.json({ quote: rows[0] });
    }
    catch (e) {
        res.status(500).json({ error: String(e?.message || e) });
    }
});
router.put("/quotes/:id", async (req, res) => {
    try {
        const id = String(req.params.id);
        const fields = ["category", "text", "author", "active", "priority"];
        const sets = [];
        const vals = [];
        let i = 1;
        for (const f of fields)
            if (req.body && Object.prototype.hasOwnProperty.call(req.body, f)) {
                sets.push(`${f}=$${i++}`);
                vals.push(req.body[f]);
            }
        if (!sets.length)
            return res.json({ ok: true });
        vals.push(id);
        const { rows } = await db_1.default.query(`UPDATE public.signage_quotes SET ${sets.join(", ")}, updated_at=now() WHERE id::text=$${i} RETURNING *, id::text AS id`, vals);
        if (!rows[0])
            return res.status(404).json({ error: "not found" });
        res.json({ quote: rows[0] });
    }
    catch (e) {
        res.status(500).json({ error: String(e?.message || e) });
    }
});
router.delete("/quotes/:id", async (req, res) => {
    try {
        const { rowCount } = await db_1.default.query(`DELETE FROM public.signage_quotes WHERE id::text=$1`, [String(req.params.id)]);
        res.json({ ok: (rowCount ?? 0) > 0 });
    }
    catch (e) {
        res.status(500).json({ error: String(e?.message || e) });
    }
});
// VIDEOS
router.get("/videos", async (_req, res) => {
    try {
        const { rows } = await db_1.default.query(`SELECT *, id::text AS id_text FROM public.signage_videos ORDER BY enabled DESC, priority DESC, updated_at DESC`);
        res.json({ videos: rows.map((r) => ({ ...r, id: r.id_text })) });
    }
    catch (e) {
        res.status(500).json({ error: String(e?.message || e) });
    }
});
router.post("/videos", async (req, res) => {
    try {
        const { youtube_id, title, enabled, priority, duration_sec } = req.body || {};
        if (!youtube_id)
            return res.status(400).json({ error: "youtube_id required" });
        const { rows } = await db_1.default.query(`INSERT INTO public.signage_videos (youtube_id, title, enabled, priority, duration_sec)
       VALUES ($1,$2,$3,$4,$5) RETURNING *, id::text AS id`, [youtube_id, title ?? "", enabled ?? true, priority ?? 0, duration_sec ?? 60]);
        res.json({ video: rows[0] });
    }
    catch (e) {
        res.status(500).json({ error: String(e?.message || e) });
    }
});
router.put("/videos/:id", async (req, res) => {
    try {
        const id = String(req.params.id);
        const fields = ["youtube_id", "title", "enabled", "priority", "duration_sec"];
        const sets = [];
        const vals = [];
        let i = 1;
        for (const f of fields)
            if (req.body && Object.prototype.hasOwnProperty.call(req.body, f)) {
                sets.push(`${f}=$${i++}`);
                vals.push(req.body[f]);
            }
        if (!sets.length)
            return res.json({ ok: true });
        vals.push(id);
        const { rows } = await db_1.default.query(`UPDATE public.signage_videos SET ${sets.join(", ")}, updated_at=now() WHERE id::text=$${i} RETURNING *, id::text AS id`, vals);
        if (!rows[0])
            return res.status(404).json({ error: "not found" });
        res.json({ video: rows[0] });
    }
    catch (e) {
        res.status(500).json({ error: String(e?.message || e) });
    }
});
router.delete("/videos/:id", async (req, res) => {
    try {
        const { rowCount } = await db_1.default.query(`DELETE FROM public.signage_videos WHERE id::text=$1`, [String(req.params.id)]);
        res.json({ ok: (rowCount ?? 0) > 0 });
    }
    catch (e) {
        res.status(500).json({ error: String(e?.message || e) });
    }
});
exports.default = router;
