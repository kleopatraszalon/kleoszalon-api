// src/db.ts
import { Pool } from "pg";

/**
 * Render Postgres esetén a hibád (ETIMEDOUT) szinte biztosan azért van,
 * mert a backend NEM a "Internal Database URL"-t használja.
 *
 * - Internal URL -> host: dpg-...-a , port: 5432 (privát háló)
 * - External URL-> publikus IP + random port (nálad: 34056)
 *
 * Itt csak a DATABASE_URL-t használjuk, és gyors timeoutot adunk,
 * hogy ne lógjon a szerver 30-60 mp-ig.
 */

const databaseUrl = process.env.DATABASE_URL?.trim();

if (!databaseUrl) {
console.warn("⚠️ DATABASE_URL nincs beállítva! A DB-s route-ok nem fognak működni.");
} else {
try {
const u = new URL(databaseUrl);
console.log("🔧 PG config", {
host: u.hostname,
port: u.port || "5432",
db: (u.pathname || "").replace("/", ""),
ssl: process.env.PGSSL === "off" ? "off" : "on",
});
} catch {
console.warn("⚠️ DATABASE_URL nem URL formátumú, ellenőrizd az env-et.");
}
}

// SSL: Render Postgresnél az external kapcsolat igényel SSL-t.
// Internal URL-lel általában SSL-lel is megy. Ha mégsem, tedd be az env-be: PGSSL=off
const ssl =
process.env.PGSSL === "off"
? false
: { rejectUnauthorized: false };

export const pool = new Pool({
connectionString: databaseUrl,
ssl,
connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS ?? 5000),
idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS ?? 30000),
max: Number(process.env.PG_POOL_MAX ?? 10),
keepAlive: true,
});

// szerver oldali query timeout (ne várjon örökké lock miatt)
pool.on("connect", (client) => {
const st = Number(process.env.PG_STATEMENT_TIMEOUT_MS ?? 8000);
client.query(`SET statement_timeout = ${st}`).catch(() => {});
});

pool.on("error", (err) => {
console.error("❌ PG pool error:", err);
});

export default pool;
