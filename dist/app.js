"use strict";
// src/app.ts
// Kompatibilitási belépési pont: több build/start konfiguráció az app.ts-t importálja.
// A teljes szerver-konfiguráció (route-ok, CORS, auth, signage, stb.) a server.ts-ben van.
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = void 0;
var server_1 = require("./server");
Object.defineProperty(exports, "default", { enumerable: true, get: function () { return __importDefault(server_1).default; } });
