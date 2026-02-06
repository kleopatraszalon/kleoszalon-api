"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireAdmin = requireAdmin;
const env_1 = require("./env");
/**
 * Admin guard:
 * 1) If your existing auth attaches req.user.role === 'admin', this passes.
 * 2) Else: allow token-based auth via header X-Admin-Token.
 */
function requireAdmin(req, res, next) {
    const anyReq = req;
    if (anyReq.user?.role === "admin")
        return next();
    const token = (req.header("X-Admin-Token") || "").trim();
    if (env_1.env.adminToken && token === env_1.env.adminToken)
        return next();
    return res.status(401).json({ error: "unauthorized" });
}
