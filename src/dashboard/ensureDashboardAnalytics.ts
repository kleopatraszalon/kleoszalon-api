import { readFile } from "fs/promises";
import path from "path";
import pool from "../db";
import { ensureHrV2 } from "../hr/ensureHrV2";

let migrationPromise: Promise<void> | null = null;

export function ensureDashboardAnalytics() {
  if (!migrationPromise) {
    migrationPromise = (async () => {
      await ensureHrV2();
      const sqlPath = path.join(__dirname, "..", "sql", "20260805_DASHBOARD_ANALYTICS_V1.sql");
      await pool.query(await readFile(sqlPath, "utf8"));
    })().catch((error) => {
      migrationPromise = null;
      throw error;
    });
  }
  return migrationPromise;
}
