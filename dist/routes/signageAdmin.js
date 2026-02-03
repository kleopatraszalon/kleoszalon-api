"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = require("../db");
// Admin CRUD for signage professionals.
// Supports both the new field names (show, is_free) and legacy aliases (enabled/available)
// so older frontends keep working.
const router = (0, express_1.Router)();
function pickBool(v) {
    if (v === undefined || v === null)
        return undefined;
    if (typeof v === "boolean")
        return v;
    if (typeof v === "number")
        return v !== 0;
    if (typeof v === "string") {
        const s = v.trim().toLowerCase();
        if (["true", "1", "yes", "y", "on"].includes(s))
            return true;
        if (["false", "0", "no", "n", "off"].includes(s))
            return false;
    }
    return undefined;
}
function pickInt(v) {
    if (v === undefined || v === null || v === "")
        return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : undefined;
}
router.get("/", async (_req, res) => {
    try {
        const { rows } = await db_1.pool.query(`
      SELECT id, name, title, note,
             show,
             is_free,
             priority,
             created_at, updated_at
      FROM signage_professionals
      ORDER BY priority DESC, updated_at DESC
      `);
        // Return also legacy alias keys for clients that still expect them.
        const professionals = rows.map((r) => ({
            id: r.id,
            name: r.name,
            title: r.title,
            note: r.note,
            show: !!r.show,
            is_free: !!r.is_free,
            priority: Number(r.priority ?? 0),
            // legacy aliases:
            enabled: !!r.show,
            available: !!r.is_free,
            created_at: r.created_at,
            updated_at: r.updated_at,
        }));
        res.json({ professionals });
    }
    catch (e) {
        res.status(500).json({ error: e?.message ?? "Failed to list professionals" });
    }
});
router.post("/", async (req, res) => {
    try {
        const name = String(req.body?.name ?? "").trim();
        if (!name)
            return res.status(400).json({ error: "name required" });
        const title = String(req.body?.title ?? "").trim();
        const note = String(req.body?.note ?? "").trim();
        const show = pickBool(req.body?.show) ??
            pickBool(req.body?.enabled) ??
            pickBool(req.body?.display) ??
            true;
        const is_free = pickBool(req.body?.is_free) ??
            pickBool(req.body?.isFree) ??
            pickBool(req.body?.available) ??
            true;
        const priority = pickInt(req.body?.priority) ?? 0;
        const { rows } = await db_1.pool.query(`
      INSERT INTO signage_professionals (name, title, note, show, is_free, priority)
      VALUES ($1, NULLIF($2,''), NULLIF($3,''), $4, $5, $6)
      RETURNING id, name, title, note, show, is_free, priority, created_at, updated_at
      `, [name, title, note, show, is_free, priority]);
        const r = rows[0];
        res.json({
            professional: {
                id: r.id,
                name: r.name,
                title: r.title,
                note: r.note,
                show: !!r.show,
                is_free: !!r.is_free,
                priority: Number(r.priority ?? 0),
                enabled: !!r.show,
                available: !!r.is_free,
                created_at: r.created_at,
                updated_at: r.updated_at,
            },
        });
    }
    catch (e) {
        res.status(500).json({ error: e?.message ?? "Failed to create professional" });
    }
});
router.put("/:id", async (req, res) => {
    try {
        const id = req.params.id;
        const name = req.body?.name !== undefined ? String(req.body.name).trim() : undefined;
        const title = req.body?.title !== undefined ? String(req.body.title).trim() : undefined;
        const note = req.body?.note !== undefined ? String(req.body.note).trim() : undefined;
        const show = pickBool(req.body?.show) ??
            pickBool(req.body?.enabled) ??
            pickBool(req.body?.display);
        const is_free = pickBool(req.body?.is_free) ??
            pickBool(req.body?.isFree) ??
            pickBool(req.body?.available);
        const priority = pickInt(req.body?.priority);
        const { rows } = await db_1.pool.query(`
      UPDATE signage_professionals
      SET
        name = COALESCE($2, name),
        title = COALESCE(NULLIF($3,''), title),
        note = COALESCE(NULLIF($4,''), note),
        show = COALESCE($5, show),
        is_free = COALESCE($6, is_free),
        priority = COALESCE($7, priority),
        updated_at = NOW()
      WHERE id = $1
      RETURNING id, name, title, note, show, is_free, priority, created_at, updated_at
      `, [id, name, title, note, show, is_free, priority]);
        if (!rows[0])
            return res.status(404).json({ error: "not found" });
        const r = rows[0];
        res.json({
            professional: {
                id: r.id,
                name: r.name,
                title: r.title,
                note: r.note,
                show: !!r.show,
                is_free: !!r.is_free,
                priority: Number(r.priority ?? 0),
                enabled: !!r.show,
                available: !!r.is_free,
                created_at: r.created_at,
                updated_at: r.updated_at,
            },
        });
    }
    catch (e) {
        res.status(500).json({ error: e?.message ?? "Failed to update professional" });
    }
});
router.delete("/:id", async (req, res) => {
    try {
        const id = req.params.id;
        const { rowCount } = await db_1.pool.query("DELETE FROM signage_professionals WHERE id = $1", [id]);
        res.json({ ok: (rowCount ?? 0) > 0 });
    }
    catch (e) {
        res.status(500).json({ error: e?.message ?? "Failed to delete professional" });
    }
});
exports.default = router;
