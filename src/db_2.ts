import { Pool } from "pg";

/**
 * ROBOSZTUS PG kapcsolat (lokál + felhő)
 *
 * Probléma amit javít:
 * - A dpg-* host NEM mindig "internal". Az external Render host is dpg-... de tartalmaz pontot.
 * - Sok felhős PG (Render/Supabase/Neon) SSL/TLS-t KÖTELEZŐEN kér.
 *
 * Szabály:
 * - ha host localhost/127.0.0.1 -> ssl = false
 * - egyébként -> ssl = { rejectUnauthorized:false } (felhős DB-khez stabil)
 * - felülbírálható: PGSSL=on/off
 */

const databaseUrl = process.env.DATABASE_URL?.trim();

if (!databaseUrl) {
  console.warn("⚠️ DATABASE_URL nincs beállítva! A DB-s route-ok nem fognak működni.");
}

let host = "";
let port = "5432";
let isRenderInternal = false;

try {
  if (databaseUrl) {
    const u = new URL(databaseUrl);
    host = u.hostname;
    port = u.port || "5432";
    // Render internal tipikusan: dpg-xxxxx-a  (nincs benne '.')
    isRenderInternal = host.startsWith("dpg-") && !host.includes(".");
    console.log("🔧 PG config", { host, port, renderInternal: isRenderInternal, PGSSL: process.env.PGSSL ?? "(auto)" });
    if (isRenderInternal && (process.env.NODE_ENV ?? "development") !== "production") {
      console.warn("⚠️ Úgy tűnik, Render INTERNAL DB hostot használsz lokál futtatásnál. Lokálból ez gyakran time-outol. Használj External Database URL-t vagy lokál PG-t.");
    }
  }
} catch {
  // ignore parse errors
}

const isLocalHost = host === "localhost" || host === "127.0.0.1";

// SSL: explicit override first, then default policy
const ssl =
  process.env.PGSSL === "off"
    ? false
    : process.env.PGSSL === "on"
      ? { rejectUnauthorized: false }
      : isLocalHost
        ? false
        : { rejectUnauthorized: false };

export const pool = new Pool({
  connectionString: databaseUrl,
  ssl,
  // ha lokálban internal URL van és unreachable, ez time-outol; emeljük 20s-ra
  connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS ?? 20000),
  idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS ?? 30000),
  max: Number(process.env.PG_POOL_MAX ?? 10),
  keepAlive: true,
});

// statement timeout
pool.on("connect", (client) => {
  const st = Number(process.env.PG_STATEMENT_TIMEOUT_MS ?? 8000);
  client.query(`SET statement_timeout = ${st}`).catch(() => {});
});

pool.on("error", (err) => {
  console.error("❌ PG pool error:", err);
});

export default pool;
