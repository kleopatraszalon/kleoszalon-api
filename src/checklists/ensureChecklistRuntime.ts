import pool from "../db";

let readyPromise: Promise<void> | null = null;

export function ensureChecklistRuntime() {
  if (!readyPromise) {
    readyPromise = (async () => {
      await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);

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
      await pool.query(`ALTER TABLE hr_positions ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true`);
      await pool.query(`ALTER TABLE hr_positions ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()`);
      await pool.query(`ALTER TABLE hr_positions ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`);

      await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS position_id uuid`);
      await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true`);
      await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS login_name text`);
      await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS employee_position_assignments (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
          position_id uuid NOT NULL REFERENCES hr_positions(id),
          location_id uuid REFERENCES locations(id),
          is_primary boolean NOT NULL DEFAULT false,
          valid_from date NOT NULL DEFAULT CURRENT_DATE,
          valid_to date,
          is_active boolean NOT NULL DEFAULT true,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await pool.query(`ALTER TABLE employee_position_assignments ADD COLUMN IF NOT EXISTS is_primary boolean NOT NULL DEFAULT false`);
      await pool.query(`ALTER TABLE employee_position_assignments ADD COLUMN IF NOT EXISTS valid_from date NOT NULL DEFAULT CURRENT_DATE`);
      await pool.query(`ALTER TABLE employee_position_assignments ADD COLUMN IF NOT EXISTS valid_to date`);
      await pool.query(`ALTER TABLE employee_position_assignments ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true`);
      await pool.query(`ALTER TABLE employee_position_assignments ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS vir_checklists (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          code text NOT NULL UNIQUE,
          name text NOT NULL,
          description text,
          daily_warning_time time NOT NULL DEFAULT '18:00',
          weekly_warning_weekday smallint NOT NULL DEFAULT 3,
          monthly_warning_days smallint NOT NULL DEFAULT 7,
          is_active boolean NOT NULL DEFAULT true,
          created_by text,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await pool.query(`ALTER TABLE vir_checklists ADD COLUMN IF NOT EXISTS daily_warning_time time NOT NULL DEFAULT '18:00'`);
      await pool.query(`ALTER TABLE vir_checklists ADD COLUMN IF NOT EXISTS weekly_warning_weekday smallint NOT NULL DEFAULT 3`);
      await pool.query(`ALTER TABLE vir_checklists ADD COLUMN IF NOT EXISTS monthly_warning_days smallint NOT NULL DEFAULT 7`);
      await pool.query(`ALTER TABLE vir_checklists ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true`);
      await pool.query(`ALTER TABLE vir_checklists ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS vir_checklist_items (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          checklist_id uuid NOT NULL REFERENCES vir_checklists(id) ON DELETE CASCADE,
          item_key text NOT NULL,
          frequency text NOT NULL,
          section text,
          title text NOT NULL,
          description text,
          sort_order integer NOT NULL DEFAULT 0,
          is_required boolean NOT NULL DEFAULT true,
          is_active boolean NOT NULL DEFAULT true,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          UNIQUE(checklist_id,item_key)
        )
      `);
      await pool.query(`ALTER TABLE vir_checklist_items ADD COLUMN IF NOT EXISTS section text`);
      await pool.query(`ALTER TABLE vir_checklist_items ADD COLUMN IF NOT EXISTS description text`);
      await pool.query(`ALTER TABLE vir_checklist_items ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0`);
      await pool.query(`ALTER TABLE vir_checklist_items ADD COLUMN IF NOT EXISTS is_required boolean NOT NULL DEFAULT true`);
      await pool.query(`ALTER TABLE vir_checklist_items ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true`);
      await pool.query(`ALTER TABLE vir_checklist_items ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS vir_checklist_position_assignments (
          checklist_id uuid NOT NULL REFERENCES vir_checklists(id) ON DELETE CASCADE,
          position_id uuid NOT NULL REFERENCES hr_positions(id) ON DELETE CASCADE,
          is_active boolean NOT NULL DEFAULT true,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY(checklist_id,position_id)
        )
      `);
      await pool.query(`ALTER TABLE vir_checklist_position_assignments ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true`);
      await pool.query(`ALTER TABLE vir_checklist_position_assignments ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS vir_checklist_completions (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          checklist_item_id uuid NOT NULL REFERENCES vir_checklist_items(id) ON DELETE CASCADE,
          employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
          period_start date NOT NULL,
          completed boolean NOT NULL DEFAULT true,
          completed_at timestamptz,
          completed_by_user_id text,
          location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
          note text,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          UNIQUE(checklist_item_id,employee_id,period_start)
        )
      `);
      await pool.query(`ALTER TABLE vir_checklist_completions ADD COLUMN IF NOT EXISTS completed boolean NOT NULL DEFAULT true`);
      await pool.query(`ALTER TABLE vir_checklist_completions ADD COLUMN IF NOT EXISTS completed_at timestamptz`);
      await pool.query(`ALTER TABLE vir_checklist_completions ADD COLUMN IF NOT EXISTS completed_by_user_id text`);
      await pool.query(`ALTER TABLE vir_checklist_completions ADD COLUMN IF NOT EXISTS location_id uuid`);
      await pool.query(`ALTER TABLE vir_checklist_completions ADD COLUMN IF NOT EXISTS note text`);
      await pool.query(`ALTER TABLE vir_checklist_completions ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`);
    })().catch(error => {
      readyPromise = null;
      throw error;
    });
  }
  return readyPromise;
}
