"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/employees.ts
const express_1 = require("express");
const db_1 = __importDefault(require("../db"));
const router = (0, express_1.Router)();
/**
 * GET /api/employees
 * Minden dolgozó listája a naptárhoz.
 * Nem kérünk itt auth-ot, hogy biztosan visszaadja a listát.
 */
router.get("/", async (_req, res, next) => {
    try {
        const { rows } = await db_1.default.query(`
        SELECT
          id,
          location_id,
          full_name,
          email,
          phone,
          position_id,
          photo_url
        FROM public.employees
        ORDER BY full_name NULLS LAST
        `);
        res.json(rows);
    }
    catch (err) {
        console.error("GET /api/employees hiba:", err);
        next(err);
    }
});
exports.default = router;
