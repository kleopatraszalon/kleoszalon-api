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
var router = express_1.default.Router();
// Összes szerepkör lekérése
router.get("/", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var result;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, db_1.default.query("SELECT * FROM roles ORDER BY level DESC")];
            case 1:
                result = _a.sent();
                res.json(result.rows);
                return [2 /*return*/];
        }
    });
}); });
// Új szerepkör létrehozása
router.post("/", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, name, description, level, result, err_1;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0:
                _a = req.body, name = _a.name, description = _a.description, level = _a.level;
                _b.label = 1;
            case 1:
                _b.trys.push([1, 3, , 4]);
                return [4 /*yield*/, db_1.default.query("INSERT INTO roles (name, description, level) VALUES ($1, $2, $3) RETURNING *", [name, description || "", level || 1])];
            case 2:
                result = _b.sent();
                res.json({ success: true, role: result.rows[0] });
                return [3 /*break*/, 4];
            case 3:
                err_1 = _b.sent();
                console.error("❌ Hiba a szerepkör létrehozásakor:", err_1);
                res.status(500).json({ error: "Adatbázis hiba" });
                return [3 /*break*/, 4];
            case 4: return [2 /*return*/];
        }
    });
}); });
// Jogosultságok lekérése egy szerepkörhöz
router.get("/:roleId/permissions", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var roleId, result;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                roleId = req.params.roleId;
                return [4 /*yield*/, db_1.default.query("SELECT rp.id, m.name AS menu, rp.can_view, rp.can_edit, rp.can_delete\n     FROM role_permissions rp\n     JOIN menus m ON rp.menu_id = m.id\n     WHERE rp.role_id = $1\n     ORDER BY m.sort_order", [roleId])];
            case 1:
                result = _a.sent();
                res.json(result.rows);
                return [2 /*return*/];
        }
    });
}); });
// Jogosultságok mentése
router.put("/:roleId/permissions", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var roleId, updates, _i, updates_1, u, err_2;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                roleId = req.params.roleId;
                updates = req.body;
                _a.label = 1;
            case 1:
                _a.trys.push([1, 6, , 7]);
                _i = 0, updates_1 = updates;
                _a.label = 2;
            case 2:
                if (!(_i < updates_1.length)) return [3 /*break*/, 5];
                u = updates_1[_i];
                return [4 /*yield*/, db_1.default.query("UPDATE role_permissions\n         SET can_view=$1, can_edit=$2, can_delete=$3\n         WHERE id=$4 AND role_id=$5", [u.can_view, u.can_edit, u.can_delete, u.id, roleId])];
            case 3:
                _a.sent();
                _a.label = 4;
            case 4:
                _i++;
                return [3 /*break*/, 2];
            case 5:
                res.json({ success: true });
                return [3 /*break*/, 7];
            case 6:
                err_2 = _a.sent();
                console.error("❌ Hiba a jogosultság mentésénél:", err_2);
                res.status(500).json({ error: "Adatbázis hiba" });
                return [3 /*break*/, 7];
            case 7: return [2 /*return*/];
        }
    });
}); });
exports.default = router;
