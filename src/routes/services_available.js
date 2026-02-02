"use strict";
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
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
var auth_1 = require("../middleware/auth");
var router = express_1.default.Router();
/**
 * GET /api/services/available?location_id=...&employee_id=...
 *
 * Visszaadja az adott telephelyen elérhető foglalható szolgáltatásokat.
 * Ha employee_id is jön, akkor csak azokat, amiket az adott dolgozó végez.
 * (A dolgozó-specifikus ár/idő felülírást is visszaküldjük, ha létezik.)
 */
router.get("/", auth_1.requireAuth, function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, location_id, employee_id, baseServicesResult, services, allowedResult, allowedIds_1, overrideResult, overrideMap_1, err_1;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0:
                _a = req.query, location_id = _a.location_id, employee_id = _a.employee_id;
                if (!location_id) {
                    return [2 /*return*/, res.status(400).json({ error: "location_id kötelező" })];
                }
                _b.label = 1;
            case 1:
                _b.trys.push([1, 7, , 8]);
                return [4 /*yield*/, db_1.default.query("\n      SELECT\n        s.id,\n        s.parent_id,\n        s.name,\n        s.description,\n        s.base_price,\n        s.base_duration_minutes,\n        s.is_bookable,\n        s.active\n      FROM services s\n      WHERE s.active = true\n        AND s.is_bookable = true\n        AND EXISTS (\n          SELECT 1\n          FROM service_locations sl\n          WHERE sl.service_id = s.id\n            AND sl.location_id = $1\n        )\n      ORDER BY s.name ASC\n      ", [location_id])];
            case 2:
                baseServicesResult = _b.sent();
                services = baseServicesResult.rows;
                if (!employee_id) return [3 /*break*/, 4];
                return [4 /*yield*/, db_1.default.query("\n        SELECT DISTINCT service_id\n        FROM employee_service_overrides\n        WHERE employee_id = $1\n        ", [employee_id])];
            case 3:
                allowedResult = _b.sent();
                allowedIds_1 = allowedResult.rows.map(function (r) { return r.service_id; });
                services = services.filter(function (svc) { return allowedIds_1.includes(svc.id); });
                _b.label = 4;
            case 4:
                if (!(employee_id && services.length > 0)) return [3 /*break*/, 6];
                return [4 /*yield*/, db_1.default.query("\n        SELECT service_id, custom_price, custom_duration_minutes\n        FROM employee_service_overrides\n        WHERE employee_id = $1\n          AND service_id = ANY($2::uuid[])\n        ", [employee_id, services.map(function (s) { return s.id; })])];
            case 5:
                overrideResult = _b.sent();
                overrideMap_1 = {};
                overrideResult.rows.forEach(function (row) {
                    var _a, _b;
                    overrideMap_1[row.service_id] = {
                        price: (_a = row.custom_price) !== null && _a !== void 0 ? _a : undefined,
                        dur: (_b = row.custom_duration_minutes) !== null && _b !== void 0 ? _b : undefined,
                    };
                });
                services = services.map(function (svc) {
                    var _a, _b;
                    var ov = overrideMap_1[svc.id];
                    if (!ov)
                        return svc;
                    return __assign(__assign({}, svc), { base_price: (_a = ov.price) !== null && _a !== void 0 ? _a : svc.base_price, base_duration_minutes: (_b = ov.dur) !== null && _b !== void 0 ? _b : svc.base_duration_minutes });
                });
                _b.label = 6;
            case 6: 
            // 🔹 4. Válasz a kliensnek
            return [2 /*return*/, res.json({
                    location_id: location_id,
                    employee_id: employee_id || null,
                    services: services,
                })];
            case 7:
                err_1 = _b.sent();
                console.error("❌ GET /api/services/available hiba:", err_1);
                return [2 /*return*/, res.status(500).json({ error: "Szerver hiba" })];
            case 8: return [2 /*return*/];
        }
    });
}); });
exports.default = router;
