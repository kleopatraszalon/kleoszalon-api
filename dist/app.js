"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/app.ts (SERVER SIDE - no JSX)
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const morgan_1 = __importDefault(require("morgan"));
const app = (0, express_1.default)();
// Middlewares
app.use((0, cors_1.default)());
app.use(express_1.default.json({ limit: "1mb" }));
app.use((0, morgan_1.default)("dev"));
// Health check
app.get("/health", (_req, res) => {
    res.json({ ok: true });
});
// TODO: mount your API routes here, e.g.:
// import authRouter from "./routes/auth";
// app.use("/api/auth", authRouter);
exports.default = app;
