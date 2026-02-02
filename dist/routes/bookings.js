"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/bookings.ts
const express_1 = __importDefault(require("express"));
const db_1 = __importDefault(require("../db"));
const router = express_1.default.Router();
router.get("/", async (_req, res) => {
    try {
        const r = await db_1.default.query(`SELECT id, customer_name, service_id, employee_id, starts_at, ends_at, status
       FROM bookings
       ORDER BY starts_at DESC
       LIMIT 200;`);
        res.json(r.rows);
    }
    catch (e) {
        console.error("❌ Bookings lekérési hiba:", e);
        res.status(500).json({ error: "Nem sikerült lekérni a foglalásokat" });
    }
});
exports.default = router;
