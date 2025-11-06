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
var auth_1 = require("../middleware/auth");
var router = express_1.default.Router();
/**
 * GET /api/employees/:id/calendar?from=2025-02-01&to=2025-02-07
 *
 * Visszaadja egy adott dolgozó összes eseményét (időpontját)
 * a megadott intervallumban.
 *
 * Ez kell ahhoz, hogy a felugró modalban lásd a heti naptárát.
 */
router.get("/:id/calendar", auth_1.requireAuth, function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var id, _a, from, to, result, mapped, err_1;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0:
                id = req.params.id;
                _a = req.query, from = _a.from, to = _a.to;
                if (!from || !to) {
                    return [2 /*return*/, res.status(400).json({
                            error: "Hiányzó dátum intervallum. Paraméterek: from=YYYY-MM-DD&to=YYYY-MM-DD",
                        })];
                }
                _b.label = 1;
            case 1:
                _b.trys.push([1, 3, , 4]);
                // 🔒 Jogosultság-ellenőrzés
                if (req.user.role !== "admin" && req.user.id !== id) {
                    // Recepciós láthatja a naptárakat is
                    if (req.user.role !== "receptionist") {
                        return [2 /*return*/, res.status(403).json({ error: "Nincs jogosultság ehhez a naptárhoz" })];
                    }
                }
                return [4 /*yield*/, db_1.default.query("\n      SELECT \n        a.id,\n        a.title,\n        a.start_time,\n        a.end_time,\n        a.status,\n        a.price,\n        a.notes,\n        a.location_id,\n        l.name AS location_name,\n        c.full_name AS client_name,\n        s.name AS service_name\n      FROM appointments a\n      LEFT JOIN locations l ON l.id = a.location_id\n      LEFT JOIN clients   c ON c.id = a.client_id\n      LEFT JOIN services  s ON s.id = a.service_id\n      WHERE a.employee_id = $1\n        AND a.start_time >= $2\n        AND a.end_time   <= $3\n      ORDER BY a.start_time ASC\n      ", [id, from, to])];
            case 2:
                result = _b.sent();
                mapped = result.rows.map(function (row) { return ({
                    id: row.id,
                    title: row.title || "".concat(row.service_name || "Szolgáltatás", " - ").concat(row.client_name || "Vendég"),
                    start: row.start_time,
                    end: row.end_time,
                    status: row.status,
                    price: row.price,
                    notes: row.notes,
                    location_id: row.location_id,
                    location_name: row.location_name,
                    client_name: row.client_name || null,
                    service_name: row.service_name || null,
                }); });
                // 🔹 Válasz
                return [2 /*return*/, res.json({
                        employee_id: id,
                        from: from,
                        to: to,
                        events: mapped,
                    })];
            case 3:
                err_1 = _b.sent();
                console.error("❌ GET /api/employees/:id/calendar hiba:", err_1);
                return [2 /*return*/, res.status(500).json({ error: "Szerver hiba" })];
            case 4: return [2 /*return*/];
        }
    });
}); });
exports.default = router;
