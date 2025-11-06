"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// src/db.ts
require("dotenv/config");
var pg_1 = require("pg");
var bool = function (v) { return /^(1|true|require|yes|on)$/i.test(v || ""); };
// SSL akkor is legyen, ha:
// - PGSSLMODE=require
// - DATABASE_SSL=true
// - RENDER=true
// - NODE_ENV=production
var sslNeeded = bool(process.env.PGSSLMODE) ||
    bool(process.env.DATABASE_SSL) ||
    bool(process.env.RENDER) ||
    process.env.NODE_ENV === "production";
// Alap konfiguráció: ha van DATABASE_URL, azt használjuk, de
// mezőkkel felülírjuk (PG_* vagy DB_*), hogy minden környezetben működjön.
var cfg = process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL }
    : {};
cfg.host = process.env.PGHOST || process.env.DB_HOST || cfg.host;
cfg.port = Number(process.env.PGPORT || process.env.DB_PORT || cfg.port || 5432);
cfg.user = process.env.PGUSER || process.env.DB_USER || cfg.user;
cfg.password = process.env.PGPASSWORD || process.env.DB_PASSWORD || cfg.password;
cfg.database = process.env.PGDATABASE || process.env.DB_NAME || cfg.database;
// Render/SSL eset: tanúsítvány ellenőrzés kikapcs, hogy biztosan felálljon
if (sslNeeded) {
    cfg.ssl = { rejectUnauthorized: false };
}
var pool = new pg_1.Pool(cfg);
// Hasznos naplózás (jelszó NÉLKÜL)
pool.on("connect", function () {
    var o = pool.options || {};
    console.log("✅ PG connected", {
        host: o.host || "(via URL)",
        db: o.database,
        user: o.user,
        ssl: !!o.ssl,
        port: o.port,
    });
});
pool.on("error", function (err) {
    console.error("❌ PG pool error:", err);
});
exports.default = pool;
