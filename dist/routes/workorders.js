"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/workorders.ts
const express_1 = require("express");
// ❌ RÉGI:
// import { db } from "../db";
// ✅ ÚJ:
const db_1 = __importDefault(require("../db"));
const router = (0, express_1.Router)();
// Már létező GET /api/workorders itt lehet…
router.post("/workorders", async (req, res, next) => {
    try {
        const { title, notes, status, employee_id, client_name, client_phone, client_email, services, } = req.body;
        const result = await db_1.default.query(`
      INSERT INTO work_orders
        (title, notes, status, employee_id, client_name, client_phone, client_email)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING id
      `, [title, notes ?? null, status ?? "arrived", employee_id ?? null,
            client_name ?? null, client_phone ?? null, client_email ?? null]);
        const workOrderId = result.rows[0].id;
        if (Array.isArray(services) && services.length > 0) {
            for (const item of services) {
                await db_1.default.query(`
          INSERT INTO work_order_items (work_order_id, service_id, quantity)
          VALUES ($1, $2, $3)
          `, [workOrderId, item.service_id, item.quantity ?? 1]);
            }
        }
        res.status(201).json({ id: workOrderId });
    }
    catch (err) {
        next(err);
    }
});
exports.default = router;
