import { readFile } from "fs/promises";
import path from "path";
import pool from "../db";
import { ensureHrV2 } from "../hr/ensureHrV2";
import { ensureMasterDataMenuHealth } from "../menu/ensureMasterDataMenuHealth";

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
  "20260820_ADMIN_FULL_MENU_VISIBILITY_V1.sql",
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

async function ensureCanonicalAdminMenu() {
  const exists = (await pool.query(`SELECT to_regclass('public.menus') IS NOT NULL ok`)).rows[0]?.ok;
  if (!exists) return;

  await pool.query(`
    INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
    VALUES
      ('dashboard','Irányítópult','LayoutDashboard','/',10,NULL,'dashboard',true),
      ('appointments','Időpontok és beosztás','CalendarDays',NULL,20,NULL,'appointments',true),
      ('customers','Ügyfelek és CRM','Users',NULL,30,NULL,'clients',true),
      ('loyalty','Törzsvásárlói program','Gift',NULL,40,NULL,'loyalty',true),
      ('team','Munkatársak és HR','UserCog',NULL,50,NULL,'hr',true),
      ('finance','Pénzügyek','WalletCards',NULL,60,NULL,'finance',true),
      ('inventory','Raktár és készlet','Boxes',NULL,70,NULL,'inventory',true),
      ('procurement','Beszerzés','ShoppingBag',NULL,75,NULL,'inventory',true),
      ('analytics','Vezetői riportok','ChartNoAxesCombined',NULL,80,NULL,'analytics',true),
      ('locations','Telephelyek','Building2',NULL,85,NULL,'locations',true),
      ('marketing','Marketing','Megaphone',NULL,90,NULL,'marketing',true),
      ('online','Online foglalás és alkalmazás','Globe2',NULL,100,NULL,'online',true),
      ('commerce','Értékesítés és webshop','ShoppingBag',NULL,105,NULL,'commerce',true),
      ('operations','Működés és minőség','ClipboardCheck',NULL,110,NULL,'operations',true),
      ('knowledge','Tudásbázis','BookOpenText',NULL,115,NULL,'knowledge_base',true),
      ('masterdata','Törzsadatok','Database',NULL,145,NULL,'master_data',true),
      ('settings','Beállítások és adminisztráció','Settings',NULL,190,NULL,'audit',true)
    ON CONFLICT(code) DO UPDATE SET
      name=EXCLUDED.name,
      icon=COALESCE(menus.icon,EXCLUDED.icon),
      parent_id=NULL,
      is_active=true
  `);

  const permissionsExists = (await pool.query(`SELECT to_regclass('public.role_menu_permissions') IS NOT NULL ok`)).rows[0]?.ok;
  if (!permissionsExists) return;

  await pool.query(`
    INSERT INTO role_menu_permissions(
      role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,
      can_view_financial,can_manage_permissions,scope_type,updated_at
    )
    SELECT roles.role_key,m.id,true,true,true,true,true,true,true,true,'all_locations',now()
      FROM (VALUES
        ('admin'),
        ('administrator'),
        ('rendszergazda'),
        ('superadmin'),
        ('super_admin')
      ) AS roles(role_key)
      CROSS JOIN menus m
     WHERE COALESCE(m.is_active,true)=true
    ON CONFLICT(role_key,menu_id) DO UPDATE SET
      can_view=true,
      can_create=true,
      can_edit=true,
      can_delete=true,
      can_approve=true,
      can_export=true,
      can_view_financial=true,
      can_manage_permissions=true,
      scope_type='all_locations',
      updated_at=now()
  `);

  // A szerepkör-specifikus kezdőoldal minden belső munkakör alapvető belépési pontja.
  // Ezt az induláskori önjavítás is biztosítja, mert egyes éles környezetek a
  // verziózott migrációkat külön indítófolyamatban futtatják.
  await pool.query(`
    INSERT INTO role_feature_permissions(role_key,feature_key,can_use,scope_type,updated_at)
    SELECT role_key,'management_dashboard',true,scope_type,now()
    FROM (VALUES
      ('manager','all_locations'),('hr_manager','all_locations'),('accounting','all_locations'),
      ('location_manager','own_location'),('salon_manager','own_location'),
      ('receptionist','own_location'),('employee','own')
    ) AS roles(role_key,scope_type)
    ON CONFLICT(role_key,feature_key) DO UPDATE SET
      can_use=true,scope_type=EXCLUDED.scope_type,updated_at=now()
  `);

  await pool.query(`
    INSERT INTO role_menu_permissions(
      role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,
      can_view_financial,can_manage_permissions,scope_type,updated_at
    )
    SELECT roles.role_key,m.id,true,false,false,false,false,false,false,false,roles.scope_type,now()
    FROM (VALUES
      ('manager','all_locations'),('hr_manager','all_locations'),('accounting','all_locations'),
      ('location_manager','own_location'),('salon_manager','own_location'),
      ('receptionist','own_location'),('employee','own')
    ) AS roles(role_key,scope_type)
    CROSS JOIN menus m
    WHERE m.code='dashboard' AND COALESCE(m.is_active,true)=true
    ON CONFLICT(role_key,menu_id) DO UPDATE SET
      can_view=true,scope_type=EXCLUDED.scope_type,updated_at=now()
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
      await runStep("kanonikus admin menu onjavitas", ensureCanonicalAdminMenu);

      if (failures.length) {
        throw new Error(`A VIR bootstrap ${failures.length} reszlepese hibazott: ${failures.join(" | ")}`);
      }
    })().catch((error) => {
      migrationPromise = null;
      throw error;
    });
  }
  return migrationPromise;
}
