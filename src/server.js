"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
/* ===== .env betöltése az első sorban ===== */
var dotenv_1 = require("dotenv");
dotenv_1.default.config();
var express_1 = require("express");
var cors_1 = require("cors");
var bcryptjs_1 = require("bcryptjs");
var jsonwebtoken_1 = require("jsonwebtoken");
var db_1 = require("./db");
// ROUTES
var menu_1 = require("./routes/menu");
var me_1 = require("./routes/me");
var workorders_1 = require("./routes/workorders");
var bookings_1 = require("./routes/bookings");
var transactions_1 = require("./routes/transactions");
var locations_1 = require("./routes/locations");
var dashboard_1 = require("./routes/dashboard");
var employees_1 = require("./routes/employees");
var services_1 = require("./routes/services");
var services_available_1 = require("./routes/services_available");
var employee_calendar_1 = require("./routes/employee_calendar");
var mailer_1 = require("./mailer");
var tempCodeStore_1 = require("./tempCodeStore");
var app = (0, express_1.default)();
/* ===== Proxy és alap middlewares ===== */
app.set("trust proxy", 1);
// --- CORS előbb, mint bármely route! ---
var allowedOrigins = ((_a = process.env.CORS_ORIGIN) === null || _a === void 0 ? void 0 : _a.split(",").map(function (s) { return s.trim(); }).filter(Boolean)) || [];
var corsOptions = {
    // Ha nincs megadva semmi, legyen minden origin engedélyezve (dev)
    origin: allowedOrigins.length > 0 && !allowedOrigins.includes("*") ? allowedOrigins : true,
    credentials: allowedOrigins.length > 0 ? !allowedOrigins.includes("*") : true,
};
app.use((0, cors_1.default)(corsOptions));
// Preflight kérelmek (OPTIONS) kezelése
app.options("*", (0, cors_1.default)(corsOptions));
app.use(express_1.default.json());
/* ===== Health check ===== */
app.get("/api/health", function (_req, res) {
    res.json({ ok: true, time: new Date().toISOString() });
});
/* ===== Teszt root ===== */
app.get("/", function (_req, res) {
    res.send("✅ Backend fut és CORS be van állítva");
});
/* ===== Route-ok (MENÜ legfelül, alias-szal) ===== */
app.use("/api/menu", menu_1.default); // => GET /api/menu
app.use("/api/menus", menu_1.default); // alias, ha a frontend ezt hívja
app.use("/api/me", me_1.default);
app.use("/api/employees", employees_1.default);
app.use("/api/services", services_1.default);
app.use("/api/services/available", services_available_1.default);
app.use("/api/employee-calendar", employee_calendar_1.default);
app.use("/api/dashboard", dashboard_1.default);
app.use("/api/locations", locations_1.default);
app.use("/api/workorders", workorders_1.default);
app.use("/api/bookings", bookings_1.default);
app.use("/api/transactions", transactions_1.default);
/* ===== Auth: Login ===== */
app.post("/api/login", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, email, password, result, user, isMatch, code, expiresMin, err_1;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0:
                _a = req.body, email = _a.email, password = _a.password;
                if (!email || !password) {
                    return [2 /*return*/, res.status(400).json({ success: false, error: "Hiányzó e-mail vagy jelszó" })];
                }
                _b.label = 1;
            case 1:
                _b.trys.push([1, 5, , 6]);
                return [4 /*yield*/, db_1.default.query("SELECT id, email, password_hash, role, location_id, active FROM users WHERE email = $1", [email])];
            case 2:
                result = _b.sent();
                if (result.rows.length === 0) {
                    return [2 /*return*/, res.status(401).json({ success: false, error: "Hibás e-mail vagy jelszó" })];
                }
                user = result.rows[0];
                if (!user.active) {
                    return [2 /*return*/, res.status(403).json({ success: false, error: "Fiók inaktív" })];
                }
                return [4 /*yield*/, bcryptjs_1.default.compare(password, user.password_hash)];
            case 3:
                isMatch = _b.sent();
                if (!isMatch) {
                    return [2 /*return*/, res.status(401).json({ success: false, error: "Hibás e-mail vagy jelszó" })];
                }
                code = Math.floor(100000 + Math.random() * 900000).toString();
                expiresMin = parseInt(process.env.CODE_EXPIRES_MIN || "5", 10);
                (0, tempCodeStore_1.saveCodeForEmail)(email, {
                    code: code,
                    userId: user.id,
                    role: user.role || "guest",
                    location_id: user.location_id || null,
                    expiresAt: Date.now() + expiresMin * 60 * 1000,
                });
                console.log("📧 Küldés előtt – SMTP_USER:", process.env.SMTP_USER);
                return [4 /*yield*/, (0, mailer_1.default)(email, code)];
            case 4:
                _b.sent();
                return [2 /*return*/, res.json({
                        success: true,
                        step: "code_required",
                        message: "Belépési kód elküldve az e-mail címre.",
                    })];
            case 5:
                err_1 = _b.sent();
                console.error("❌ Login hiba:", err_1);
                return [2 /*return*/, res.status(500).json({ success: false, error: "Hiba történt a belépés során" })];
            case 6: return [2 /*return*/];
        }
    });
}); });
/* ===== Auth: Verify Code ===== */
app.post("/api/verify-code", function (req, res) {
    var _a = req.body, email = _a.email, code = _a.code;
    var record = (0, tempCodeStore_1.consumeCode)(email);
    if (!record) {
        return res.status(400).json({
            success: false,
            error: "Nincs aktív kód ehhez az e-mailhez vagy lejárt",
        });
    }
    if (record.code !== code) {
        return res.status(400).json({ success: false, error: "Érvénytelen kód" });
    }
    var secret = process.env.JWT_SECRET;
    if (!secret) {
        console.error("❌ Hiányzó JWT_SECRET környezeti változó.");
        return res.status(500).json({ success: false, error: "Szerver beállítási hiba (JWT)" });
    }
    var token = jsonwebtoken_1.default.sign({
        email: email,
        userId: record.userId,
        role: record.role,
        location_id: record.location_id || null,
    }, secret, { expiresIn: "8h" });
    return res.json({
        success: true,
        token: token,
        role: record.role,
        location_id: record.location_id || null,
    });
});
/* ===== 404 Not Found ===== */
app.use(function (req, res) {
    res.status(404).json({ error: "Not found", path: req.originalUrl });
});
/* ===== Globális hiba-kezelő ===== */
app.use(function (err, _req, res, _next) {
    console.error("❌ Unhandled error:", err);
    res.status(500).json({ error: "Szerver hiba" });
});
/* ===== Indítás ===== */
var port = Number(process.env.PORT) || 5000;
var host = "0.0.0.0";
var server = app.listen(port, host, function () {
    console.log("\u2705 Server running on http://".concat(host, ":").concat(port));
});
server.on("error", function (err) {
    if (err.code === "EADDRINUSE") {
        console.error("\u274C Port ".concat(port, " m\u00E1r haszn\u00E1latban van."));
    }
    else {
        console.error(err);
    }
});
exports.default = app;
