"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/locations.ts
const express_1 = require("express");
const db_1 = __importDefault(require("../db"));
const router = (0, express_1.Router)();
/**
 * Telephelyek (locations) listázása.
 * Ha a router az /api alá van bekötve (app.use("/api", locationsRoutes)),
 * akkor az elérési út: GET /api/locations
 */
async function listLocations(_req, res) {
    try {
        // TODO: ha nálad nem "locations" a tábla neve, itt állítsd át!
        // Itt most csak egy egyszerű lekérdezés van, hogy minél kevesebb oszlopon bukjon el.
        const result = await db_1.default.query(`
      SELECT
        id,
        name
      FROM locations
      ORDER BY name;
      `);
        res.json(result.rows);
    }
    catch (err) {
        console.error("GET /api/locations error:", err);
        // FEJLESZTÉSKOR adjunk vissza demo adatot, hogy a frontend tudjon működni
        if (process.env.NODE_ENV !== "production") {
            res.json([
                { id: "demo-1", name: "Budapest – Kleopátra Központ" },
                { id: "demo-2", name: "Gödöllő – Kleopátra Szalon" },
            ]);
            return;
        }
        // ÉLESBEN maradjon a 500-as hiba
        res.status(500).json({
            success: false,
            error: "Nem sikerült lekérni a telephelyeket.",
        });
    }
}
// Ha a router "/api" alá kerül, ez = GET /api/locations
router.get("/locations", listLocations);
exports.default = router;
