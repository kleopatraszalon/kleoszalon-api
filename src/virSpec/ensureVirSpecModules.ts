import { readFile } from "fs/promises";
import path from "path";
import pool from "../db";
import { ensureHrV2 } from "../hr/ensureHrV2";

let migrationPromise: Promise<void> | null = null;

async function runSqlFile(fileName: string) {
  const sqlPath = path.join(__dirname, "..", "sql", fileName);
  await pool.query(await readFile(sqlPath, "utf8"));
}

export function ensureVirSpecModules() {
  if (!migrationPromise) {
    migrationPromise = (async () => {
      await ensureHrV2();
      await runSqlFile("20260806_VIR_SPEC_MODULES_V1.sql");
      await runSqlFile("20260807_MASTERDATA_SERVICES_MENU.sql");
      await runSqlFile("20260808_CHECKLIST_MENU_V1.sql");
    })().catch((error) => {
      migrationPromise = null;
      throw error;
    });
  }

  return migrationPromise;
}
