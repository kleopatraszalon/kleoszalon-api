"use strict";
var _a, _b;
Object.defineProperty(exports, "__esModule", { value: true });
exports.api = void 0;
var axios_1 = require("axios");
var base = ((_b = (_a = import.meta.env) === null || _a === void 0 ? void 0 : _a.VITE_API_URL) === null || _b === void 0 ? void 0 : _b.replace(/\/$/, ""))
    || "http://localhost:10000"; // Renderen ez a saját backend URL-ed
exports.api = axios_1.default.create({
    baseURL: base, // Pl.: https://<backend-domain>/api
    withCredentials: true,
    headers: { "Content-Type": "application/json" },
});
