"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pingDb = pingDb;
// src/db.ts
const pg_1 = require("pg");
function makePool() {
    // 1) Ha van DATABASE_URL (Render/Heroku), azt használjuk
    const url = process.env.DATABASE_URL;
    if (url) {
        const sslNeeded = process.env.PGSSLMODE === "require" ||
            process.env.NODE_ENV === "production";
        return new pg_1.Pool({
            connectionString: url,
            ssl: sslNeeded ? { rejectUnauthorized: false } : false,
        });
    }
    // 2) Egyébként klasszikus paraméterek
    return new pg_1.Pool({
        host: process.env.PGHOST || "127.0.0.1",
        port: Number(process.env.PGPORT || 5432),
        user: process.env.PGUSER || "postgres",
        password: process.env.PGPASSWORD || "",
        database: process.env.PGDATABASE || "postgres",
        ssl: process.env.PGSSL === "1" ? { rejectUnauthorized: false } : false,
    });
}
const pool = makePool();
// Egyszerű "ping"
async function pingDb() {
    const r = await pool.query("SELECT 1");
    return r.rowCount === 1;
}
exports.default = pool;
