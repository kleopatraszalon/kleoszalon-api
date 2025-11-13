"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/services.ts
const express_1 = require("express");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const db_1 = __importDefault(require("../db")); // ← NINCS .js kiterjesztés!
const router = (0, express_1.Router)();
/** Egyszerű Bearer JWT ellenőrzés */
function authenticate(req, res, next) {
    const auth = req.headers.authorization;
    if (!auth)
        return res.status(401).json({ error: "Nincs token" });
    try {
        const token = auth.startsWith("Bearer ") ? auth.slice(7) : auth;
        const decoded = jsonwebtoken_1.default.verify(token, process.env.JWT_SECRET);
        req.user = {
            id: decoded.userId,
            role: decoded.role ?? "guest",
            location_id: (decoded.location_id ?? null),
        };
        next();
    }
    catch {
        return res.status(403).json({ error: "Érvénytelen token" });
    }
}
/**
 * GET /api/services
 * Szolgáltatások visszaadása kategóriákra csoportosítva.
 * A lekérdezés szándékosan általános: SELECT * FROM services,
 * hogy akkor is működjön, ha a mezőnevek kicsit eltérnek
 * (pl. duration_minutes vs. duration_min, category_name vs. category).
 */
router.get("/", authenticate, async (_req, res) => {
    try {
        const result = await db_1.default.query(`SELECT * FROM services ORDER BY name;`);
        // bucket: { [category: string]: Array<service> }
        const bucket = {};
        for (const row of result.rows) {
            // Kategória név rugalmasan
            const category = row.category_name ??
                row.category ??
                row.group_name ??
                "Egyéb";
            // Időtartam rugalmasan
            const duration = row.duration_minutes ??
                row.duration_min ??
                row.duration ??
                0;
            // Ár stringből számmá (pg numeric általában string)
            const priceRaw = row.price ?? row.list_price ?? row.cost ?? 0;
            const price = typeof priceRaw === "number" ? priceRaw : parseFloat(String(priceRaw)) || 0;
            if (!bucket[category])
                bucket[category] = [];
            bucket[category].push({
                id: row.id,
                name: row.name,
                price,
                duration_minutes: Number(duration) || 0,
            });
        }
        // Átalakítás tömbbé
        const response = Object.entries(bucket).map(([category, services]) => ({
            category,
            services,
        }));
        res.json(response);
    }
    catch (err) {
        console.error("❌ Szolgáltatások lekérése hiba:", err);
        res.status(500).json({ error: "Szolgáltatások betöltése sikertelen" });
    }
});
exports.default = router;
