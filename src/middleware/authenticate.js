"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.authenticate = authenticate;
var jsonwebtoken_1 = require("jsonwebtoken");
function authenticate(req, res, next) {
    var auth = req.headers.authorization;
    if (!auth) {
        return res.status(401).json({ error: "Nincs token" });
    }
    try {
        var token = auth.split(" ")[1];
        var decoded = jsonwebtoken_1.default.verify(token, process.env.JWT_SECRET);
        req.user = {
            id: decoded.userId,
            role: decoded.role || "guest",
            location_id: decoded.location_id || null,
        };
        next();
    }
    catch (err) {
        return res.status(403).json({ error: "Érvénytelen token" });
    }
}
