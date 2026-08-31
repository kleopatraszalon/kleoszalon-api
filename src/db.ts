import { Pool } from "pg";
import { installHttpInstrumentation, observeDbQuery } from "./observability/runtime";

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

installHttpInstrumentation();

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
} catch {
  console.warn("⚠️ DATABASE_URL nem URL formátumú (vagy hiányos), ellenőrizd az env-et.");
}

// SSL policy
const pgssl = (process.env.PGSSL || "").toLowerCase().trim();
const isLocal = host === "localhost" || host === "127.0.0.1";

let ssl: any;
if (pgssl === "off" || pgssl === "false" || pgssl === "0") {
  ssl = false;
} else if (pgssl === "on" || pgssl === "true" || pgssl === "1" || pgssl === "require") {
  ssl = { rejectUnauthorized: false };
} else {
  // auto
  if (isLocal) {
    ssl = false;
  } else if (isInternal) {
    // Render internal default: no SSL (gyorsabb). Ha nálad mégis SSL kell, tedd: PGSSL=on
    ssl = false;
  } else {
    // External / cloud DB: SSL required in most cases
    ssl = { rejectUnauthorized: false };
  }
}

export const PG_POOL_MAX = Number(process.env.PG_POOL_MAX ?? 10);

export const pool = new Pool({
  connectionString: databaseUrl,
  ssl,
  connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS ?? 20000),
  idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS ?? 30000),
  max: PG_POOL_MAX,
  keepAlive: true,
});

/**
 * VIR tenant/schema compatibility.
 *
 * The SaaS core uses a numeric (BIGINT) canonical tenant key, while several
 * legacy VIR modules were written when tenant_id was still assumed to be UUID.
 * PostgreSQL cannot resolve expressions such as BIGINT = UUID and therefore
 * those endpoints failed with HTTP 500 before the query could even inspect the
 * parameter value.
 *
 * The current locations schema uses is_active. Older VIR modules still contain
 * the legacy unqualified predicate `active IS DISTINCT FROM false` on locations.
 * Normalize only that exact legacy predicate when the statement actually reads
 * from locations; do not rewrite generic employee/product active predicates.
 */
export function normalizeLegacyTenantSql(sql: string): string {
  let normalized = sql
    .replace(
      /((?:\b[a-zA-Z_][a-zA-Z0-9_]*\.)?tenant_id)\s*=\s*(\$\d+)::uuid\b/gi,
      "$1::text=$2::text",
    )
    .replace(
      /(\$\d+)::uuid\s*=\s*((?:\b[a-zA-Z_][a-zA-Z0-9_]*\.)?tenant_id)\b/gi,
      "$1::text=$2::text",
    );

  if (/\b(?:FROM|JOIN)\s+(?:public\.)?locations\b/i.test(normalized)) {
    normalized = normalized.replace(
      /\bactive\s+IS\s+DISTINCT\s+FROM\s+false\b/gi,
      "is_active IS DISTINCT FROM false",
    );
  }

  // A handful of VIR modules lazily create their own support tables. Normalize
  // only CREATE TABLE statements whose table itself is VIR-owned; a multi-
  // statement migration may contain unrelated tables and must remain untouched.
  normalized = normalized.replace(
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?vir_[a-z0-9_]+\s*\([\s\S]*?;/gi,
    (statement) => statement.replace(/\btenant_id\s+uuid\b/gi, "tenant_id text"),
  );

  return normalized;
}

function normalizeQueryArg(arg: any) {
  if (typeof arg === "string") return normalizeLegacyTenantSql(arg);
  if (arg && typeof arg === "object" && typeof arg.text === "string") {
    return { ...arg, text: normalizeLegacyTenantSql(arg.text) };
  }
  return arg;
}

function queryText(arg: any) {
  if (typeof arg === "string") return arg;
  if (arg && typeof arg === "object" && typeof arg.text === "string") return arg.text;
  return "unknown-query";
}

function instrumentClient(client: any) {
  if (client.__kleoApmQueryWrapped) return;
  client.__kleoApmQueryWrapped = true;
  const rawQuery = client.query.bind(client);
  client.query = (...args: any[]) => {
    args[0] = normalizeQueryArg(args[0]);
    const text = queryText(args[0]);
    const started = process.hrtime.bigint();
    const finish = (failed = false) => {
      const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
      observeDbQuery(text, durationMs, failed);
    };
    const callbackIndex = typeof args[args.length - 1] === "function" ? args.length - 1 : -1;
    if (callbackIndex >= 0) {
      const callback = args[callbackIndex];
      args[callbackIndex] = (error: any, result: any) => {
        finish(Boolean(error));
        return callback(error, result);
      };
      try { return rawQuery(...args); }
      catch (error) { finish(true); throw error; }
    }
    try {
      const result = rawQuery(...args);
      if (result && typeof result.then === "function") {
        return result.then(
          (value: any) => { finish(false); return value; },
          (error: any) => { finish(true); throw error; },
        );
      }
      finish(false);
      return result;
    } catch (error) {
      finish(true);
      throw error;
    }
  };
}

// Normalize at the Pool.query boundary as well as on acquired clients. This is
// important for legacy VIR routes that call pool.query() directly: they now get
// the same tenant/schema compatibility regardless of connection reuse timing.
instrumentClient(pool as any);

// Server-side session settings. The VIR operates on Hungarian business days,
// therefore CURRENT_DATE and timestamptz::date must follow Europe/Budapest
// rather than the hosting platform's UTC default. PG_TIMEZONE remains an
// explicit deployment override for controlled non-Hungarian environments.
pool.on("connect", (client) => {
  instrumentClient(client as any);
  const st = Number(process.env.PG_STATEMENT_TIMEOUT_MS ?? 8000);
  const timezone = process.env.PG_TIMEZONE?.trim() || "Europe/Budapest";
  client.query(`SET statement_timeout = ${st}`).catch(() => {});
  client
    .query("SELECT set_config('TimeZone', $1, false)", [timezone])
    .catch((err) => console.error("❌ PG timezone beállítási hiba:", err));
});

pool.on("error", (err) => {
  console.error("❌ PG pool error:", err);
});

export default pool;