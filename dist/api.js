"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const axios_1 = __importDefault(require("axios"));
const base = import.meta.env?.VITE_API_URL?.replace(/\/$/, "") ||
    window.location.origin;
const api = axios_1.default.create({
    baseURL: `${base}/api`,
    withCredentials: true,
    headers: { "Content-Type": "application/json" },
});
exports.default = api; // ✅ default export
