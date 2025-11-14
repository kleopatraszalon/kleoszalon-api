"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pool = void 0;
// src/db.ts
const pg_1 = require("pg");
/**
 * Fejlesztői / production pool létrehozása
 */
function makePool() {
    const isProd = process.env.NODE_ENV === "production";
    // Render / production: DATABASE_URL
    if (isProd && process.env.DATABASE_URL) {
        return new pg_1.Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: process.env.DB_SSL === "1"
                ? { rejectUnauthorized: false }
                : undefined,
        });
    }
    // Lokális fejlesztés
    return new pg_1.Pool({
        host: process.env.DB_HOST ?? "localhost",
        port: Number(process.env.DB_PORT ?? "5432"),
        user: process.env.DB_USER ?? "postgres",
        password: process.env.DB_PASSWORD ?? "postgres",
        database: process.env.DB_NAME ?? "kleoszalon",
    });
}
const pool = makePool();
exports.pool = pool;
exports.default = pool;
