"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSignageAdminRouter = createSignageAdminRouter;
const express_1 = require("express");
const auth_1 = require("./auth");
const dealsRepo_1 = require("./dealsRepo");
const quotesRepo_1 = require("./quotesRepo");
const servicesSource_1 = require("./servicesSource");
const servicesRepo_1 = require("./servicesRepo");
const professionalsRepo_1 = require("./professionalsRepo");
function createSignageAdminRouter(pool) {
    const r = (0, express_1.Router)();
    r.use(auth_1.requireAdmin);
    // Deals
    r.get("/deals", async (_req, res) => res.json({ deals: await (0, dealsRepo_1.listDeals)(pool) }));
    r.post("/deals", async (req, res) => {
        const { title, subtitle, price_text, valid_from, valid_to, active, priority } = req.body || {};
        if (!title || typeof title !== "string")
            return res.status(400).json({ error: "title required" });
        const deal = await (0, dealsRepo_1.createDeal)(pool, { title, subtitle, price_text, valid_from, valid_to, active, priority });
        res.json({ deal });
    });
    r.put("/deals/:id", async (req, res) => {
        const deal = await (0, dealsRepo_1.updateDeal)(pool, req.params.id, req.body || {});
        if (!deal)
            return res.status(404).json({ error: "not found" });
        res.json({ deal });
    });
    r.delete("/deals/:id", async (req, res) => res.json({ ok: await (0, dealsRepo_1.deleteDeal)(pool, req.params.id) }));
    // Quotes
    r.get("/quotes", async (_req, res) => res.json({ quotes: await (0, quotesRepo_1.listAllQuotes)(pool) }));
    r.post("/quotes", async (req, res) => {
        const { category, text, author, active } = req.body || {};
        if (!category || !["fitness", "beauty", "general"].includes(category)) {
            return res.status(400).json({ error: "category must be fitness|beauty|general" });
        }
        if (!text || typeof text !== "string")
            return res.status(400).json({ error: "text required" });
        const quote = await (0, quotesRepo_1.createQuote)(pool, { category, text, author, active });
        res.json({ quote });
    });
    r.put("/quotes/:id", async (req, res) => {
        const q = await (0, quotesRepo_1.updateQuote)(pool, req.params.id, req.body || {});
        if (!q)
            return res.status(404).json({ error: "not found" });
        res.json({ quote: q });
    });
    r.delete("/quotes/:id", async (req, res) => res.json({ ok: await (0, quotesRepo_1.deleteQuote)(pool, req.params.id) }));
    // Services (DB)
    r.get("/services", async (_req, res) => {
        try {
            const data = await (0, servicesSource_1.getServices)(pool, false);
            res.json(data);
        }
        catch (e) {
            res.status(500).json({ error: String(e?.message || e) });
        }
    });
    r.put("/services/:id/override", async (req, res) => {
        try {
            const service_id = String(req.params.id);
            const { enabled, price_text_override, priority } = req.body || {};
            const saved = await (0, servicesRepo_1.upsertServiceOverride)(pool, {
                service_id,
                enabled: enabled === undefined ? undefined : Boolean(enabled),
                price_text_override: price_text_override === undefined ? null : String(price_text_override),
                priority: priority === undefined ? undefined : Number(priority),
            });
            res.json({ override: saved });
        }
        catch (e) {
            res.status(500).json({ error: String(e?.message || e) });
        }
    });
    // ---- Professionals (DB) ----
    r.get("/professionals", async (_req, res) => {
        try {
            const professionals = await (0, professionalsRepo_1.listProfessionals)(pool);
            res.json({ professionals });
        }
        catch (e) {
            res.status(500).json({ error: String(e?.message || e) });
        }
    });
    r.post("/professionals", async (req, res) => {
        try {
            const { name, title, note, photo_url, available, priority } = req.body || {};
            if (!name || typeof name !== "string")
                return res.status(400).json({ error: "name required" });
            const professional = await (0, professionalsRepo_1.createProfessional)(pool, { name, title, note, photo_url, available, priority });
            res.json({ professional });
        }
        catch (e) {
            res.status(500).json({ error: String(e?.message || e) });
        }
    });
    r.put("/professionals/:id", async (req, res) => {
        try {
            const professional = await (0, professionalsRepo_1.updateProfessional)(pool, req.params.id, req.body || {});
            if (!professional)
                return res.status(404).json({ error: "not found" });
            res.json({ professional });
        }
        catch (e) {
            res.status(500).json({ error: String(e?.message || e) });
        }
    });
    r.delete("/professionals/:id", async (req, res) => {
        try {
            const ok = await (0, professionalsRepo_1.deleteProfessional)(pool, req.params.id);
            res.json({ ok });
        }
        catch (e) {
            res.status(500).json({ error: String(e?.message || e) });
        }
    });
    return r;
}
