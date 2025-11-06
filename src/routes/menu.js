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
Object.defineProperty(exports, "__esModule", { value: true });
var express_1 = require("express");
var db_1 = require("../db");
var jsonwebtoken_1 = require("jsonwebtoken");
var router = express_1.default.Router();
// --- Felhasználói szerepkör kinyerése a Bearer tokenből (opcionális) ---
function getUserRole(req) {
    var auth = req.headers.authorization || "";
    var token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    var secret = process.env.JWT_SECRET;
    if (!token || !secret)
        return "all";
    try {
        var payload = jsonwebtoken_1.default.verify(token, secret);
        return ((payload === null || payload === void 0 ? void 0 : payload.role) || "all").toString().toLowerCase();
    }
    catch (_a) {
        return "all";
    }
}
router.get("/", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var userRole, baseSelect, sqlWithRole, sqlNoRole, rows, r1, err_1, r2, byId_1, roots_1, sortTree_1, err_2;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                userRole = getUserRole(req);
                baseSelect = "\n    id, name, icon, route, order_index, parent_id\n  ";
                sqlWithRole = "\n    SELECT ".concat(baseSelect, ", LOWER(role) AS role\n    FROM menus\n    WHERE LOWER(role) = 'all' OR LOWER(role) = $1\n    ORDER BY COALESCE(parent_id, 0) ASC, order_index ASC, id ASC\n  ");
                sqlNoRole = "\n    SELECT ".concat(baseSelect, ", 'all'::text AS role\n    FROM menus\n    ORDER BY COALESCE(parent_id, 0) ASC, order_index ASC, id ASC\n  ");
                _a.label = 1;
            case 1:
                _a.trys.push([1, 9, , 10]);
                rows = [];
                _a.label = 2;
            case 2:
                _a.trys.push([2, 4, , 8]);
                return [4 /*yield*/, db_1.default.query(sqlWithRole, [userRole])];
            case 3:
                r1 = _a.sent();
                rows = r1.rows;
                return [3 /*break*/, 8];
            case 4:
                err_1 = _a.sent();
                if (!((err_1 === null || err_1 === void 0 ? void 0 : err_1.code) === "42703")) return [3 /*break*/, 6];
                return [4 /*yield*/, db_1.default.query(sqlNoRole)];
            case 5:
                r2 = _a.sent();
                rows = r2.rows;
                return [3 /*break*/, 7];
            case 6: throw err_1;
            case 7: return [3 /*break*/, 8];
            case 8:
                byId_1 = new Map();
                rows.forEach(function (r) {
                    var _a, _b, _c, _d;
                    byId_1.set(r.id, {
                        id: r.id,
                        name: r.name,
                        icon: (_a = r.icon) !== null && _a !== void 0 ? _a : null,
                        route: r.route,
                        order_index: (_b = r.order_index) !== null && _b !== void 0 ? _b : 0,
                        parent_id: (_c = r.parent_id) !== null && _c !== void 0 ? _c : null,
                        role: (_d = r.role) !== null && _d !== void 0 ? _d : "all",
                        submenus: [],
                    });
                });
                roots_1 = [];
                rows.forEach(function (r) {
                    var item = byId_1.get(r.id);
                    if (r.parent_id && byId_1.has(r.parent_id)) {
                        byId_1.get(r.parent_id).submenus.push(item);
                    }
                    else {
                        roots_1.push(item);
                    }
                });
                sortTree_1 = function (arr) {
                    arr.sort(function (a, b) { var _a, _b; return ((_a = a.order_index) !== null && _a !== void 0 ? _a : 0) - ((_b = b.order_index) !== null && _b !== void 0 ? _b : 0) || a.id - b.id; });
                    arr.forEach(function (n) { return sortTree_1(n.submenus); });
                };
                sortTree_1(roots_1);
                return [2 /*return*/, res.status(200).json(roots_1)];
            case 9:
                err_2 = _a.sent();
                console.error("❌ Menü betöltési hiba:", (err_2 === null || err_2 === void 0 ? void 0 : err_2.message) || err_2);
                return [2 /*return*/, res.status(500).json({ error: "Adatbázis hiba a menü lekérésekor" })];
            case 10: return [2 /*return*/];
        }
    });
}); });
exports.default = router;
