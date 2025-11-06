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
var db_1 = require("./db");
var bcrypt_1 = require("bcrypt");
var crypto_1 = require("crypto");
var nodemailer_1 = require("nodemailer");
var jsonwebtoken_1 = require("jsonwebtoken");
var router = express_1.default.Router();
// 💌 Email küldő beállítás (Gmail vagy SMTP)
var transporter = nodemailer_1.default.createTransport({
    service: "gmail",
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
});
// 🧩 1️⃣ Első lépés: email + jelszó ellenőrzés, kód generálás
router.post("/api/login", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, email, password, userResult, user, valid, code, err_1;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0:
                _a = req.body, email = _a.email, password = _a.password;
                _b.label = 1;
            case 1:
                _b.trys.push([1, 6, , 7]);
                return [4 /*yield*/, db_1.default.query("SELECT * FROM users WHERE email = $1", [email])];
            case 2:
                userResult = _b.sent();
                if (userResult.rows.length === 0)
                    return [2 /*return*/, res.status(401).json({ error: "Nincs ilyen felhasználó" })];
                user = userResult.rows[0];
                return [4 /*yield*/, bcrypt_1.default.compare(password, user.password)];
            case 3:
                valid = _b.sent();
                if (!valid)
                    return [2 /*return*/, res.status(401).json({ error: "Hibás jelszó" })];
                code = crypto_1.default.randomInt(100000, 999999).toString();
                // ideiglenesen mentjük az adatbázisba
                return [4 /*yield*/, db_1.default.query("UPDATE users SET login_code = $1 WHERE email = $2", [code, email])];
            case 4:
                // ideiglenesen mentjük az adatbázisba
                _b.sent();
                // 📩 e-mail küldése
                return [4 /*yield*/, transporter.sendMail({
                        from: "\"Kleoszalon\" <".concat(process.env.EMAIL_USER, ">"),
                        to: email,
                        subject: "Kleoszalon belépési kód",
                        text: "Az \u00D6n bel\u00E9p\u00E9si k\u00F3dja: ".concat(code, "\n\nA k\u00F3d 5 percig \u00E9rv\u00E9nyes."),
                    })];
            case 5:
                // 📩 e-mail küldése
                _b.sent();
                res.json({ message: "Hitelesítési kód elküldve az e-mail címre" });
                return [3 /*break*/, 7];
            case 6:
                err_1 = _b.sent();
                console.error("Login hiba:", err_1);
                res.status(500).json({ error: "Szerver hiba" });
                return [3 /*break*/, 7];
            case 7: return [2 /*return*/];
        }
    });
}); });
// 🧠 2️⃣ Második lépés: kód ellenőrzése
router.post("/api/verify-code", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, email, code, result, user, token, err_2;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0:
                _a = req.body, email = _a.email, code = _a.code;
                _b.label = 1;
            case 1:
                _b.trys.push([1, 4, , 5]);
                return [4 /*yield*/, db_1.default.query("SELECT * FROM users WHERE email = $1", [email])];
            case 2:
                result = _b.sent();
                if (result.rows.length === 0)
                    return [2 /*return*/, res.status(404).json({ error: "Felhasználó nem található" })];
                user = result.rows[0];
                if (user.login_code !== code)
                    return [2 /*return*/, res.status(401).json({ error: "Érvénytelen kód" })];
                token = jsonwebtoken_1.default.sign({ id: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET, { expiresIn: "1h" });
                // töröljük a kódot
                return [4 /*yield*/, db_1.default.query("UPDATE users SET login_code = NULL WHERE email = $1", [email])];
            case 3:
                // töröljük a kódot
                _b.sent();
                res.json({ message: "Sikeres hitelesítés", token: token });
                return [3 /*break*/, 5];
            case 4:
                err_2 = _b.sent();
                console.error("Verify code hiba:", err_2);
                res.status(500).json({ error: "Szerver hiba" });
                return [3 /*break*/, 5];
            case 5: return [2 /*return*/];
        }
    });
}); });
exports.default = router;
