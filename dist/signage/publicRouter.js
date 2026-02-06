"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSignagePublicRouter = createSignagePublicRouter;
const express_1 = require("express");
const servicesSource_1 = require("./servicesSource");
const dealsRepo_1 = require("./dealsRepo");
const professionalsRepo_1 = require("./professionalsRepo");
const quotesRepo_1 = require("./quotesRepo");
function createSignagePublicRouter(pool) {
    const r = (0, express_1.Router)();
    r.get("/services", async (_req, res) => {
        try {
            const data = await (0, servicesSource_1.getServices)(pool, true);
            res.json(data);
        }
        catch (e) {
            res.status(500).json({ error: String(e?.message || e) });
        }
    });
    r.get("/deals", async (_req, res) => {
        try {
            const deals = await (0, dealsRepo_1.listDealsForToday)(pool);
            res.json({ deals });
        }
        catch (e) {
            res.status(500).json({ error: String(e?.message || e) });
        }
    });
    r.get("/quotes", async (req, res) => {
        try {
            const category = typeof req.query.category === "string" ? req.query.category : undefined;
            const quotes = await (0, quotesRepo_1.listQuotes)(pool, category);
            res.json({ quotes });
        }
        catch (e) {
            res.status(500).json({ error: String(e?.message || e) });
        }
    });
    r.get("/daily", async (_req, res) => {
        try {
            const [fitness, beauty, general] = await Promise.all([
                (0, quotesRepo_1.listQuotes)(pool, "fitness"),
                (0, quotesRepo_1.listQuotes)(pool, "beauty"),
                (0, quotesRepo_1.listQuotes)(pool, "general"),
            ]);
            const pick = (arr, fallback) => {
                if (!arr || arr.length === 0)
                    return { text: fallback, author: "" };
                const d = new Date();
                const seed = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
                const item = arr[seed % arr.length];
                return { text: item.text, author: item.author || "" };
            };
            res.json({
                date: new Date().toISOString().slice(0, 10),
                fitness: pick(fitness, "A fegyelem akkor is dolgozik, amikor a motiváció eltűnik."),
                beauty: pick(beauty, "A konzisztens rutin többet ér, mint a ritka „csodamegoldás”."),
                general: pick(general, "A minőség a részletekben lakik: technika, higiénia, élmény."),
            });
        }
        catch (e) {
            res.status(500).json({ error: String(e?.message || e) });
        }
    });
    // Available professionals for display
    r.get("/professionals", async (_req, res) => {
        try {
            const professionals = await (0, professionalsRepo_1.listProfessionalsAvailable)(pool);
            res.json({ professionals });
        }
        catch (e) {
            res.status(500).json({ error: String(e?.message || e) });
        }
    });
    return r;
}
