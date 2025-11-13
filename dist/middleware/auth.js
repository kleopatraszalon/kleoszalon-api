"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireAuth = requireAuth;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const JWT_SECRET = process.env.JWT_SECRET || "dev_secret_change_me";
function getTokenFromReq(req) {
    const authHeader = req.headers["authorization"] ||
        req.headers["Authorization"];
    if (authHeader && /^Bearer\s+/i.test(authHeader)) {
        return authHeader.replace(/^Bearer\s+/i, "");
    }
    const cookieToken = req.cookies?.token;
    if (cookieToken)
        return cookieToken;
    if (typeof req.query.token === "string")
        return req.query.token;
    if (req.body && typeof req.body.token === "string") {
        return req.body.token;
    }
    return null;
}
function requireAuth(req, res, next) {
    const token = getTokenFromReq(req);
    if (!token) {
        return res.status(401).json({
            error: "Nincs belépés. Kérjük, jelentkezz be újra.",
        });
    }
    try {
        const decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
        req.user = {
            id: decoded.id,
            email: decoded.email,
            role: decoded.role,
            location_id: decoded.location_id ?? null,
        };
        return next();
    }
    catch (err) {
        console.error("JWT hiba:", err);
        // Lejárt token esetén: süti törlése + kulturált üzenet
        if (err.name === "TokenExpiredError") {
            res.clearCookie("token", { path: "/" });
            return res.status(401).json({
                error: "A munkamenet lejárt. Kérjük, jelentkezz be újra.",
            });
        }
        return res.status(401).json({
            error: "Érvénytelen token. Kérjük, jelentkezz be újra.",
        });
    }
}
