"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = require("../db");
// Public list for signage professionals.
// NOTE: Only `show=true` rows are returned, but `is_free` can be true/false.
const router = (0, express_1.Router)();
router.get("/professionals", async (_req, res) => {
    try {
        const { rows } = await db_1.pool.query(`
      SELECT id, name, title, note,
             priority,
             is_free
      FROM signage_professionals
      WHERE show = true
      ORDER BY priority DESC, is_free DESC, updated_at DESC
      `);
        const professionals = rows.map((r) => ({
            id: r.id,
            name: r.name,
            title: r.title,
            note: r.note,
            priority: Number(r.priority ?? 0),
            is_free: !!r.is_free,
            // legacy alias
            available: !!r.is_free,
        }));
        res.json({ professionals });
    }
    catch (e) {
        res.status(500).json({ error: e?.message ?? "Failed to list professionals" });
    }
});
exports.default = router;
