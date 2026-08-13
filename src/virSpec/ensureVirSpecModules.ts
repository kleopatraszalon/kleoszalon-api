import { readFile } from "fs/promises";
import path from "path";
import pool from "../db";
import { ensureHrV2 } from "../hr/ensureHrV2";

let migrationPromise: Promise<void> | null = null;

async function runSqlFile(fileName: string) {
  const sqlPath = path.join(__dirname, "..", "sql", fileName);
  let sql = await readFile(sqlPath, "utf8");

  // A VIR moduldefiníciók route-ja lower(route) szerint is egyedi.
  // A menüből generált bootstrap ugyanazon INSERT forráshalmazán belül több,
  // azonos route-ú rekordot is kaphat. Ilyenkor az ON CONFLICT(module_key)
  // nem védi a route unique indexet, ezért ennél a legacy bootstrapnál minden
  // egyedi konfliktust biztonságosan kihagyunk.
  if (fileName === "20260806_VIR_SPEC_MODULES_V1.sql") {
    sql = sql.replace(/ON CONFLICT\(module_key\) DO NOTHING;/g, "ON CONFLICT DO NOTHING;");
  }

  await pool.query(sql);
}

async function repairLegacyMenuCodes() {
  const exists = (await pool.query(`SELECT to_regclass('public.menus') IS NOT NULL ok`)).rows[0]?.ok;
  if (!exists) return;

  // A régi menürekordok egy részénél a code mező NULL maradt. A VIR modul-bootstrap
  // ebből képezi a kötelező module_key-t, ezért stabil, determinisztikus kódot adunk
  // minden route-tal rendelkező ilyen rekordnak. Az id utótag garantálja az egyediséget.
  await pool.query(`
    UPDATE menus
       SET code = 'legacy.' ||
                  COALESCE(
                    NULLIF(trim(both '.' from regexp_replace(lower(COALESCE(route,'')), '[^a-z0-9]+', '.', 'g')), ''),
                    'menu'
                  ) || '.' || id::text
     WHERE code IS NULL
       AND route IS NOT NULL
  `);
}

export function ensureVirSpecModules() {
  if (!migrationPromise) {
    migrationPromise = (async () => {
      await ensureHrV2();
      await repairLegacyMenuCodes();
      await runSqlFile("20260806_VIR_SPEC_MODULES_V1.sql");
      await runSqlFile("20260807_PRODUCT_MASTERDATA_MENU.sql");
      await runSqlFile("20260807_MASTERDATA_SERVICES_MENU.sql");
      await runSqlFile("20260810_MASTERDATA_RBAC_STAGE1.sql");
      await runSqlFile("20260813_CENTRAL_MASTERDATA_MENU_V1.sql");
      await runSqlFile("20260813_SYSTEM_SETTINGS_CENTER_V1.sql");
      await runSqlFile("20260808_CHECKLIST_MENU_V1.sql");
      await runSqlFile("20260808_EMPLOYEE_SELF_MENU_V1.sql");
      await runSqlFile("20260810_BOOKING_VOICE_STATS_V1.sql");
    })().catch((error) => {
      migrationPromise = null;
      throw error;
    });
  }

  return migrationPromise;
}
