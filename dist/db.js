"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pool = void 0;
const pg_1 = require("pg");
/**
 * Postgres pool – SSL/TLS kompatibilis (Render / felhős PG / lokál PG)
 *
 * A hibád oka:
 * - az eddigi kód "internal"-nak jelölte az EXTERNAL hostot is (mert csak dpg- prefixet nézett),
 *   ezért SSL=false lett, és a szerver azt írta: "SSL/TLS required".
 *
 * Javítás:
 * - internal Render host = dpg-xxxx-a (NINCS benne pont)
 * - external Render host = dpg-xxxx-a.<region>-postgres.render.com (van benne pont)
 * - external esetén alapból SSL ON (rejectUnauthorized:false)
 * - belső (internal) esetén alapból SSL OFF, de PGSSL=on felül tudja írni
 */
const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
    console.error("❌ DATABASE_URL hiányzik az env-ből");
}
// Parse host/port for diagnostics + internal/external detection
let host = "";
let port = "5432";
let isInternal = false;
try {
    if (databaseUrl) {
        const u = new URL(databaseUrl);
        host = u.hostname;
        port = u.port || "5432";
        // Render internal host pattern: dpg-xxxx-a (no dots)
        isInternal = /^dpg-[a-z0-9]+-a$/i.test(host);
        console.log("🔧 PG config", {
            host,
            port,
            internal: isInternal,
            ssl: process.env.PGSSL ?? "(auto)",
        });
    }
}
catch {
    console.warn("⚠️ DATABASE_URL nem URL formátumú (vagy hiányos), ellenőrizd az env-et.");
}
// SSL policy
const pgssl = (process.env.PGSSL || "").toLowerCase().trim();
const isLocal = host === "localhost" || host === "127.0.0.1";
let ssl;
if (pgssl === "off" || pgssl === "false" || pgssl === "0") {
    ssl = false;
}
else if (pgssl === "on" || pgssl === "true" || pgssl === "1" || pgssl === "require") {
    ssl = { rejectUnauthorized: false };
}
else {
    // auto
    if (isLocal) {
        ssl = false;
    }
    else if (isInternal) {
        // Render internal default: no SSL (gyorsabb). Ha nálad mégis SSL kell, tedd: PGSSL=on
        ssl = false;
    }
    else {
        // External / cloud DB: SSL required in most cases
        ssl = { rejectUnauthorized: false };
    }
}
exports.pool = new pg_1.Pool({
    connectionString: databaseUrl,
    ssl,
    connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS ?? 20000),
    idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS ?? 30000),
    max: Number(process.env.PG_POOL_MAX ?? 10),
    keepAlive: true,
});
// server-side statement timeout to avoid hanging queries
exports.pool.on("connect", (client) => {
    const st = Number(process.env.PG_STATEMENT_TIMEOUT_MS ?? 8000);
    client.query(`SET statement_timeout = ${st}`).catch(() => { });
});
exports.pool.on("error", (err) => {
    console.error("❌ PG pool error:", err);
});
exports.default = exports.pool;
