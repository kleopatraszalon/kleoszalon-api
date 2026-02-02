"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = __importDefault(require("../db"));
const router = (0, express_1.Router)();
router.get("/", async (_req, res) => {
    try {
        const sql = `
      SELECT id, name, code, sort_order, is_active
      FROM product_groups
      ORDER BY sort_order, name
    `;
        const { rows } = await db_1.default.query(sql);
        res.json(rows);
    }
    catch (err) {
        console.error("GET /product-groups hiba:", err);
        res.status(500).json({ error: "Nem sikerült lekérdezni a termékcsoportokat." });
    }
});
exports.default = router;
