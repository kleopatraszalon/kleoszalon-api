import { readFile } from "fs/promises";
import path from "path";
import pool from "../db";

const MIGRATION_VERSION = "20260805_DASHBOARD_ANALYTICS_V1";
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

export function ensureDashboardAnalytics() {
  if (!migrationPromise) {
    migrationPromise = (async () => {
      // Normál dashboard GET-nél már csak egy olcsó migration-registry ellenőrzés történik.
      // A 90 napos seed/upsert kizárólag akkor fut, ha ez a migráció még tényleg nincs alkalmazva.
      if (await alreadyApplied()) return;
      const sqlPath = path.join(__dirname, "..", "sql", "20260805_DASHBOARD_ANALYTICS_V1.sql");
      await pool.query(await readFile(sqlPath, "utf8"));
    })().catch((error) => {
      migrationPromise = null;
      throw error;
    });
  }
  return migrationPromise;
}
