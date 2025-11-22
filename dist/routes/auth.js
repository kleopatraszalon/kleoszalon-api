"use strict";
// src/routes/auth.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const db_1 = __importDefault(require("../db")); // default export (pool), a név mindegy
const bcrypt_1 = __importDefault(require("bcrypt"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const router = express_1.default.Router();
/**
 * POST /api/login
 * Body: { email?: string, identifier?: string, username?: string, login?: string, phone?: string, password: string, location_id?: string | null }
 */
router.post("/login", async (req, res) => {
    console.log("[/api/login] body:", req.body);
    const { email, identifier, username, login, phone, password, location_id, } = (req.body || {});
    const loginIdentifier = (identifier || email || username || login || phone || "").trim();
    if (!loginIdentifier || !password) {
        console.warn("[/api/login] Hiányzó loginIdentifier vagy password.");
        return res.status(400).json({ error: "Hiányzó azonosító vagy jelszó." });
    }
    try {
        const result = await db_1.default.query(`
      SELECT *
      FROM users
      WHERE email = $1
      `, [loginIdentifier]);
        if (result.rowCount === 0) {
            console.warn("[/api/login] Nincs ilyen felhasználó:", loginIdentifier);
            return res.status(401).json({ error: "Hibás felhasználó vagy jelszó." });
        }
        const user = result.rows[0];
        // elfogadjuk, ha a DB-ben password_hash VAGY password mező van
        const hash = user.password_hash || user.password;
        if (!hash) {
            console.error("[/api/login] Nincs password_hash vagy password mező a users táblában!");
            return res.status(500).json({
                error: "A jelszó mező hiányzik a szerveren. Kérlek jelezd a rendszergazdának.",
            });
        }
        const ok = await bcrypt_1.default.compare(password, hash);
        if (!ok) {
            console.warn("[/api/login] Hibás jelszó:", loginIdentifier);
            return res.status(401).json({ error: "Hibás felhasználó vagy jelszó." });
        }
        const token = jsonwebtoken_1.default.sign({ userId: user.id, role: user.role }, process.env.JWT_SECRET || "dev-secret", { expiresIn: "7d" });
        // Token süti
        res.cookie("token", token, {
            httpOnly: true,
            sameSite: "lax",
            secure: false, // Renderen https alatt majd lehet true
        });
        console.log("[/api/login] Sikeres belépés:", loginIdentifier);
        return res.json({
            success: true,
            user: {
                id: user.id,
                email: user.email,
                role: user.role,
            },
            token,
        });
    }
    catch (err) {
        console.error("[AUTH] /api/login hiba:", err);
        return res
            .status(500)
            .json({ error: "Szerver hiba a bejelentkezés közben." });
    }
});
exports.default = router;
