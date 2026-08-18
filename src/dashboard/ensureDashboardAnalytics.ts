import { readFile } from "fs/promises";
import path from "path";
import pool from "../db";

const MIGRATION_VERSION = "20260805_DASHBOARD_ANALYTICS_V1";
const MIGRATION_FILE = `${MIGRATION_VERSION}.sql`;
let migrationPromise: Promise<void> | null = null;

async function alreadyApplied() {
  try {
    const applied = await pool.query(
      "SELECT 1 FROM schema_migrations WHERE version=$1 LIMIT 1",
      [MIGRATION_VERSION],
    );
    return Boolean(applied.rowCount);
  } catch (error: any) {
    // Régi vagy friss adatbázisnál a migration registry még hiányozhat.
    if (String(error?.code || "") === "42P01") return false;
    throw error;
  }
}

async function readMigrationSql() {
  // Productionben __dirname a dist/dashboard könyvtár, ezért az első jelölt dist/sql.
  // A forrásfás fallback a lokális/legacy indítást is stabilan támogatja.
  const candidates = [
    path.join(__dirname, "..", "sql", MIGRATION_FILE),
    path.join(process.cwd(), "dist", "sql", MIGRATION_FILE),
    path.join(process.cwd(), "src", "sql", MIGRATION_FILE),
  ];
  let lastError: any = null;
  for (const sqlPath of Array.from(new Set(candidates))) {
    try {
      return await readFile(sqlPath, "utf8");
    } catch (error: any) {
      lastError = error;
      if (String(error?.code || "") !== "ENOENT") throw error;
    }
  }
  const error = new Error(`Dashboard migration asset nem található: ${MIGRATION_FILE}`) as Error & { cause?: unknown; code?: string };
  error.code = "DASHBOARD_MIGRATION_ASSET_MISSING";
  error.cause = lastError;
  throw error;
}

export function ensureDashboardAnalytics() {
  if (!migrationPromise) {
    migrationPromise = (async () => {
      // Normál dashboard GET-nél már csak egy olcsó migration-registry ellenőrzés történik.
      // A 90 napos seed/upsert kizárólag akkor fut, ha ez a migráció még tényleg nincs alkalmazva.
      if (await alreadyApplied()) return;
      await pool.query(await readMigrationSql());
    })().catch((error) => {
      migrationPromise = null;
      throw error;
    });
  }
  return migrationPromise;
}
