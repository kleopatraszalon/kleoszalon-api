"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/appointments.ts
const express_1 = require("express");
const db_1 = __importDefault(require("../db"));
const router = (0, express_1.Router)();
/**
 * GET /api/appointments
 * Query paraméterek:
 *   from: "YYYY-MM-DD HH:MM" (opcionális)
 *   to:   "YYYY-MM-DD HH:MM" (opcionális)
 *
 * A frontend most így hívja:
 *   /api/appointments?from=2025-11-14 00:00&to=2025-11-14 23:59
 */
router.get("/", async (req, res) => {
    try {
        const { from, to } = req.query;
        const fromStr = typeof from === "string" ? from : undefined;
        const toStr = typeof to === "string" ? to : undefined;
        const params = [];
        let where = "WHERE 1=1";
        if (fromStr) {
            params.push(fromStr);
            where += ` AND a.start_time >= $${params.length}::timestamp`;
        }
        if (toStr) {
            params.push(toStr);
            where += ` AND a.start_time <= $${params.length}::timestamp`;
        }
        const sql = `
      SELECT
        a.id,
        a.start_time,
        a.end_time,
        a.status
      FROM public.appointments a
      ${where}
      ORDER BY a.start_time ASC
    `;
        const { rows } = await db_1.default.query(sql, params);
        res.json(rows);
    }
    catch (err) {
        console.error("GET /api/appointments error:", err);
        res
            .status(500)
            .json({ error: "Hiba a bejelentkezések lekérdezésekor" });
    }
});
exports.default = router;
