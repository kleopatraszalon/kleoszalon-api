"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var dotenv_1 = require("dotenv");
dotenv_1.default.config(); // Betölti a .env fájl tartalmát
console.log("✅ .env fájl beolvasva:");
console.log("PORT =", process.env.PORT);
console.log("DATABASE_URL =", process.env.DATABASE_URL);
var _a = process.env, DATABASE_URL = _a.DATABASE_URL, JWT_SECRET = _a.JWT_SECRET;
console.log("DB:", DATABASE_URL);
console.log("JWT:", JWT_SECRET);
