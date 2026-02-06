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
exports.getServices = getServices;
const env_1 = require("./env");
const servicesRepo_1 = require("./servicesRepo");
let cache = { ts: 0, data: null };
const nowMs = () => Date.now();
async function getServices(pool, onlyEnabled) {
    const t = nowMs();
    if (cache.data && t - cache.ts < env_1.env.cacheTtlMs && onlyEnabled)
        return cache.data;
    let data;
    if (env_1.env.servicesSource === "none") {
        data = { source: "none", fetchedAt: new Date().toISOString(), services: [] };
    }
    else if (env_1.env.servicesSource === "db") {
        data = await (0, servicesRepo_1.getServicesFromDb)(pool, onlyEnabled);
    }
    else if (env_1.env.servicesSource === "api") {
        data = await fetchFromApi();
    }
    else {
        data = await scrapeFromPage();
    }
    if (onlyEnabled)
        cache = { ts: t, data };
    return data;
}
async function fetchFromApi() {
    if (!env_1.env.servicesApiUrl)
        return { source: "api", fetchedAt: new Date().toISOString(), services: [] };
    const r = await fetch(env_1.env.servicesApiUrl, { headers: { "Accept": "application/json" } });
    if (!r.ok)
        throw new Error(`SERVICES_API_URL fetch failed: ${r.status} ${r.statusText}`);
    const j = await r.json();
    const services = Array.isArray(j) ? j : (j.services || []);
    return { source: env_1.env.servicesApiUrl, fetchedAt: new Date().toISOString(), services };
}
async function scrapeFromPage() {
    const cheerio = await Promise.resolve().then(() => __importStar(require("cheerio")));
    const res = await fetch(env_1.env.servicesPageUrl, {
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) KleoSignage/2.0",
            "Accept": "text/html,*/*",
        },
    });
    if (!res.ok)
        throw new Error(`SERVICES_PAGE_URL fetch failed: ${res.status} ${res.statusText}`);
    const html = await res.text();
    const $ = cheerio.load(html);
    let services = [];
    $('script[type="application/ld+json"]').each((_, el) => {
        try {
            const json = JSON.parse($(el).text());
            const stack = Array.isArray(json) ? json : [json];
            for (const node of stack)
                services.push(...findServicesInJsonLd(node));
        }
        catch { }
    });
    if (services.length === 0) {
        const candidates = $(".service, .services .item, .service-card, .card, li, article").slice(0, 400);
        candidates.each((_, el) => {
            const text = $(el).text().replace(/\s+/g, " ").trim();
            if (!text)
                return;
            const priceMatch = text.match(/(\d{1,3}[\s.]?\d{3})\s*(Ft|HUF)/i);
            if (!priceMatch)
                return;
            const name = text.split(priceMatch[0])[0].trim().slice(0, 90);
            if (name.length < 3)
                return;
            services.push({ id: name, name, category: "", price_text: priceMatch[0], durationMin: null });
        });
    }
    services = services.slice(0, 250);
    return { source: env_1.env.servicesPageUrl, fetchedAt: new Date().toISOString(), services };
}
function findServicesInJsonLd(node) {
    const out = [];
    const visit = (x) => {
        if (!x)
            return;
        if (Array.isArray(x))
            return x.forEach(visit);
        if (typeof x !== "object")
            return;
        const type = x["@type"];
        if (type) {
            const types = Array.isArray(type) ? type : [type];
            if (types.includes("Service")) {
                out.push({
                    id: x.name || "",
                    name: x.name || "",
                    category: x.serviceType || x.category || "",
                    price_text: x.offers?.price ? `${x.offers.price} ${x.offers.priceCurrency || ""}`.trim() : "",
                    durationMin: null,
                });
            }
        }
        for (const k of Object.keys(x))
            visit(x[k]);
    };
    visit(node);
    return out;
}
