"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.env = void 0;
const id = (s) => (s || "").trim();
exports.env = {
    adminToken: process.env.SIGNAGE_ADMIN_TOKEN || "",
    servicesSource: (process.env.SIGNAGE_SERVICES_SOURCE || "db").toLowerCase(), // db | api | scrape | none
    // DB mapping (used in db mode)
    servicesTable: id(process.env.SIGNAGE_SERVICES_TABLE || "services"),
    servicesIdCol: id(process.env.SIGNAGE_SERVICES_ID_COL || "id"),
    servicesNameCol: id(process.env.SIGNAGE_SERVICES_NAME_COL || "name_hu"),
    servicesCategoryCol: id(process.env.SIGNAGE_SERVICES_CATEGORY_COL || ""),
    servicesPriceCol: id(process.env.SIGNAGE_SERVICES_PRICE_COL || ""),
    servicesDurationCol: id(process.env.SIGNAGE_SERVICES_DURATION_COL || ""),
    servicesActiveCol: id(process.env.SIGNAGE_SERVICES_ACTIVE_COL || ""),
    // API / scrape fallback (optional)
    servicesPageUrl: process.env.SIGNAGE_SERVICES_PAGE_URL || "https://kleoszalonok.hu/szolgaltatasok",
    servicesApiUrl: process.env.SIGNAGE_SERVICES_API_URL || "",
    cacheTtlMs: Number(process.env.SIGNAGE_CACHE_TTL_MS || 600000),
};
