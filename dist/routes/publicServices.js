"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/publicServices.ts
const express_1 = require("express");
const node_path_1 = __importDefault(require("node:path"));
const node_fs_1 = __importDefault(require("node:fs"));
const db_1 = __importDefault(require("../db")); // nálad amiből a pg Pool jön
const router = (0, express_1.Router)();
// SQL betöltése a dist/sql-ből build után
const sqlPublicServices = node_fs_1.default.readFileSync(node_path_1.default.join(__dirname, "..", "sql", "public_services_list.sql"), "utf8");
// GET /api/public/services
router.get("/public/services", async (req, res, next) => {
    try {
        const result = await db_1.default.query(sqlPublicServices);
        res.json(result.rows);
    }
    catch (err) {
        console.error("Hiba a public services lekérdezésnél:", err);
        next(err);
    }
});
exports.default = router;
