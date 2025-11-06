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
/* 🔐 Autentikáció middleware
   - kiveszi a Bearer tokent
   - jwt.verify
   - ráteszi a req.user-t (id, role, location_id)
*/
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
            role: decoded.role, // <-- ez a DB-ben beállított szerep!
            location_id: decoded.location_id || null,
        };
        // tokenben legyen: userId, role, location_id
        req.user = {
            id: decoded.userId,
            role: decoded.role || "guest",
            location_id: decoded.location_id || null,
        };
        next();
    }
    catch (err) {
        console.error("Auth hiba:", err);
        return res.status(403).json({ error: "Érvénytelen token" });
    }
}
/* 🛂 Jogosultság ellenőrzés middleware
   - pl. allowRoles("receptionist","employee","admin")
   - admin mindig átmehet
*/
function allowRoles() {
    var roles = [];
    for (var _i = 0; _i < arguments.length; _i++) {
        roles[_i] = arguments[_i];
    }
    return function (req, res, next) {
        var authReq = req;
        if (!authReq.user || !authReq.user.role) {
            return res.status(403).json({ error: "Nincs jogosultság" });
        }
        if (roles.includes(authReq.user.role) || authReq.user.role === "admin") {
            return next();
        }
        return res
            .status(403)
            .json({ error: "Nincs jogosultság ehhez a művelethez" });
    };
}
/* 📋 1) Munkalapok listázása
   - visszaadjuk a munkalap alapadatait
   - hozzácsatolva dolgozó / vendég nevet
   - telephely szűrés: csak a saját telephely (location_id),
     kivéve admin (ő mindent)
*/
router.get("/", authenticate, function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var authReq, isAdmin, params, whereClause, result, err_1;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                _a.trys.push([0, 2, , 3]);
                authReq = req;
                isAdmin = authReq.user.role === "admin";
                params = [];
                whereClause = "";
                if (!isAdmin && authReq.user.location_id) {
                    // csak a saját telephely
                    params.push(authReq.user.location_id);
                    whereClause = "WHERE w.location_id = $1";
                }
                return [4 /*yield*/, db_1.default.query("\n        SELECT \n          w.id,\n          w.created_at,\n          w.visit_status,\n          w.record_note,\n          w.total_price,\n          w.location_id,\n\n          -- \u00FCgyf\u00E9l pillanatk\u00E9p adatok a munkalapon\n          w.client_first_name,\n          w.client_last_name,\n          w.client_phone,\n          w.client_email,\n\n          -- dolgoz\u00F3\n          e.name AS employee_name\n\n        FROM work_orders w\n        LEFT JOIN employees e ON w.employee_id = e.id\n        ".concat(whereClause, "\n        ORDER BY w.created_at DESC\n        "), params)];
            case 1:
                result = _a.sent();
                res.json(result.rows);
                return [3 /*break*/, 3];
            case 2:
                err_1 = _a.sent();
                console.error("❌ Munkalap lekérdezési hiba:", err_1);
                res.status(500).json({ error: "Adatbázis hiba" });
                return [3 /*break*/, 3];
            case 3: return [2 /*return*/];
        }
    });
}); });
/* 📄 2) Egy konkrét munkalap lekérdezése részletesen
   - fejléc (státusz, megjegyzés, dolgozó)
   - szolgáltatások listája (work_order_services)
*/
router.get("/:id", authenticate, function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var id, authReq, workOrderRes, workOrder, servicesRes, err_2;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                id = req.params.id;
                authReq = req;
                _a.label = 1;
            case 1:
                _a.trys.push([1, 4, , 5]);
                return [4 /*yield*/, db_1.default.query("\n        SELECT \n          w.*,\n          e.name AS employee_name\n        FROM work_orders w\n        LEFT JOIN employees e ON w.employee_id = e.id\n        WHERE w.id = $1\n        ", [id])];
            case 2:
                workOrderRes = _a.sent();
                if (workOrderRes.rows.length === 0) {
                    res.status(404).json({ error: "Munkalap nem található" });
                    return [2 /*return*/];
                }
                workOrder = workOrderRes.rows[0];
                // jogosultság: ha nem admin, csak a saját telephely
                if (authReq.user.role !== "admin" &&
                    authReq.user.location_id &&
                    workOrder.location_id !== authReq.user.location_id) {
                    res
                        .status(403)
                        .json({ error: "Más telephely munkalapját nem érheted el" });
                    return [2 /*return*/];
                }
                return [4 /*yield*/, db_1.default.query("\n        SELECT\n          ws.id,\n          ws.service_id,\n          s.name AS service_name,\n          ws.price,\n          ws.duration_minutes\n        FROM work_order_services ws\n        LEFT JOIN services s ON s.id = ws.service_id\n        WHERE ws.work_order_id = $1\n        ", [id])];
            case 3:
                servicesRes = _a.sent();
                res.json({
                    work_order: workOrder,
                    services: servicesRes.rows,
                });
                return [3 /*break*/, 5];
            case 4:
                err_2 = _a.sent();
                console.error("❌ Munkalap részletek lekérdezési hiba:", err_2);
                res.status(500).json({ error: "Adatbázis hiba" });
                return [3 /*break*/, 5];
            case 5: return [2 /*return*/];
        }
    });
}); });
/* ➕ 3) Új munkalap létrehozása
   - ez felel meg a WorkOrderNew.tsx mentés gombjának
   - body (frontend felől):
     {
       employee_id,
       visit_status,
       record_note,
       client_first_name,
       client_last_name,
       client_phone,
       client_email,
       services: [
         { service_id, price, duration_minutes }
       ]
     }
*/
router.post("/", authenticate, allowRoles("receptionist", "employee", "admin"), function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var authReq, _a, employee_id, visit_status, record_note, client_first_name, client_last_name, client_phone, client_email, services, total_price, location_id, insertWO, newWorkOrder, workOrderId, _i, services_1, s, err_3;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0:
                authReq = req;
                _a = req.body, employee_id = _a.employee_id, visit_status = _a.visit_status, record_note = _a.record_note, client_first_name = _a.client_first_name, client_last_name = _a.client_last_name, client_phone = _a.client_phone, client_email = _a.client_email, services = _a.services;
                // alap validáció
                if (!employee_id) {
                    res
                        .status(400)
                        .json({ error: "Hiányzik a dolgozó (employee_id)" });
                    return [2 /*return*/];
                }
                if (!services || !Array.isArray(services) || services.length === 0) {
                    res
                        .status(400)
                        .json({ error: "Nincs kiválasztott szolgáltatás" });
                    return [2 /*return*/];
                }
                total_price = services.reduce(function (sum, s) { return sum + (Number(s.price) || 0); }, 0);
                location_id = authReq.user.location_id || null;
                _b.label = 1;
            case 1:
                _b.trys.push([1, 9, , 11]);
                return [4 /*yield*/, db_1.default.query("BEGIN")];
            case 2:
                _b.sent();
                return [4 /*yield*/, db_1.default.query("\n        INSERT INTO work_orders\n        (\n          employee_id,\n          visit_status,\n          record_note,\n          client_first_name,\n          client_last_name,\n          client_phone,\n          client_email,\n          total_price,\n          location_id\n        )\n        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)\n        RETURNING *\n        ", [
                        employee_id,
                        visit_status || "várakozik",
                        record_note || "",
                        client_first_name || "",
                        client_last_name || "",
                        client_phone || "",
                        client_email || "",
                        total_price,
                        location_id,
                    ])];
            case 3:
                insertWO = _b.sent();
                newWorkOrder = insertWO.rows[0];
                workOrderId = newWorkOrder.id;
                _i = 0, services_1 = services;
                _b.label = 4;
            case 4:
                if (!(_i < services_1.length)) return [3 /*break*/, 7];
                s = services_1[_i];
                return [4 /*yield*/, db_1.default.query("\n          INSERT INTO work_order_services\n          (work_order_id, service_id, price, duration_minutes)\n          VALUES ($1,$2,$3,$4)\n          ", [
                        workOrderId,
                        s.service_id,
                        s.price || 0,
                        s.duration_minutes || 0,
                    ])];
            case 5:
                _b.sent();
                _b.label = 6;
            case 6:
                _i++;
                return [3 /*break*/, 4];
            case 7: return [4 /*yield*/, db_1.default.query("COMMIT")];
            case 8:
                _b.sent();
                res.status(201).json({
                    success: true,
                    work_order: newWorkOrder,
                });
                return [3 /*break*/, 11];
            case 9:
                err_3 = _b.sent();
                return [4 /*yield*/, db_1.default.query("ROLLBACK")];
            case 10:
                _b.sent();
                console.error("❌ Munkalap mentési hiba:", err_3);
                res.status(500).json({ error: "Mentés sikertelen" });
                return [3 /*break*/, 11];
            case 11: return [2 /*return*/];
        }
    });
}); });
/* ✏️ 4) Munkalap módosítása (státusz, megjegyzés stb.)
   - csak admin / receptionist / employee
   - telephely ellenőrzés
*/
router.put("/:id", authenticate, allowRoles("receptionist", "employee", "admin"), function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var id, _a, visit_status, record_note, authReq, checkRes, row, result, err_4;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0:
                id = req.params.id;
                _a = req.body, visit_status = _a.visit_status, record_note = _a.record_note;
                authReq = req;
                _b.label = 1;
            case 1:
                _b.trys.push([1, 4, , 5]);
                return [4 /*yield*/, db_1.default.query("SELECT location_id FROM work_orders WHERE id = $1", [id])];
            case 2:
                checkRes = _b.sent();
                if (checkRes.rows.length === 0) {
                    res.status(404).json({ error: "Munkalap nem található" });
                    return [2 /*return*/];
                }
                row = checkRes.rows[0];
                if (authReq.user.role !== "admin" &&
                    authReq.user.location_id &&
                    row.location_id !== authReq.user.location_id) {
                    res.status(403).json({
                        error: "Más telephely munkalapját nem módosíthatod",
                    });
                    return [2 /*return*/];
                }
                return [4 /*yield*/, db_1.default.query("\n        UPDATE work_orders\n        SET visit_status = COALESCE($1, visit_status),\n            record_note  = COALESCE($2, record_note)\n        WHERE id = $3\n        RETURNING *\n        ", [visit_status || null, record_note || null, id])];
            case 3:
                result = _b.sent();
                res.json({
                    success: true,
                    work_order: result.rows[0],
                });
                return [3 /*break*/, 5];
            case 4:
                err_4 = _b.sent();
                console.error("❌ Munkalap módosítási hiba:", err_4);
                res.status(500).json({ error: "Frissítés sikertelen" });
                return [3 /*break*/, 5];
            case 5: return [2 /*return*/];
        }
    });
}); });
/* ❌ 5) Munkalap törlése
   - csak admin és receptionist törölhessen (a sima employee ne törölje teljesen)
   - telephely ellenőrzés
*/
router.delete("/:id", authenticate, allowRoles("receptionist", "admin"), function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var id, authReq, checkRes, row, err_5;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                id = req.params.id;
                authReq = req;
                _a.label = 1;
            case 1:
                _a.trys.push([1, 7, , 9]);
                return [4 /*yield*/, db_1.default.query("SELECT location_id FROM work_orders WHERE id = $1", [id])];
            case 2:
                checkRes = _a.sent();
                if (checkRes.rows.length === 0) {
                    res.status(404).json({ error: "Munkalap nem található" });
                    return [2 /*return*/];
                }
                row = checkRes.rows[0];
                if (authReq.user.role !== "admin" &&
                    authReq.user.location_id &&
                    row.location_id !== authReq.user.location_id) {
                    res.status(403).json({
                        error: "Más telephely munkalapját nem törölheted",
                    });
                    return [2 /*return*/];
                }
                // töröljük a munkalapot és a sorait
                return [4 /*yield*/, db_1.default.query("BEGIN")];
            case 3:
                // töröljük a munkalapot és a sorait
                _a.sent();
                return [4 /*yield*/, db_1.default.query("DELETE FROM work_order_services WHERE work_order_id = $1", [id])];
            case 4:
                _a.sent();
                return [4 /*yield*/, db_1.default.query("DELETE FROM work_orders WHERE id = $1", [id])];
            case 5:
                _a.sent();
                return [4 /*yield*/, db_1.default.query("COMMIT")];
            case 6:
                _a.sent();
                res.json({ success: true });
                return [3 /*break*/, 9];
            case 7:
                err_5 = _a.sent();
                return [4 /*yield*/, db_1.default.query("ROLLBACK")];
            case 8:
                _a.sent();
                console.error("❌ Munkalap törlés hiba:", err_5);
                res.status(500).json({ error: "Törlés sikertelen" });
                return [3 /*break*/, 9];
            case 9: return [2 /*return*/];
        }
    });
}); });
exports.default = router;
