import { readFile } from "fs/promises";
import path from "path";
import pool from "../db";

let migrationPromise: Promise<void> | null = null;

export function ensureHrV2() {
  if (!migrationPromise) {
    migrationPromise = (async () => {
      for (const file of ["20260804_HR_V2.sql", "20260804_PAYROLL_V1.sql", "20260804_ACCESS_CONTROL_V1.sql", "20260805_KLEO_DEMO_DATA.sql", "20260805_WORK_SCHEDULE_V1.sql", "20260808_CHECKLISTS_V1.sql"]) {
        const sqlPath = path.join(__dirname, "..", "sql", file);
        const sql = await readFile(sqlPath, "utf8");
        await pool.query(sql);
      }
    })().catch((error) => {
      migrationPromise = null;
      throw error;
    });
  }
  return migrationPromise;
}
