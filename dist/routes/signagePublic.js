"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = __importDefault(require("../db"));
const router = (0, express_1.Router)();
router.get("/services", async (_req, res) => {
    try {
        const { rows } = await db_1.default.query(`
      SELECT id::text AS id, name, category, duration_min, price_text, priority
      FROM public.signage_services
      WHERE show = true
      ORDER BY priority DESC, updated_at DESC
      LIMIT 500;
    `);
        res.json({
            source: "db:public.signage_services",
            fetchedAt: new Date().toISOString(),
            services: rows.map((r) => ({
                id: r.id,
                name: r.name,
                category: r.category || "",
                durationMin: r.duration_min ?? null,
                price_text: r.price_text || "",
                priority: Number(r.priority || 0),
            })),
        });
    }
    catch (e) {
        res.status(500).json({ error: String(e?.message || e) });
    }
});
router.get("/deals", async (_req, res) => {
    try {
        const { rows } = await db_1.default.query(`
      SELECT *, id::text AS id
      FROM public.signage_deals
      WHERE active = true
        AND (valid_from IS NULL OR valid_from <= CURRENT_DATE)
        AND (valid_to IS NULL OR valid_to >= CURRENT_DATE)
      ORDER BY priority DESC, updated_at DESC
      LIMIT 50;
    `);
        res.json({ deals: rows });
    }
    catch (e) {
        res.status(500).json({ error: String(e?.message || e) });
    }
});
router.get("/professionals", async (_req, res) => {
    try {
        const { rows } = await db_1.default.query(`
      SELECT *, id::text AS id
      FROM public.signage_professionals
      WHERE show = true AND available = true
      ORDER BY priority DESC, updated_at DESC
      LIMIT 30;
    `);
        res.json({ professionals: rows });
    }
    catch (e) {
        res.status(500).json({ error: String(e?.message || e) });
    }
});
router.get("/videos", async (_req, res) => {
    try {
        const { rows } = await db_1.default.query(`
      SELECT id::text AS id, youtube_id, title, duration_sec, priority
      FROM public.signage_videos
      WHERE enabled = true
      ORDER BY priority DESC, updated_at DESC
      LIMIT 50;
    `);
        res.json({ videos: rows });
    }
    catch (e) {
        res.status(500).json({ error: String(e?.message || e) });
    }
});
router.get("/daily", async (_req, res) => {
    try {
        const { rows } = await db_1.default.query(`
      SELECT category, text, author, priority
      FROM public.signage_quotes
      WHERE active = true
      ORDER BY priority DESC, updated_at DESC
      LIMIT 200;
    `);
        const byCat = { fitness: [], beauty: [], general: [] };
        for (const r of rows)
            if (byCat[r.category])
                byCat[r.category].push(r);
        const pick = (arr, fallback) => {
            if (!arr.length)
                return { text: fallback, author: "" };
            const d = new Date();
            const seed = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
            const item = arr[seed % arr.length];
            return { text: item.text, author: item.author || "" };
        };
        res.json({
            date: new Date().toISOString().slice(0, 10),
            fitness: pick(byCat.fitness, "A fegyelem akkor is dolgozik, amikor a motiváció eltűnik."),
            beauty: pick(byCat.beauty, "A konzisztens rutin többet ér, mint a ritka csodamegoldás."),
            general: pick(byCat.general, "A minőség a részletekben lakik: technika, higiénia, élmény."),
        });
    }
    catch (e) {
        res.status(500).json({ error: String(e?.message || e) });
    }
});
exports.default = router;
