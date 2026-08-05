BEGIN;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE compensation_plans ADD COLUMN IF NOT EXISTS calculation_mode text NOT NULL DEFAULT 'monthly_plus_variable';
ALTER TABLE compensation_plans ADD COLUMN IF NOT EXISTS monthly_target numeric(14,2) NOT NULL DEFAULT 0;
ALTER TABLE compensation_plans ADD COLUMN IF NOT EXISTS paid_leave_multiplier numeric(6,3) NOT NULL DEFAULT 1;
ALTER TABLE compensation_plans ADD COLUMN IF NOT EXISTS holiday_multiplier numeric(6,3) NOT NULL DEFAULT 2;
ALTER TABLE compensation_plans ADD COLUMN IF NOT EXISTS night_multiplier numeric(6,3) NOT NULL DEFAULT 1;
ALTER TABLE compensation_plans ADD COLUMN IF NOT EXISTS night_start time NOT NULL DEFAULT '22:00';
ALTER TABLE compensation_plans ADD COLUMN IF NOT EXISTS night_end time NOT NULL DEFAULT '06:00';
ALTER TABLE compensation_plans ADD COLUMN IF NOT EXISTS rounding_minutes integer NOT NULL DEFAULT 1;
ALTER TABLE compensation_plans ADD COLUMN IF NOT EXISTS minimum_guarantee numeric(14,2) NOT NULL DEFAULT 0;
ALTER TABLE compensation_plans ADD COLUMN IF NOT EXISTS maximum_gross numeric(14,2);

CREATE TABLE IF NOT EXISTS payroll_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid REFERENCES locations(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT 'Alapértelmezett számfejtési beállítás',
  currency char(3) NOT NULL DEFAULT 'HUF',
  standard_daily_minutes integer NOT NULL DEFAULT 480,
  standard_monthly_hours numeric(7,2) NOT NULL DEFAULT 174,
  include_draft_timesheets boolean NOT NULL DEFAULT false,
  include_unpaid_workorders boolean NOT NULL DEFAULT false,
  pay_paid_leave boolean NOT NULL DEFAULT true,
  calculate_service_commission boolean NOT NULL DEFAULT true,
  calculate_product_commission boolean NOT NULL DEFAULT true,
  calculate_revenue_commission boolean NOT NULL DEFAULT true,
  calculate_overtime boolean NOT NULL DEFAULT true,
  calculate_weekend_extra boolean NOT NULL DEFAULT true,
  calculate_evening_extra boolean NOT NULL DEFAULT true,
  calculate_attendance_bonus boolean NOT NULL DEFAULT true,
  calculate_target_bonus boolean NOT NULL DEFAULT true,
  tax_percent numeric(7,4) NOT NULL DEFAULT 0,
  social_contribution_percent numeric(7,4) NOT NULL DEFAULT 0,
  default_deduction numeric(14,2) NOT NULL DEFAULT 0,
  custom_settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS payroll_settings_default_uq ON payroll_settings((location_id IS NULL)) WHERE location_id IS NULL AND is_active;
INSERT INTO payroll_settings(name) SELECT 'Alapértelmezett számfejtési beállítás' WHERE NOT EXISTS (SELECT 1 FROM payroll_settings WHERE location_id IS NULL AND is_active);

CREATE TABLE IF NOT EXISTS payroll_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid REFERENCES locations(id),
  period_from date NOT NULL,
  period_to date NOT NULL,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  settings_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  gross_total numeric(16,2) NOT NULL DEFAULT 0,
  deduction_total numeric(16,2) NOT NULL DEFAULT 0,
  net_total numeric(16,2) NOT NULL DEFAULT 0,
  created_by text,
  approved_by text,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(period_to >= period_from)
);
CREATE INDEX IF NOT EXISTS payroll_runs_period_idx ON payroll_runs(period_from,period_to,status);

CREATE TABLE IF NOT EXISTS payroll_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payroll_run_id uuid NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees(id),
  compensation_plan_id uuid REFERENCES compensation_plans(id),
  regular_minutes integer NOT NULL DEFAULT 0,
  overtime_minutes integer NOT NULL DEFAULT 0,
  worked_days integer NOT NULL DEFAULT 0,
  shifts integer NOT NULL DEFAULT 0,
  service_revenue numeric(16,2) NOT NULL DEFAULT 0,
  product_revenue numeric(16,2) NOT NULL DEFAULT 0,
  total_revenue numeric(16,2) NOT NULL DEFAULT 0,
  base_pay numeric(16,2) NOT NULL DEFAULT 0,
  overtime_pay numeric(16,2) NOT NULL DEFAULT 0,
  weekend_pay numeric(16,2) NOT NULL DEFAULT 0,
  evening_pay numeric(16,2) NOT NULL DEFAULT 0,
  service_commission numeric(16,2) NOT NULL DEFAULT 0,
  product_commission numeric(16,2) NOT NULL DEFAULT 0,
  revenue_commission numeric(16,2) NOT NULL DEFAULT 0,
  attendance_bonus numeric(16,2) NOT NULL DEFAULT 0,
  target_bonus numeric(16,2) NOT NULL DEFAULT 0,
  manual_adjustment numeric(16,2) NOT NULL DEFAULT 0,
  deductions numeric(16,2) NOT NULL DEFAULT 0,
  gross_pay numeric(16,2) NOT NULL DEFAULT 0,
  net_pay numeric(16,2) NOT NULL DEFAULT 0,
  calculation_details jsonb NOT NULL DEFAULT '{}'::jsonb,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(payroll_run_id,employee_id)
);

INSERT INTO schema_migrations(version,description) VALUES('20260804_PAYROLL_V1','Konfigurálható bér- és jutalékszámítás') ON CONFLICT(version) DO NOTHING;
COMMIT;
