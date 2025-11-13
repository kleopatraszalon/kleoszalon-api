"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/workorders.ts
const express_1 = require("express");
const db_1 = __importDefault(require("../db")); // ahogy nálad van
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const router = (0, express_1.Router)();
const workordersSql = fs_1.default.readFileSync(path_1.default.join(__dirname, "..", "sql", "workorders_list.sql"), "utf8");
router.get("/", async (req, res, next) => {
    try {
        const { locationId, status, from, to, page = "1", pageSize = "20", } = req.query;
        const pageNum = Number(page) || 1;
        const limitNum = Number(pageSize) || 20;
        const offsetNum = (pageNum - 1) * limitNum;
        // 1) locationId: UUID vagy NULL
        const pLocationId = locationId && locationId !== "all" && locationId.trim() !== ""
            ? locationId
            : null;
        // 2) status: TEXT vagy NULL
        const pStatus = status && status !== "all" && status.trim() !== "" ? status : null;
        // 3–4) dátumok: timestamp vagy NULL
        const pFrom = from && from.trim() !== "" ? new Date(from) : null;
        const pTo = to && to.trim() !== "" ? new Date(to) : null;
        // 5–6) limit & offset: számok
        const pLimit = limitNum;
        const pOffset = offsetNum;
        const params = [pLocationId, pStatus, pFrom, pTo, pLimit, pOffset];
        // DEBUG-hez:
        console.log("workorders params:", params);
        const { rows } = await db_1.default.query(workordersSql, params);
        res.json(rows);
    }
    catch (err) {
        next(err);
    }
});
exports.default = router;
