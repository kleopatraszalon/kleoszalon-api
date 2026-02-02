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
var router = (0, express_1.Router)();
router.get("/", function (_req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var client, daily_revenue, monthly_revenue, total_clients, active_appointments, low_stock_count, chartData, error_1;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, db_1.default.connect()];
            case 1:
                client = _a.sent();
                _a.label = 2;
            case 2:
                _a.trys.push([2, 9, 10, 11]);
                return [4 /*yield*/, client.query("\n        SELECT COALESCE(SUM(amount),0) AS daily_revenue \n        FROM financial_transaction \n        WHERE DATE(created_at) = CURRENT_DATE\n      ")];
            case 3:
                daily_revenue = (_a.sent()).rows[0].daily_revenue;
                return [4 /*yield*/, client.query("\n        SELECT COALESCE(SUM(amount),0) AS monthly_revenue \n        FROM financial_transaction \n        WHERE DATE_PART('month', created_at) = DATE_PART('month', CURRENT_DATE)\n      ")];
            case 4:
                monthly_revenue = (_a.sent()).rows[0].monthly_revenue;
                return [4 /*yield*/, client.query("SELECT COUNT(*) AS total_clients FROM clients")];
            case 5:
                total_clients = (_a.sent()).rows[0].total_clients;
                return [4 /*yield*/, client.query("SELECT COUNT(*) AS active_appointments FROM bookings WHERE status = 'active'")];
            case 6:
                active_appointments = (_a.sent()).rows[0].active_appointments;
                return [4 /*yield*/, client.query("SELECT COUNT(*) AS low_stock_count FROM stock WHERE quantity < 5")];
            case 7:
                low_stock_count = (_a.sent()).rows[0].low_stock_count;
                return [4 /*yield*/, client.query("\n        SELECT TO_CHAR(created_at, 'MM-DD') AS date, SUM(amount) AS revenue\n        FROM financial_transaction\n        WHERE created_at > NOW() - INTERVAL '7 days'\n        GROUP BY date\n        ORDER BY date\n      ")];
            case 8:
                chartData = (_a.sent()).rows;
                res.json({
                    stats: {
                        dailyRevenue: Number(daily_revenue),
                        monthlyRevenue: Number(monthly_revenue),
                        totalClients: Number(total_clients),
                        activeAppointments: Number(active_appointments),
                        lowStockCount: Number(low_stock_count),
                    },
                    chartData: chartData,
                });
                return [3 /*break*/, 11];
            case 9:
                error_1 = _a.sent();
                console.error("❌ Dashboard query failed:", error_1);
                res.status(500).json({ error: "Dashboard lekérdezés sikertelen" });
                return [3 /*break*/, 11];
            case 10:
                client.release();
                return [7 /*endfinally*/];
            case 11: return [2 /*return*/];
        }
    });
}); });
exports.default = router;
