"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = void 0;
// src/app.ts
// Kompatibilitás: ha valahol a build/start az app.ts-t importálja, ugyanazt a teljesen konfigurált Express appot kapja, mint a server.ts-ből.
var server_1 = require("./server");
Object.defineProperty(exports, "default", { enumerable: true, get: function () { return __importDefault(server_1).default; } });
