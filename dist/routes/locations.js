"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/locations.ts
const express_1 = require("express");
const db_1 = __importDefault(require("../db"));
const router = (0, express_1.Router)();
// ===========================================================
// 🏢 SZALONOK / TELEPHELYEK LEKÉRÉSE
// GET /api/locations  (ha a routert így kötöd be: app.use("/api/locations", router))
// ===========================================================
router.get("/", async (_req, res) => {
    try {
        const result = await db_1.default.query(`
      SELECT
        id,
        name,
        address,
        city,
        phone,
        email,
        is_active
      FROM locations
      WHERE is_active = true
      ORDER BY city, name;
      `);
        return res.json(result.rows);
    }
    catch (err) {
        console.error("❌ Szalon lekérési hiba:", err);
        return res.status(500).json({ error: "Nem sikerült lekérni a szalonokat" });
    }
});
// ===========================================================
// ➕ ÚJ SZALON HOZZÁADÁSA
// POST /api/locations
// ===========================================================
router.post("/", async (req, res) => {
    const { name, address, city, phone, email } = (req.body ?? {});
    if (!name || !city) {
        return res.status(400).json({ error: "Név és város megadása kötelező" });
    }
    try {
        const result = await db_1.default.query(`
      INSERT INTO locations (name, address, city, phone, email, is_active)
      VALUES ($1, $2, $3, $4, $5, true)
      RETURNING *;
      `, [name, address ?? null, city, phone ?? null, email ?? null]);
        return res.status(201).json(result.rows[0]);
    }
    catch (err) {
        console.error("❌ Szalon hozzáadási hiba:", err);
        return res.status(500).json({ error: "Nem sikerült hozzáadni a szalont" });
    }
});
// ===========================================================
// ✏️ SZALON MÓDOSÍTÁS
// PUT /api/locations/:id
// ===========================================================
router.put("/:id", async (req, res) => {
    const { id } = req.params;
    const { name, address, city, phone, email, is_active } = (req.body ?? {});
    try {
        const result = await db_1.default.query(`
      UPDATE locations
      SET
        name = $1,
        address = $2,
        city = $3,
        phone = $4,
        email = $5,
        is_active = $6
      WHERE id = $7
      RETURNING *;
      `, [
            name ?? null,
            address ?? null,
            city ?? null,
            phone ?? null,
            email ?? null,
            typeof is_active === "boolean" ? is_active : true,
            id,
        ]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Szalon nem található" });
        }
        return res.json(result.rows[0]);
    }
    catch (err) {
        console.error("❌ Szalon módosítási hiba:", err);
        return res.status(500).json({ error: "Nem sikerült módosítani a szalont" });
    }
});
exports.default = router;
