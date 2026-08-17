import { readFile } from "fs/promises";
import path from "path";
import pool from "../db";
import { ensureHrV2 } from "../hr/ensureHrV2";
import { ensureMasterDataMenuHealth } from "../menu/ensureMasterDataMenuHealth";
import { startProductPricingWorker } from "../products/productPricingRuntime";

let migrationPromise: Promise<void> | null = null;

const migrationFiles = [
  "20260806_VIR_SPEC_MODULES_V1.sql",
  "20260807_PRODUCT_MASTERDATA_MENU.sql",
  "20260807_MASTERDATA_SERVICES_MENU.sql",
  "20260810_MASTERDATA_RBAC_STAGE1.sql",
  "20260813_CENTRAL_MASTERDATA_MENU_V1.sql",
  "20260813_MASTERDATA_LIVE_MENUS_V2.sql",
  "20260813_MASTERDATA_SPEC_COMPLETE_V3.sql",
  "20260813_SYSTEM_SETTINGS_CENTER_V1.sql",
  "20260813_NOTIFICATION_CENTER_MENU_V1.sql",
  "20260808_CHECKLIST_MENU_V1.sql",
  "20260808_EMPLOYEE_SELF_MENU_V1.sql",
  "20260810_BOOKING_VOICE_STATS_V1.sql",
  "20260817_PRODUCT_PRICE_HISTORY_V1.sql",
];

async function runSqlFile(fileName: string) {
  const sqlPath = path.join(__dirname, "..", "sql", fileName);
  let sql = await readFile(sqlPath, "utf8");
  if (fileName === "20260806_VIR_SPEC_MODULES_V1.sql") {
    sql = sql.replace(/ON CONFLICT\(module_key\) DO NOTHING;/g, "ON CONFLICT DO NOTHING;");
  }
  const client = await pool.connect();
  try {
    await client.query(sql);
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

async function repairLegacyMenuCodes() {
  const exists = (await pool.query(`SELECT to_regclass('public.menus') IS NOT NULL ok`)).rows[0]?.ok;
  if (!exists) return;
  await pool.query(`
    UPDATE menus
       SET code = 'legacy.' ||
                  COALESCE(
                    NULLIF(trim(both '.' from regexp_replace(lower(COALESCE(route,'')), '[^a-z0-9]+', '.', 'g')), ''),
                    'menu'
                  ) || '.' || id::text
     WHERE code IS NULL AND route IS NOT NULL
  `);
}

export function ensureVirSpecModules() {
  if (!migrationPromise) {
    migrationPromise = (async () => {
      const failures: string[] = [];
      const runStep = async (label: string, step: () => Promise<void>) => {
        try {
          await step();
        } catch (error: any) {
          failures.push(`${label}: ${error?.message || String(error)}`);
          console.warn(`VIR bootstrap reszlepes kimaradt (${label}):`, error?.message || error);
        }
      };

      await runStep("HR v2", () => ensureHrV2());
      await runStep("legacy menukodok", repairLegacyMenuCodes);
      for (const fileName of migrationFiles) {
        await runStep(fileName, () => runSqlFile(fileName));
      }
      await runStep("Torzsadatok menu onjavitas", ensureMasterDataMenuHealth);

      if (failures.length) {
        throw new Error(`A VIR bootstrap ${failures.length} reszlepese hibazott: ${failures.join(" | ")}`);
      }

      startProductPricingWorker();
    })().catch((error) => {
      migrationPromise = null;
      throw error;
    });
  }
  return migrationPromise;
}
