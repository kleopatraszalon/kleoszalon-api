"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const db_1 = __importDefault(require("../db"));
const router = express_1.default.Router();
/**
 * 🔹 Gyors hozzáférések lekérdezése (linkek + név)
 */
router.get("/", async (req, res) => {
    try {
        res.header("Access-Control-Allow-Origin", "*");
        const result = await db_1.default.query(`SELECT id, name, link
       FROM quick_access
       ORDER BY id ASC`);
        res.json(result.rows);
    }
    catch (err) {
        console.error("❌ Gyors hozzáférés lekérési hiba:", err);
        res.status(500).json({ error: "Adatbázis hiba" });
    }
});
exports.default = router;
