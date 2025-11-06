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
// backend/src/routes/employees.ts
var express_1 = require("express");
var db_1 = require("../db");
var jsonwebtoken_1 = require("jsonwebtoken");
var bcrypt_1 = require("bcrypt");
var router = express_1.default.Router();
/* ==========================================================
   AUTH MIDDLEWARE
   - Authorization: Bearer <token>
   - token payload pl.: { user_id: "...", role: "admin" }
========================================================== */
function authenticate(req, res, next) {
    var auth = req.headers.authorization;
    if (!auth) {
        return res.status(401).json({ error: "Nincs token" });
    }
    try {
        var token = auth.split(" ")[1];
        var decoded = jsonwebtoken_1.default.verify(token, process.env.JWT_SECRET);
        req.user = decoded; // { user_id, role, ... }
        next();
    }
    catch (err) {
        console.error("JWT hiba:", err);
        return res.status(403).json({ error: "Érvénytelen token" });
    }
}
/* ==========================================================
   ROLE CHECK: lista lekéréséhez
   - admin
   - receptionist
   - employee (szakember)
   vendég NE lássa
========================================================== */
function authorizeEmployeeList(req, res, next) {
    var _a;
    var role = (_a = req.user) === null || _a === void 0 ? void 0 : _a.role;
    if (!role) {
        return res
            .status(403)
            .json({ error: "Nincs jogosultság (nincs szerepkör)" });
    }
    var allowed = ["admin", "receptionist", "employee"];
    if (!allowed.includes(role)) {
        return res
            .status(403)
            .json({ error: "Nincs jogosultság ehhez az erőforráshoz" });
    }
    next();
}
/* ==========================================================
   ROLE CHECK: adott dolgozó részletes adata
   - admin, receptionist: mindent láthat
   - employee: csak saját magát
========================================================== */
function authorizeEmployeeDetails(req, res, next) {
    var _a, _b;
    var role = (_a = req.user) === null || _a === void 0 ? void 0 : _a.role;
    var currentUserId = (_b = req.user) === null || _b === void 0 ? void 0 : _b.user_id; // tedd bele ezt a tokenbe
    var requestedId = req.params.id;
    if (!role) {
        return res
            .status(403)
            .json({ error: "Nincs jogosultság (nincs szerepkör)" });
    }
    if (role === "admin" || role === "receptionist") {
        return next();
    }
    if (role === "employee") {
        if (currentUserId === requestedId) {
            return next();
        }
        else {
            return res
                .status(403)
                .json({ error: "Nem férhetsz hozzá más dolgozó adatlapjához" });
        }
    }
    return res
        .status(403)
        .json({ error: "Nincs jogosultság ehhez az erőforráshoz" });
}
/* ==========================================================
   ROLE CHECK: admin-only műveletek
   - státuszváltás
   - új dolgozó létrehozás
   - credentials módosítás
   - roles módosítás
========================================================== */
function requireAdmin(req, res, next) {
    var _a;
    if (((_a = req.user) === null || _a === void 0 ? void 0 : _a.role) !== "admin") {
        return res.status(403).json({ error: "Nincs jogosultság (csak admin)." });
    }
    next();
}
/* ==========================================================
   GET /api/employees
   Dolgozók listája.
   query param: ?include_inactive=1   -> akkor NEM szűrünk active=true-re
   FRONTEND: EmployeesList.tsx ezt használja
========================================================== */
router.get("/", authenticate, authorizeEmployeeList, function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var includeInactive, result, err_1;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                _a.trys.push([0, 2, , 3]);
                includeInactive = req.query.include_inactive === "1";
                return [4 /*yield*/, db_1.default.query("\n      SELECT\n        e.id,\n        e.full_name,\n        e.first_name,\n        e.last_name,\n        e.birth_date,\n        e.qualification,\n        e.monthly_wage,\n        e.hourly_wage,\n        e.photo_url,\n        e.location_id,\n        e.active,\n        l.name AS location_name\n      FROM employees e\n      LEFT JOIN locations l ON l.id = e.location_id\n      ".concat(includeInactive ? "" : "WHERE e.active = true", "\n      ORDER BY e.last_name, e.first_name;\n      "))];
            case 1:
                result = _a.sent();
                return [2 /*return*/, res.json(result.rows)];
            case 2:
                err_1 = _a.sent();
                console.error("❌ /api/employees hiba:", err_1);
                return [2 /*return*/, res
                        .status(500)
                        .json({ error: "Adatbázis hiba a dolgozók listázásánál" })];
            case 3: return [2 /*return*/];
        }
    });
}); });
/* ==========================================================
   GET /api/employees/:id
   Egy dolgozó teljes profilja (HR adatlap)
========================================================== */
router.get("/:id", authenticate, authorizeEmployeeDetails, function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var id, result, err_2;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                id = req.params.id;
                _a.label = 1;
            case 1:
                _a.trys.push([1, 3, , 4]);
                return [4 /*yield*/, db_1.default.query("\n      SELECT\n        e.id,\n        e.location_id,\n        l.name AS location_name,\n\n        e.full_name,\n        e.first_name,\n        e.last_name,\n        e.active,\n\n        e.role,                 -- JSON-ben t\u00E1rolt szerepk\u00F6rlista pl. [\"admin\",\"recepci\u00F3s\"]\n\n        e.birth_name,\n        e.birth_date,\n        e.birth_country,\n        e.birth_region,\n        e.birth_city,\n        e.nationality,\n        e.gender,\n        e.mother_name,\n\n        e.taj_number,\n        e.tax_id,\n\n        e.qualification,\n        e.work_schedule_type,\n        e.work_schedule_type_id,\n        e.employment_type,\n        e.employment_type_id,\n\n        e.hourly_rate,\n        e.hourly_wage,\n        e.monthly_wage,\n\n        e.photo_url,\n        e.bio,\n        e.color,\n\n        e.department_id,\n        e.position_id,\n\n        e.notes,\n        e.review_notes,\n        e.traits,\n\n        e.created_at,\n\n        e.login_name\n      FROM employees e\n      LEFT JOIN locations l ON l.id = e.location_id\n      WHERE e.id = $1\n      LIMIT 1;\n      ", [id])];
            case 2:
                result = _a.sent();
                if (result.rows.length === 0) {
                    return [2 /*return*/, res.status(404).json({ error: "Dolgozó nem található" })];
                }
                return [2 /*return*/, res.json(result.rows[0])];
            case 3:
                err_2 = _a.sent();
                console.error("❌ /api/employees/:id hiba:", err_2);
                return [2 /*return*/, res
                        .status(500)
                        .json({ error: "Adatbázis hiba a dolgozó lekérésénél" })];
            case 4: return [2 /*return*/];
        }
    });
}); });
/* ==========================================================
   POST /api/employees
   ÚJ dolgozó létrehozása
========================================================== */
router.post("/", authenticate, requireAdmin, function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, first_name, last_name, full_name, phone, email, birth_date, location_id, login_name, plain_password, roles, active, computedFullName, hash, insertResult, err_3;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0:
                _a = req.body, first_name = _a.first_name, last_name = _a.last_name, full_name = _a.full_name, phone = _a.phone, email = _a.email, birth_date = _a.birth_date, location_id = _a.location_id, login_name = _a.login_name, plain_password = _a.plain_password, roles = _a.roles, active = _a.active;
                computedFullName = full_name ||
                    "".concat((last_name || "").trim(), " ").concat((first_name || "").trim()).trim();
                if (!computedFullName ||
                    !phone ||
                    !login_name ||
                    !plain_password ||
                    !location_id) {
                    return [2 /*return*/, res.status(400).json({
                            error: "Kötelező mező hiányzik (név / telefon / login / jelszó / telephely).",
                        })];
                }
                _b.label = 1;
            case 1:
                _b.trys.push([1, 4, , 5]);
                return [4 /*yield*/, bcrypt_1.default.hash(plain_password, 10)];
            case 2:
                hash = _b.sent();
                return [4 /*yield*/, db_1.default.query("\n      INSERT INTO employees (\n        full_name,\n        first_name,\n        last_name,\n        phone,\n        email,\n        birth_date,\n        login_name,\n        password_hash,\n        location_id,\n        role,\n        active\n      )\n      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)\n      RETURNING *\n      ", [
                        computedFullName,
                        first_name || null,
                        last_name || null,
                        phone,
                        email || null,
                        birth_date || null,
                        login_name,
                        hash,
                        location_id,
                        JSON.stringify(roles || []),
                        active === false ? false : true,
                    ])];
            case 3:
                insertResult = _b.sent();
                return [2 /*return*/, res.status(201).json(insertResult.rows[0])];
            case 4:
                err_3 = _b.sent();
                console.error("❌ Új dolgozó mentési hiba:", err_3);
                return [2 /*return*/, res.status(500).json({ error: "Adatbázis hiba létrehozáskor" })];
            case 5: return [2 /*return*/];
        }
    });
}); });
/* ==========================================================
   POST /api/employees/credentials
   Minimál user létrehozása
========================================================== */
router.post("/credentials", authenticate, requireAdmin, function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, login_name, plain_password, hash, r, err_4;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0:
                _a = req.body, login_name = _a.login_name, plain_password = _a.plain_password;
                if (!login_name || !plain_password) {
                    return [2 /*return*/, res.status(400).json({
                            error: "login_name és plain_password kötelező.",
                        })];
                }
                _b.label = 1;
            case 1:
                _b.trys.push([1, 4, , 5]);
                return [4 /*yield*/, bcrypt_1.default.hash(plain_password, 10)];
            case 2:
                hash = _b.sent();
                return [4 /*yield*/, db_1.default.query("\n        INSERT INTO employees (login_name, password_hash, active)\n        VALUES ($1,$2,true)\n        RETURNING id, login_name, active\n        ", [login_name.trim(), hash])];
            case 3:
                r = _b.sent();
                return [2 /*return*/, res.status(201).json(r.rows[0])];
            case 4:
                err_4 = _b.sent();
                console.error("❌ Minimál user létrehozás hiba:", err_4);
                return [2 /*return*/, res
                        .status(500)
                        .json({ error: "Adatbázis hiba user létrehozáskor." })];
            case 5: return [2 /*return*/];
        }
    });
}); });
/* ==========================================================
   PATCH /api/employees/:id/active
   Dolgozó aktiválása / inaktiválása
========================================================== */
router.patch("/:id/active", authenticate, requireAdmin, function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var id, active, result, err_5;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                id = req.params.id;
                active = req.body.active;
                if (typeof active !== "boolean") {
                    return [2 /*return*/, res.status(400).json({
                            error: "Hiányzik vagy hibás az 'active' mező (boolean kell).",
                        })];
                }
                _a.label = 1;
            case 1:
                _a.trys.push([1, 3, , 4]);
                return [4 /*yield*/, db_1.default.query("\n        UPDATE employees\n        SET active = $1\n        WHERE id = $2\n        RETURNING id, full_name, active\n        ", [active, id])];
            case 2:
                result = _a.sent();
                if (result.rows.length === 0) {
                    return [2 /*return*/, res.status(404).json({ error: "Nincs ilyen dolgozó." })];
                }
                return [2 /*return*/, res.json({
                        success: true,
                        employee: result.rows[0],
                    })];
            case 3:
                err_5 = _a.sent();
                console.error("❌ Dolgozó státusz frissítési hiba:", err_5);
                return [2 /*return*/, res
                        .status(500)
                        .json({ error: "Adatbázis hiba státusz módosításkor." })];
            case 4: return [2 /*return*/];
        }
    });
}); });
/* ==========================================================
   PATCH /api/employees/:id/credentials
   Belépési adatok módosítása (admin)
========================================================== */
router.patch("/:id/credentials", authenticate, requireAdmin, function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var id, _a, login_name, plain_password, queryText, queryParams, hash, upd, err_6;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0:
                id = req.params.id;
                _a = req.body, login_name = _a.login_name, plain_password = _a.plain_password;
                if (!login_name || !login_name.trim()) {
                    return [2 /*return*/, res
                            .status(400)
                            .json({ error: "A login_name kötelező a frissítéshez." })];
                }
                _b.label = 1;
            case 1:
                _b.trys.push([1, 5, , 6]);
                queryText = "\n        UPDATE employees\n        SET login_name = $1\n        WHERE id = $2\n        RETURNING id, full_name, login_name\n      ";
                queryParams = [login_name.trim(), id];
                if (!(plain_password && plain_password.trim())) return [3 /*break*/, 3];
                return [4 /*yield*/, bcrypt_1.default.hash(plain_password.trim(), 10)];
            case 2:
                hash = _b.sent();
                queryText = "\n          UPDATE employees\n          SET login_name = $1,\n              password_hash = $2\n          WHERE id = $3\n          RETURNING id, full_name, login_name\n        ";
                queryParams = [login_name.trim(), hash, id];
                _b.label = 3;
            case 3: return [4 /*yield*/, db_1.default.query(queryText, queryParams)];
            case 4:
                upd = _b.sent();
                if (upd.rows.length === 0) {
                    return [2 /*return*/, res.status(404).json({ error: "Dolgozó nem található." })];
                }
                return [2 /*return*/, res.json({
                        success: true,
                        employee: upd.rows[0],
                    })];
            case 5:
                err_6 = _b.sent();
                console.error("❌ Belépési adatok frissítése hiba:", err_6);
                return [2 /*return*/, res.status(500).json({
                        error: "Adatbázis hiba belépési adatok frissítésekor.",
                    })];
            case 6: return [2 /*return*/];
        }
    });
}); });
/* ==========================================================
   PATCH /api/employees/:id/roles
   Szerepkörök módosítása (admin)
========================================================== */
router.patch("/:id/roles", authenticate, requireAdmin, function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var id, roles, upd, err_7;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                id = req.params.id;
                roles = req.body.roles;
                if (!Array.isArray(roles)) {
                    return [2 /*return*/, res
                            .status(400)
                            .json({ error: "A roles mező kötelező és tömb kell legyen." })];
                }
                _a.label = 1;
            case 1:
                _a.trys.push([1, 3, , 4]);
                return [4 /*yield*/, db_1.default.query("\n      UPDATE employees\n      SET role = $1\n      WHERE id = $2\n      RETURNING id, full_name, role\n      ", [JSON.stringify(roles), id])];
            case 2:
                upd = _a.sent();
                if (upd.rows.length === 0) {
                    return [2 /*return*/, res.status(404).json({ error: "Dolgozó nem található." })];
                }
                return [2 /*return*/, res.json({
                        success: true,
                        employee: upd.rows[0],
                    })];
            case 3:
                err_7 = _a.sent();
                console.error("❌ Jogosultságok frissítése hiba:", err_7);
                return [2 /*return*/, res.status(500).json({
                        error: "Adatbázis hiba jogosultság frissítésekor.",
                    })];
            case 4: return [2 /*return*/];
        }
    });
}); });
exports.default = router;
