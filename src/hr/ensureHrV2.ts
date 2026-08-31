import { readFile } from "fs/promises";
import path from "path";
import pool from "../db";
import { ensureChecklistRuntime } from "../checklists/ensureChecklistRuntime";

let migrationPromise: Promise<void> | null = null;

const RUNTIME_FILES = [
  "20260804_HR_V2.sql",
  "20260804_PAYROLL_V1.sql",
  "20260805_WORK_SCHEDULE_V1.sql",
  "20260808_CHECKLISTS_V1.sql",
  "20260808_EMPLOYEE_SELF_SERVICE_V1.sql",
  "20260809_ADMIN_CHECKLIST_V1.sql",
  "20260824_POSITION_REVENUE_TARGET.sql",
];

async function ensureSafeHrCore() {
  await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      description text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hr_positions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      code text,
      name text NOT NULL,
      description text,
      department_name text,
      management_level integer NOT NULL DEFAULT 0,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`ALTER TABLE hr_positions ADD COLUMN IF NOT EXISTS code text`);
  await pool.query(`ALTER TABLE hr_positions ADD COLUMN IF NOT EXISTS description text`);
  await pool.query(`ALTER TABLE hr_positions ADD COLUMN IF NOT EXISTS department_name text`);
  await pool.query(`ALTER TABLE hr_positions ADD COLUMN IF NOT EXISTS management_level integer NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE hr_positions ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true`);
  await pool.query(`ALTER TABLE hr_positions ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()`);
  await pool.query(`ALTER TABLE hr_positions ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`);
  await pool.query(`ALTER TABLE hr_positions ADD COLUMN IF NOT EXISTS revenue_target_per_hour numeric(14,2) NOT NULL DEFAULT 0`);

  // Canonical employee columns used by the current timetable/scheduling runtime.
  // Older installations may only expose legacy name/photo/location variants;
  // adding the canonical nullable columns keeps the runtime fail-safe while the
  // schema-tolerant read paths continue to support those legacy variants.
  await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS full_name text`);
  await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS photo_url text`);
  await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS location_id uuid`);
  await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS position_id uuid`);
  await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true`);
  await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS login_name text`);
  await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`);
  await pool.query(`
    UPDATE employees
       SET full_name = COALESCE(NULLIF(btrim(full_name), ''), NULLIF(btrim(login_name), ''), 'Munkatárs')
     WHERE full_name IS NULL OR btrim(full_name) = ''
  `);
}

async function alreadyApplied(version: string) {
  try {
    const { rows } = await pool.query(`SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version=$1) ok`, [version]);
    return Boolean(rows[0]?.ok);
  } catch {
    return false;
  }
}

export function ensureHrV2() {
  if (!migrationPromise) {
    migrationPromise = (async () => {
      await ensureSafeHrCore();
      await ensureChecklistRuntime();

      for (const file of RUNTIME_FILES) {
        const version = file.replace(/\.sql$/i, "");
        if (await alreadyApplied(version)) continue;
        try {
          const sqlPath = path.join(__dirname, "..", "sql", file);
          const sql = await readFile(sqlPath, "utf8");
          await pool.query(sql);
        } catch (error: any) {
          console.warn(`[HR runtime] ${file} kihagyva:`, error?.message || error);
        }
      }
    })().catch((error) => {
      migrationPromise = null;
      throw error;
    });
  }
  return migrationPromise;
}