"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/menu.ts
const express = __importStar(require("express"));
const db_1 = __importDefault(require("../db"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const router = express.Router();
// --- Felhasználói szerepkör kinyerése a Bearer tokenből ---
function getUserRole(req) {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    const secret = process.env.JWT_SECRET;
    if (!token || !secret)
        return "all";
    try {
        const payload = jsonwebtoken_1.default.verify(token, secret);
        return (payload?.role || "all").toString().toLowerCase();
    }
    catch {
        return "all";
    }
}
router.get("/", async (req, res) => {
    const userRole = getUserRole(req); // 'all' | 'employee' | 'admin' ...
    const baseSelect = `
    id, name, icon, route, order_index, parent_id
  `;
    const sqlWithRole = `
    SELECT ${baseSelect}, LOWER(role) AS role
    FROM menus
    WHERE LOWER(role) = 'all' OR LOWER(role) = $1
    ORDER BY COALESCE(parent_id, 0) ASC, order_index ASC, id ASC
  `;
    const sqlNoRole = `
    SELECT ${baseSelect}, 'all'::text AS role
    FROM menus
    ORDER BY COALESCE(parent_id, 0) ASC, order_index ASC, id ASC
  `;
    try {
        let rows = [];
        try {
            const r1 = await db_1.default.query(sqlWithRole, [userRole]);
            rows = r1.rows;
        }
        catch (err) {
            if (err?.code === "42703") {
                const r2 = await db_1.default.query(sqlNoRole);
                rows = r2.rows;
            }
            else {
                throw err;
            }
        }
        // --- Hierarchia építés ---
        const byId = new Map();
        rows.forEach((r) => {
            byId.set(r.id, {
                id: r.id,
                name: r.name,
                icon: r.icon ?? null,
                route: r.route,
                order_index: r.order_index ?? 0,
                parent_id: r.parent_id ?? null,
                role: r.role ?? "all",
                submenus: [],
            });
        });
        const roots = [];
        rows.forEach((r) => {
            const item = byId.get(r.id);
            if (r.parent_id && byId.has(r.parent_id)) {
                byId.get(r.parent_id).submenus.push(item);
            }
            else {
                roots.push(item);
            }
        });
        const sortTree = (arr) => {
            arr.sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0) || a.id - b.id);
            arr.forEach((n) => sortTree(n.submenus));
        };
        sortTree(roots);
        return res.status(200).json(roots);
    }
    catch (err) {
        console.error("❌ Menü betöltési hiba:", err?.message || err);
        return res.status(500).json({ error: "Adatbázis hiba a menü lekérésekor" });
    }
});
exports.default = router;
