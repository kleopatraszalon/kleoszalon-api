"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = __importDefault(require("../db"));
const router = (0, express_1.Router)();
router.get("/professionals", async (_req, res) => {
    try {
        const { rows } = await db_1.default.query(`
      SELECT *, id::text AS id
      FROM public.signage_professionals
      WHERE show = true
      ORDER BY priority DESC, is_free DESC, updated_at DESC
      LIMIT 30;
    `);
        res.json({ professionals: rows });
    }
    catch (e) {
        res.status(500).json({ error: String(e?.message || e) });
    }
});
exports.default = router;
