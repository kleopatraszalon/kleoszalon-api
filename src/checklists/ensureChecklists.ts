import { readFile } from "fs/promises";
import path from "path";
import pool from "../db";

let migrationPromise: Promise<void> | null = null;

export function ensureChecklists() {
  if (!migrationPromise) {
    migrationPromise = (async () => {
      for (const file of [
        "20260808_CHECKLISTS_V1.sql",
        "20260808_CHECKLIST_TEST_USERS_V1.sql",
        "20260808_CHECKLIST_TEST_USERS_V2.sql",
        "20260824_DEMO_PASSWORDS_V3.sql",
      ]) {
        const sqlPath = path.join(__dirname, "..", "sql", file);
        await pool.query(await readFile(sqlPath, "utf8"));
      }
    })().catch((error) => {
      migrationPromise = null;
      throw error;
    });
  }
  return migrationPromise;
}
