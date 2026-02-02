"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/serviceTypes.ts
const express_1 = require("express");
const db_1 = __importDefault(require("../db"));
const router = (0, express_1.Router)();
/**
 * GET /api/service-types
 * ServiceNewModal + ServicesList szűrő
 */
router.get("/", async (_req, res) => {
    try {
        const result = await db_1.default.query(`SELECT id, name FROM public.service_types ORDER BY name;`);
        res.json(result.rows);
    }
    catch (err) {
        console.error("GET /service-types hiba:", err);
        res.status(500).json({ error: "Nem sikerült betölteni a szolgáltatás típusokat." });
    }
});
exports.default = router;
