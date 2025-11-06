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
// === GET ALL EVENTS ===
router.get("/", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var result, err_1;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                _a.trys.push([0, 2, , 3]);
                return [4 /*yield*/, db_1.default.query("\n      SELECT e.*, emp.name AS employee_name, c.name AS client_name, s.name AS service_name\n      FROM events e\n      LEFT JOIN employees emp ON emp.id = e.employee_id\n      LEFT JOIN clients c ON c.id = e.client_id\n      LEFT JOIN services s ON s.id = e.service_id\n      ORDER BY e.start_time ASC\n    ")];
            case 1:
                result = _a.sent();
                res.json(result.rows);
                return [3 /*break*/, 3];
            case 2:
                err_1 = _a.sent();
                console.error("❌ Error fetching events:", err_1);
                res.status(500).json({ error: "Error fetching events" });
                return [3 /*break*/, 3];
            case 3: return [2 /*return*/];
        }
    });
}); });
// === GET SINGLE EVENT ===
router.get("/:id", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var id, result, err_2;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                id = req.params.id;
                _a.label = 1;
            case 1:
                _a.trys.push([1, 3, , 4]);
                return [4 /*yield*/, db_1.default.query("SELECT * FROM events WHERE id = $1", [id])];
            case 2:
                result = _a.sent();
                res.json(result.rows[0]);
                return [3 /*break*/, 4];
            case 3:
                err_2 = _a.sent();
                console.error("❌ Error fetching event:", err_2);
                res.status(500).json({ error: "Error fetching event" });
                return [3 /*break*/, 4];
            case 4: return [2 /*return*/];
        }
    });
}); });
// === CREATE NEW EVENT ===
router.post("/", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, title, employee_id, client_id, service_id, start_time, end_time, status, price, payment_method, notes, result, err_3;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0:
                _a = req.body, title = _a.title, employee_id = _a.employee_id, client_id = _a.client_id, service_id = _a.service_id, start_time = _a.start_time, end_time = _a.end_time, status = _a.status, price = _a.price, payment_method = _a.payment_method, notes = _a.notes;
                _b.label = 1;
            case 1:
                _b.trys.push([1, 3, , 4]);
                return [4 /*yield*/, db_1.default.query("INSERT INTO events \n       (title, employee_id, client_id, service_id, start_time, end_time, status, price, payment_method, notes)\n       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)\n       RETURNING *", [title, employee_id, client_id, service_id, start_time, end_time, status, price, payment_method, notes])];
            case 2:
                result = _b.sent();
                res.json(result.rows[0]);
                return [3 /*break*/, 4];
            case 3:
                err_3 = _b.sent();
                console.error("❌ Error creating event:", err_3);
                res.status(500).json({ error: "Error creating event" });
                return [3 /*break*/, 4];
            case 4: return [2 /*return*/];
        }
    });
}); });
// === UPDATE EVENT ===
router.put("/:id", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var id, _a, title, employee_id, client_id, service_id, start_time, end_time, status, price, payment_method, notes, result, err_4;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0:
                id = req.params.id;
                _a = req.body, title = _a.title, employee_id = _a.employee_id, client_id = _a.client_id, service_id = _a.service_id, start_time = _a.start_time, end_time = _a.end_time, status = _a.status, price = _a.price, payment_method = _a.payment_method, notes = _a.notes;
                _b.label = 1;
            case 1:
                _b.trys.push([1, 3, , 4]);
                return [4 /*yield*/, db_1.default.query("UPDATE events SET \n        title=$1, employee_id=$2, client_id=$3, service_id=$4, \n        start_time=$5, end_time=$6, status=$7, price=$8, payment_method=$9, notes=$10\n       WHERE id=$11 RETURNING *", [title, employee_id, client_id, service_id, start_time, end_time, status, price, payment_method, notes, id])];
            case 2:
                result = _b.sent();
                res.json(result.rows[0]);
                return [3 /*break*/, 4];
            case 3:
                err_4 = _b.sent();
                console.error("❌ Error updating event:", err_4);
                res.status(500).json({ error: "Error updating event" });
                return [3 /*break*/, 4];
            case 4: return [2 /*return*/];
        }
    });
}); });
// === DELETE EVENT ===
router.delete("/:id", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var id, err_5;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                id = req.params.id;
                _a.label = 1;
            case 1:
                _a.trys.push([1, 3, , 4]);
                return [4 /*yield*/, db_1.default.query("DELETE FROM events WHERE id=$1", [id])];
            case 2:
                _a.sent();
                res.sendStatus(204);
                return [3 /*break*/, 4];
            case 3:
                err_5 = _a.sent();
                console.error("❌ Error deleting event:", err_5);
                res.status(500).json({ error: "Error deleting event" });
                return [3 /*break*/, 4];
            case 4: return [2 /*return*/];
        }
    });
}); });
exports.default = router;
