"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const db_1 = __importDefault(require("../db"));
const router = express_1.default.Router();
// Minden ügyfél lekérése
router.get("/", async (req, res) => {
    try {
        const result = await db_1.default.query("SELECT id, name FROM clients ORDER BY name ASC");
        res.json(result.rows);
    }
    catch (err) {
        console.error("❌ Error fetching clients:", err);
        res.status(500).json({ error: "Error fetching clients" });
    }
});
exports.default = router;
