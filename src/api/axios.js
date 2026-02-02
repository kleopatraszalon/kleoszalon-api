"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var axios_1 = require("axios");
var api = axios_1.default.create({
    baseURL: "http://localhost:5000", // ← ide jön majd az éles backend URL
    withCredentials: true, // ha van JWT, cookie vagy session
});
exports.default = api;
