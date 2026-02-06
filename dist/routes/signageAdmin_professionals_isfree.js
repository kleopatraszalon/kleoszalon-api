"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = __importDefault(require("../db"));
const router = (0, express_1.Router)();
// Professionals CRUD with is_free
router.get("/professionals", async (_req, res) => {
    try {
        const { rows } = await db_1.default.query(`SELECT *, id::text AS id_text FROM public.signage_professionals ORDER BY show DESC, priority DESC, updated_at DESC`);
        res.json({ professionals: rows.map((r) => ({ ...r, id: r.id_text })) });
    }
    catch (e) {
        res.status(500).json({ error: String(e?.message || e) });
    }
});
router.post("/professionals", async (req, res) => {
    try {
        const { name, title, note, photo_url, show, is_free, priority } = req.body || {};
        if (!name)
            return res.status(400).json({ error: "name required" });
        const { rows } = await db_1.default.query(`INSERT INTO public.signage_professionals (name, title, note, photo_url, show, is_free, priority)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *, id::text AS id`, [name, title ?? "", note ?? "", photo_url ?? "", show ?? true, is_free ?? true, priority ?? 0]);
        res.json({ professional: rows[0] });
    }
    catch (e) {
        res.status(500).json({ error: String(e?.message || e) });
    }
});
router.put("/professionals/:id", async (req, res) => {
    try {
        const id = String(req.params.id);
        const fields = ["name", "title", "note", "photo_url", "show", "is_free", "priority"];
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
exports.default = router;
