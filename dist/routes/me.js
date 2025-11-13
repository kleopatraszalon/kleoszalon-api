"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/me.ts
const express_1 = __importDefault(require("express"));
const db_1 = __importDefault(require("../db"));
const auth_1 = require("../middleware/auth");
const router = express_1.default.Router();
/**
 * GET /api/me
 * Visszaadja a bejelentkezett felhasználó adatait a JWT-ben lévő user id alapján.
 */
router.get("/", auth_1.requireAuth, async (req, res) => {
    try {
        const userId = req.user.id; // JWT payloadból jön (id: users.id)
        const result = await db_1.default.query(`
      SELECT
        u.id,
        u.email,
        u.role,
        u.location_id,
        u.full_name
      FROM users u
      WHERE u.id = $1
      LIMIT 1
      `, [userId]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Felhasználó nem található" });
        }
        const row = result.rows[0];
        // Opcionálisan lekérjük a telephely nevét is
        let locationName = null;
        if (row.location_id) {
            const locRes = await db_1.default.query("SELECT name FROM locations WHERE id = $1 LIMIT 1", [row.location_id]);
            if (locRes.rows.length > 0) {
                locationName = locRes.rows[0].name;
            }
        }
        // A frontend (Home.tsx) ilyen mezőket vár: id, email, role, location_id,
        // full_name, location_name
        return res.json({
            id: row.id,
            email: row.email,
            role: row.role,
            location_id: row.location_id,
            full_name: row.full_name ?? null,
            location_name: locationName,
        });
    }
    catch (err) {
        console.error("❌ GET /api/me hiba:", err);
        return res.status(500).json({ error: "Szerver hiba" });
    }
});
exports.default = router;
