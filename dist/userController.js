"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/users.ts (vagy ahogy nálad hívják ezt a routert)
require("dotenv/config");
const express_1 = require("express");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const db_js_1 = __importDefault(require("./db.js"));
const router = (0, express_1.Router)();
/** Új felhasználó létrehozása */
router.post("/create", async (req, res) => {
    try {
        const { full_name, email, password, role } = req.body;
        if (!full_name || !email || !password || !role) {
            return res.status(400).json({ error: "Hiányzó mezők" });
        }
        // (opcionális) e-mail egyediség ellenőrzés
        const exists = await db_js_1.default.query("SELECT 1 FROM users WHERE email = $1", [email]);
        if (exists.rowCount && exists.rowCount > 0) {
            return res.status(409).json({ error: "Ezzel az e-maillel már létezik felhasználó" });
        }
        const password_hash = await bcryptjs_1.default.hash(password, 10);
        const result = await db_js_1.default.query(`INSERT INTO users (full_name, email, password_hash, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, full_name, email, role`, [full_name, email, password_hash, role]);
        return res.status(201).json({ message: "Felhasználó létrehozva", user: result.rows[0] });
    }
    catch (err) {
        // Postgres egyedi kulcs sértés: 23505
        if (typeof err === "object" &&
            err !== null &&
            "code" in err &&
            err.code === "23505") {
            return res.status(409).json({ error: "Duplikált adat (valószínűleg e-mail)" });
        }
        console.error("Hiba a felhasználó mentésekor:", err);
        return res.status(500).json({ error: "Adatbázis hiba" });
    }
});
/** Verify code endpoint – DEMÓ: mindig 123456 */
router.post("/verify-code", async (req, res) => {
    try {
        const { email, code } = req.body;
        if (!email || !code) {
            return res.status(400).json({ error: "Hiányzó mezők" });
        }
        if (code !== "123456") {
            return res.status(400).json({ error: "Érvénytelen kód" });
        }
        const userResult = await db_js_1.default.query("SELECT id, email, role FROM users WHERE email = $1", [email]);
        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: "Felhasználó nem található" });
        }
        const user = userResult.rows[0];
        const secret = process.env.JWT_SECRET;
        if (!secret) {
            console.error("Hiányzó JWT_SECRET környezeti változó.");
            return res.status(500).json({ error: "Szerver beállítási hiba (JWT)" });
        }
        const token = jsonwebtoken_1.default.sign({ id: user.id, email: user.email, role: user.role }, secret, { expiresIn: "1h" });
        return res.json({ message: "Sikeres hitelesítés", token });
    }
    catch (err) {
        console.error("Hiba a kód ellenőrzésekor:", err);
        return res.status(500).json({ error: "Szerver hiba" });
    }
});
exports.default = router;
