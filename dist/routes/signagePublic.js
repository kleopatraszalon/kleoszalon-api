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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = __importDefault(require("../db"));
const https = __importStar(require("https"));
/**
 * Public Signage API (NO AUTH)
 *
 * Mounted under: /api/signage
 *
 * Endpoints used by SignagePage.tsx:
 *  - GET /services        -> { services: ServiceItem[], fetchedAt }
 *  - GET /deals           -> { deals: Deal[] }
 *  - GET /videos          -> { videos: VideoItem[] }
 *  - GET /daily           -> { fitness: Quote|null, beauty: Quote|null }
 *  - GET /professionals   -> { professionals: Professional[] }
 *
 * IMPORTANT:
 *  - Do NOT require cookie/JWT here (display page must work without login)
 *  - Always return JSON
 */
const router = (0, express_1.Router)();
// -----------------------------
// Helpers
// -----------------------------
const nowIso = () => new Date().toISOString();
function safeText(v) {
    return typeof v === "string" ? v : v == null ? "" : String(v);
}
function safeNum(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}
// -----------------------------
// Villám akció + névnap helper (public)
// -----------------------------
const DEFAULT_NAMEDAY_TEMPLATE = "Ma a {names} nevű vendégeink 20% kedvezményben részesülnek!!!";
function ymdBudapest(d = new Date()) {
    // YYYY-MM-DD, Budapest időzóna szerint
    return d.toLocaleDateString("en-CA", { timeZone: "Europe/Budapest" });
}
function httpsGet(url) {
    return new Promise((resolve, reject) => {
        try {
            https
                .get(url, { headers: { "User-Agent": "kleoszalon-signage/1.0", Accept: "application/json" } }, (r) => {
                let data = "";
                r.on("data", (c) => (data += c));
                r.on("end", () => {
                    const code = Number(r.statusCode || 0);
                    if (code >= 400)
                        return reject(new Error(`HTTP ${code}`));
                    resolve(data);
                });
            })
                .on("error", reject);
        }
        catch (e) {
            reject(e);
        }
    });
}
let namedayCache = null;
function splitNames(raw) {
    return String(raw || "")
        .split(/[,;\/]+/)
        .map((s) => s.trim())
        .filter(Boolean);
}
async function fetchNamedayNamesHu() {
    const today = ymdBudapest();
    // 6 órás cache (bőven elég)
    if (namedayCache && namedayCache.ymd === today && Date.now() - namedayCache.fetchedAt < 6 * 60 * 60 * 1000) {
        return namedayCache.names;
    }
    const url = "https://nameday.abalin.net/api/V1/today?country=hu&timezone=Europe/Budapest";
    const txt = await httpsGet(url);
    let j = null;
    try {
        j = JSON.parse(txt);
    }
    catch {
        j = null;
    }
    // Abalin válaszok többféle formában jöhetnek -> próbáljunk robusztusak lenni
    const raw = j?.data?.namedays?.hu ??
        j?.data?.namedays?.HU ??
        j?.namedays?.hu ??
        j?.nameday?.hu ??
        j?.data?.name ??
        "";
    const names = splitNames(String(raw)).slice(0, 20);
    namedayCache = { ymd: today, names, fetchedAt: Date.now() };
    return names;
}
async function getSettingValue(key) {
    try {
        const r = await db_1.default.query(`SELECT value FROM public.signage_settings WHERE key = $1 LIMIT 1`, [key]);
        const v = r.rows?.[0]?.value;
        return v == null ? null : String(v);
    }
    catch {
        return null;
    }
}
// -----------------------------
// Services (public)
// -----------------------------
router.get("/services", async (_req, res) => {
    try {
        const { rows } = await db_1.default.query(`
      SELECT
        s.id::text AS id,
        s.name,
        COALESCE(s.category, '') AS category,
        s.duration_min,
        COALESCE(s.price_text, '') AS price_text,
        COALESCE(s.priority, 0) AS priority
      FROM public.signage_services s
      LEFT JOIN public.signage_service_overrides o
        ON o.service_id = s.id
      WHERE COALESCE(s.show, true) = true
        AND COALESCE(o.enabled, true) = true
      ORDER BY COALESCE(s.priority, 0) DESC, s.updated_at DESC
      LIMIT 200;
      `);
        const services = rows.map((r) => ({
            id: safeText(r.id),
            name: safeText(r.name),
            category: safeText(r.category),
            durationMin: r.duration_min == null ? null : safeNum(r.duration_min, null),
            price_text: safeText(r.price_text),
            priority: safeNum(r.priority, 0),
        }));
        res.json({ services, fetchedAt: nowIso() });
    }
    catch (e) {
        res.status(500).json({ error: safeText(e?.message || e) });
    }
});
// -----------------------------
// Deals (public)
// -----------------------------
router.get("/deals", async (_req, res) => {
    try {
        const { rows } = await db_1.default.query(`
      SELECT
        id::text AS id,
        title,
        COALESCE(subtitle, '') AS subtitle,
        COALESCE(price_text, '') AS price_text,
        valid_from,
        valid_to,
        active,
        COALESCE(priority, 0) AS priority
      FROM public.signage_deals
      WHERE COALESCE(active, true) = true
        AND (valid_from IS NULL OR valid_from <= CURRENT_DATE)
        AND (valid_to IS NULL OR valid_to >= CURRENT_DATE)
      ORDER BY COALESCE(priority, 0) DESC, updated_at DESC
      LIMIT 20;
      `);
        res.json({ deals: rows });
    }
    catch (e) {
        res.status(500).json({ error: safeText(e?.message || e) });
    }
});
// -----------------------------
// Videos (public)
// -----------------------------
router.get("/videos", async (_req, res) => {
    try {
        const { rows } = await db_1.default.query(`
      SELECT
        id::text AS id,
        youtube_id,
        COALESCE(title, '') AS title,
        COALESCE(duration_sec, 60) AS duration_sec,
        COALESCE(priority, 0) AS priority
      FROM public.signage_videos
      WHERE COALESCE(enabled, true) = true
      ORDER BY COALESCE(priority, 0) DESC, updated_at DESC
      LIMIT 50;
      `);
        res.json({ videos: rows });
    }
    catch (e) {
        res.status(500).json({ error: safeText(e?.message || e) });
    }
});
// -----------------------------
// Daily (ticker quotes) (public)
// -----------------------------
router.get("/daily", async (_req, res) => {
    try {
        const { rows } = await db_1.default.query(`
      SELECT
        id::text AS id,
        category,
        text,
        COALESCE(author, '') AS author,
        COALESCE(priority, 0) AS priority
      FROM public.signage_quotes
      WHERE COALESCE(enabled, true) = true
        AND category IN ('fitness', 'beauty')
      ORDER BY category, COALESCE(priority, 0) DESC, updated_at DESC;
      `);
        const pick = (cat) => rows.find((r) => r.category === cat) || null;
        res.json({
            fitness: pick("fitness"),
            beauty: pick("beauty"),
            fetchedAt: nowIso(),
        });
    }
    catch (e) {
        res.status(500).json({ error: safeText(e?.message || e) });
    }
});
// -----------------------------
// Professionals (public)
// -----------------------------
router.get("/professionals", async (_req, res) => {
    try {
        const { rows } = await db_1.default.query(`
      SELECT
        id::text AS id,
        name,
        COALESCE(title, '') AS title,
        COALESCE(note, '') AS note,
        NULLIF(BTRIM(COALESCE(photo_url, '')), '') AS photo_url,
        COALESCE(priority, 0) AS priority,
        COALESCE(is_free, true) AS is_free
      FROM public.signage_professionals
      WHERE COALESCE(show, true) = true
      ORDER BY COALESCE(priority, 0) DESC, COALESCE(is_free, true) DESC, updated_at DESC
      LIMIT 30;
      `);
        const professionals = rows.map((r) => ({
            id: safeText(r.id),
            name: safeText(r.name),
            title: safeText(r.title),
            note: safeText(r.note),
            photo_url: r.photo_url ? safeText(r.photo_url) : null,
            priority: safeNum(r.priority, 0),
            is_free: !!r.is_free,
            available: !!r.is_free, // legacy alias for older UIs
        }));
        res.json({ professionals });
    }
    catch (e) {
        res.status(500).json({ error: safeText(e?.message || e) });
    }
});
// -----------------------------
// Villám akció (public)
// -----------------------------
router.get("/flash", async (_req, res) => {
    try {
        const { rows } = await db_1.default.query(`
      SELECT
        id::text AS id,
        title,
        COALESCE(body, '') AS body,
        start_at,
        end_at,
        COALESCE(priority, 0) AS priority
      FROM public.signage_flash_promos
      WHERE COALESCE(enabled, true) = true
        AND (start_at IS NULL OR start_at <= now())
        AND (end_at IS NULL OR end_at >= now())
      ORDER BY COALESCE(priority, 0) DESC, updated_at DESC
      LIMIT 1;
      `);
        const r = rows?.[0] || null;
        const flash = r
            ? {
                id: safeText(r.id),
                title: safeText(r.title),
                body: safeText(r.body),
                start_at: r.start_at ?? null,
                end_at: r.end_at ?? null,
                priority: safeNum(r.priority, 0),
            }
            : null;
        res.json({ flash, fetchedAt: nowIso() });
    }
    catch (e) {
        // ha DB épp halott, a kijelző akkor is fusson: inkább "nincs villám akció"
        res.json({ flash: null, error: safeText(e?.message || e), fetchedAt: nowIso() });
    }
});
// -----------------------------
// Névnap (public) – automatikusan internetről
// -----------------------------
router.get("/nameday", async (_req, res) => {
    const date = ymdBudapest();
    try {
        const [names, templateDb] = await Promise.all([
            fetchNamedayNamesHu().catch(() => []),
            getSettingValue("nameday_template"),
        ]);
        const template = (templateDb && templateDb.trim()) || DEFAULT_NAMEDAY_TEMPLATE;
        const labelNames = names.length ? names.join(", ") : "—";
        const message = template
            .replace(/\{names\}/g, labelNames)
            .replace(/\{date\}/g, date);
        res.json({
            ok: true,
            date,
            names,
            template,
            message,
            fetchedAt: nowIso(),
            source: "nameday.abalin.net",
        });
    }
    catch (e) {
        const template = DEFAULT_NAMEDAY_TEMPLATE;
        res.json({
            ok: false,
            date,
            names: [],
            template,
            message: template.replace(/\{names\}/g, "—").replace(/\{date\}/g, date),
            error: safeText(e?.message || e),
            fetchedAt: nowIso(),
            source: "nameday.abalin.net",
        });
    }
});
exports.default = router;
