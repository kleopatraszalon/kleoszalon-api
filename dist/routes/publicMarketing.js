"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/publicMarketing.ts
const express_1 = require("express");
const db_1 = __importDefault(require("../db"));
const router = (0, express_1.Router)();
/**
 * Statikus szalonlista – marketing oldalnak.
 */
const PUBLIC_SALONS = [
    {
        id: "budapest-ix",
        slug: "budapest-ix",
        city_label: "Kleopátra Szépségszalon – Budapest IX.",
        address: "Mester u. 1.",
    },
    {
        id: "budapest-viii",
        slug: "budapest-viii",
        city_label: "Kleopátra Szépségszalon – Budapest VIII.",
        address: "Rákóczi u. 63.",
    },
    {
        id: "budapest-xii",
        slug: "budapest-xii",
        city_label: "Kleopátra Szépségszalon – Budapest XII.",
        address: "Krisztina krt. 23.",
    },
    {
        id: "budapest-xiii",
        slug: "budapest-xiii",
        city_label: "Kleopátra Szépségszalon – Budapest XIII.",
        address: "Visegrádi u. 3.",
    },
    {
        id: "eger",
        slug: "eger",
        city_label: "Kleopátra Szépségszalon – Eger",
        address: "Dr. Nagy János u. 8.",
    },
    {
        id: "gyongyos",
        slug: "gyongyos",
        city_label: "Kleopátra Szépségszalon – Gyöngyös",
        address: "Koháry u. 29.",
    },
    {
        id: "salgotarjan",
        slug: "salgotarjan",
        city_label: "Kleopátra Szépségszalon – Salgótarján",
        address: "Füleki u. 44.",
    },
];
/**
 * GET /api/public/salons
 * Statikus lista, nem tud elhasalni.
 */
router.get("/salons", (req, res) => {
    res.json(PUBLIC_SALONS);
});
/**
 * GET /api/public/services
 * Összes aktív szolgáltatás a `services` táblából.
 * A frontend fog telephely szerint szűrni `location_id` alapján.
 */
router.get("/services", async (req, res) => {
    try {
        const sql = `
      SELECT
        s.id::text      AS id,
        s.name          AS name,
        s.duration_min  AS duration_min,
        s.price         AS price,
        s.category_id   AS category_id,
        s.location_id   AS location_id
      FROM public.services s
      WHERE s.is_active = TRUE
      ORDER BY
        s.category_id,
        s.name;
    `;
        const result = await db_1.default.query(sql);
        return res.json(result.rows);
    }
    catch (err) {
        console.error("GET /api/public/services hiba:", err);
        return res
            .status(500)
            .json({ error: "Nem sikerült betölteni a szolgáltatásokat." });
    }
});
exports.default = router;
