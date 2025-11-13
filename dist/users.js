"use strict";
// 🔹 Összes felhasználó listázása (admin funkció)
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const db_js_1 = __importDefault(require("./db.js")); // vagy "../db", ha a routes mappában van
const router = express_1.default.Router();
// 🔹 Összes felhasználó lekérdezése
router.get("/", async (req, res) => {
    try {
        const result = await db_js_1.default.query("SELECT id, name, email, role, is_active, created_at FROM users ORDER BY created_at DESC");
        res.json(result.rows);
    }
    catch (err) {
        console.error("❌ Hiba a felhasználók lekérdezésénél:", err);
        res.status(500).json({ error: "Adatbázis hiba" });
    }
});
router.get("/", (_req, res) => {
    res.json([]);
});
// 🔹 Felhasználó aktiválása admin által
router.put("/activate/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const result = await db_js_1.default.query("UPDATE users SET is_active = true WHERE id = $1 RETURNING id, name, email, role, is_active", [id]);
        if (result.rowCount === 0)
            return res.status(404).json({ error: "Felhasználó nem található" });
        res.json({ success: true, user: result.rows[0] });
    }
    catch (err) {
        console.error("❌ Hiba az aktiválás során:", err);
        res.status(500).json({ error: "Adatbázis hiba" });
    }
});
exports.default = router;
