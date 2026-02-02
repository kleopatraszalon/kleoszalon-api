"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config(); // Betölti a .env fájl tartalmát
console.log("✅ .env fájl beolvasva:");
console.log("PORT =", process.env.PORT);
console.log("DATABASE_URL =", process.env.DATABASE_URL);
const { DATABASE_URL, JWT_SECRET } = process.env;
console.log("DB:", DATABASE_URL);
console.log("JWT:", JWT_SECRET);
