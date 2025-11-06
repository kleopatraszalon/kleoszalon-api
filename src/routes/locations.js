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
// src/routes/locations.ts
var express_1 = require("express");
var db_1 = require("../db");
var router = express_1.default.Router();
// ===========================================================
// 🏢 SZALONOK LEKÉRÉSE
// ===========================================================
router.get("/", function (_req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var result, err_1;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                _a.trys.push([0, 2, , 3]);
                return [4 /*yield*/, db_1.default.query("SELECT id, name, address, city, phone, email, is_active FROM locations WHERE is_active = true ORDER BY city, name;")];
            case 1:
                result = _a.sent();
                res.json(result.rows);
                return [3 /*break*/, 3];
            case 2:
                err_1 = _a.sent();
                console.error("❌ Szalon lekérési hiba:", err_1);
                res.status(500).json({ error: "Nem sikerült lekérni a szalonokat" });
                return [3 /*break*/, 3];
            case 3: return [2 /*return*/];
        }
    });
}); });
// ===========================================================
// ➕ ÚJ SZALON HOZZÁADÁSA
// ===========================================================
router.post("/", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, name, address, city, phone, email, result, err_2;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0:
                _a = req.body, name = _a.name, address = _a.address, city = _a.city, phone = _a.phone, email = _a.email;
                if (!name || !city)
                    return [2 /*return*/, res.status(400).json({ error: "Név és város megadása kötelező" })];
                _b.label = 1;
            case 1:
                _b.trys.push([1, 3, , 4]);
                return [4 /*yield*/, db_1.default.query("INSERT INTO locations (name, address, city, phone, email, is_active)\n       VALUES ($1, $2, $3, $4, $5, TRUE)\n       RETURNING *", [name, address, city, phone, email])];
            case 2:
                result = _b.sent();
                res.status(201).json(result.rows[0]);
                return [3 /*break*/, 4];
            case 3:
                err_2 = _b.sent();
                console.error("❌ Szalon hozzáadási hiba:", err_2);
                res.status(500).json({ error: "Nem sikerült hozzáadni a szalont" });
                return [3 /*break*/, 4];
            case 4: return [2 /*return*/];
        }
    });
}); });
// ===========================================================
// ✏️ SZALON MÓDOSÍTÁS
// ===========================================================
router.put("/:id", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var id, _a, name, address, city, phone, email, is_active, result, err_3;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0:
                id = req.params.id;
                _a = req.body, name = _a.name, address = _a.address, city = _a.city, phone = _a.phone, email = _a.email, is_active = _a.is_active;
                _b.label = 1;
            case 1:
                _b.trys.push([1, 3, , 4]);
                return [4 /*yield*/, db_1.default.query("UPDATE locations\n       SET name=$1, address=$2, city=$3, phone=$4, email=$5, is_active=$6\n       WHERE id=$7\n       RETURNING *", [name, address, city, phone, email, is_active, id])];
            case 2:
                result = _b.sent();
                if (result.rows.length === 0)
                    return [2 /*return*/, res.status(404).json({ error: "Szalon nem található" })];
                res.json(result.rows[0]);
                return [3 /*break*/, 4];
            case 3:
                err_3 = _b.sent();
                console.error("❌ Szalon módosítási hiba:", err_3);
                res.status(500).json({ error: "Nem sikerült módosítani a szalont" });
                return [3 /*break*/, 4];
            case 4: return [2 /*return*/];
        }
    });
}); });
// ===========================================================
// ❌ SZALON TÖRLÉS (deaktiválás)
// ===========================================================
router.delete("/:id", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var id, err_4;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                id = req.params.id;
                _a.label = 1;
            case 1:
                _a.trys.push([1, 3, , 4]);
                return [4 /*yield*/, db_1.default.query("UPDATE locations SET is_active = false WHERE id = $1", [id])];
            case 2:
                _a.sent();
                res.json({ message: "Szalon sikeresen deaktiválva" });
                return [3 /*break*/, 4];
            case 3:
                err_4 = _a.sent();
                console.error("❌ Szalon törlési hiba:", err_4);
                res.status(500).json({ error: "Nem sikerült törölni a szalont" });
                return [3 /*break*/, 4];
            case 4: return [2 /*return*/];
        }
    });
}); });
exports.default = router;
