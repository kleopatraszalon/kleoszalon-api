import { Pool } from "pg";

/**
 * ROBOSZTUS Render PG kapcsolat
 *
 * - Internal DB URL (host: dpg-...-a, port: 5432): privát háló, általában SSL nélkül is oké
 * - External DB URL: publikus, SSL kell
 *
 * A te logodban a timeout pontosan 5000ms -> túl alacsony connect timeout volt.
 * Itt 15000ms az alap.
 */

const databaseUrl = process.env.DATABASE_URL?.trim();

if (!databaseUrl) {
  console.warn("⚠️ DATABASE_URL nincs beállítva! A DB-s route-ok nem fognak működni.");
}

let isInternal = false;
let host = "";
let port = "";
try {
  if (databaseUrl) {
    const u = new URL(databaseUrl);
    host = u.hostname;
    port = u.port || "5432";
    isInternal = host.startsWith("dpg-") && port === "5432";
    console.log("🔧 PG config", { host, port, internal: isInternal, ssl: process.env.PGSSL ?? "(auto)" });
  }
} catch {
  console.warn("⚠️ DATABASE_URL nem URL formátumú, ellenőrizd az env-et.");
}

// SSL logika:
// - ha PGSSL=off -> nincs SSL
// - ha PGSSL=on  -> SSL (rejectUnauthorized:false)
// - ha nincs megadva:
//    - internal: default SSL = false (gyorsabb, stabilabb)
//    - external: default SSL = on
const ssl =
  process.env.PGSSL === "off"
    ? false
    : process.env.PGSSL === "on"
      ? { rejectUnauthorized: false }
      : isInternal
        ? false
        : { rejectUnauthorized: false };

export const pool = new Pool({
  connectionString: databaseUrl,
  ssl,
  connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS ?? 15000),
  idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS ?? 30000),
  max: Number(process.env.PG_POOL_MAX ?? 10),
  keepAlive: true,
});

// szerver oldali query timeout (lock esetén se álljon meg örökre)
pool.on("connect", (client) => {
  const st = Number(process.env.PG_STATEMENT_TIMEOUT_MS ?? 8000);
  client.query(`SET statement_timeout = ${st}`).catch(() => {});
});

pool.on("error", (err) => {
  console.error("❌ PG pool error:", err);
});

export default pool;
