import { readFile } from "fs/promises";
import path from "path";
import pool from "../db";

let migrationPromise: Promise<void> | null = null;

export function ensureHrV2() {
  if (!migrationPromise) {
    migrationPromise = (async () => {
      // A legacy employment_types PK-átépítés nem futhat automatikus request-bootstrapként:
      // meglévő FK-k mellett destruktív DDL-be ütközhet. Ezt külön, kontrollált migrációként kell kezelni.
      for (const file of [
        "20260804_HR_V2.sql",
        "20260804_PAYROLL_V1.sql",
        "20260804_ACCESS_CONTROL_V1.sql",
        "20260805_KLEO_DEMO_DATA.sql",
        "20260805_WORK_SCHEDULE_V1.sql",
        "20260808_CHECKLISTS_V1.sql",
        "20260808_CHECKLIST_TEST_USERS_V1.sql",
        "20260808_CHECKLIST_TEST_USERS_V2.sql",
        "20260808_EMPLOYEE_SELF_SERVICE_V1.sql",
        "20260808_DEMO_ADMINS_LOCATION_MANAGER_V1.sql",
        "20260809_ADMIN_CHECKLIST_V1.sql",
      ]) {
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
