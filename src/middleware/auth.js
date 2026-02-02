"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireAuth = requireAuth;
exports.requireRole = requireRole;
var jsonwebtoken_1 = require("jsonwebtoken");
// csak belépett usernek engedjük (admin, recepciós, dolgozó, bárki aktív)
function requireAuth(req, res, next) {
    var _a;
    var authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).json({ error: "Hiányzó jogosultság (nincs token)" });
    }
    try {
        var token = authHeader.split(" ")[1];
        var decoded = jsonwebtoken_1.default.verify(token, process.env.JWT_SECRET);
        // elvárás: a login-nál így rakjuk össze majd a token payloadot:
        // { id, role, location_id }
        req.user = {
            id: decoded.id,
            role: decoded.role,
            location_id: (_a = decoded.location_id) !== null && _a !== void 0 ? _a : null,
        };
        next();
    }
    catch (err) {
        console.error("JWT hiba:", err);
        return res.status(403).json({ error: "Érvénytelen token" });
    }
}
// akkor használd, ha csak bizonyos szerepkör mehet be
function requireRole(allowedRoles) {
    return function (req, res, next) {
        if (!req.user) {
            return res.status(401).json({ error: "Nincs hitelesítés" });
        }
        if (!allowedRoles.includes(req.user.role)) {
            return res.status(403).json({ error: "Nincs jogosultság ehhez a művelethez" });
        }
        next();
    };
}
