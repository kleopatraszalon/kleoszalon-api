BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  description text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS employment_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  name text NOT NULL,
  description text,
  employee_kind text NOT NULL DEFAULT 'employee',
  default_weekly_hours numeric(5,2),
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS employment_types_code_uq ON employment_types(lower(code));

INSERT INTO employment_types(code,name,employee_kind,default_weekly_hours,sort_order) VALUES
 ('full_time_indefinite','Teljes munkaidő – határozatlan','employee',40,10),
 ('full_time_fixed','Teljes munkaidő – határozott','employee',40,20),
 ('part_time_indefinite','Részmunkaidő – határozatlan','employee',20,30),
 ('part_time_fixed','Részmunkaidő – határozott','employee',20,40),
 ('probation','Próbaidős foglalkoztatás','employee',40,50),
 ('simplified','Egyszerűsített foglalkoztatás','employee',NULL,60),
 ('casual','Alkalmi munkavállaló','employee',NULL,70),
 ('student','Diákmunka / szövetkezeti','employee',NULL,80),
 ('intern','Gyakornok','employee',NULL,90),
 ('assignment','Megbízási jogviszony','contractor',NULL,100),
 ('entrepreneur','Egyéni vállalkozó','contractor',NULL,110),
 ('subcontractor','Alvállalkozó','contractor',NULL,120),
 ('agency','Munkaerő-kölcsönzött','employee',40,130),
 ('commission_partner','Jutalékos partner','partner',NULL,140),
 ('chair_rental','Szék- vagy helybérlő','tenant',NULL,150),
 ('other','Egyéb','other',NULL,999)
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS hr_positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text,
  name text NOT NULL,
  description text,
  department_name text,
  management_level integer NOT NULL DEFAULT 0,
  base_monthly_wage numeric(14,2) NOT NULL DEFAULT 0,
  base_hourly_wage numeric(14,2) NOT NULL DEFAULT 0,
  commission_percent numeric(7,4) NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE hr_positions ADD COLUMN IF NOT EXISTS department_name text;
ALTER TABLE hr_positions ADD COLUMN IF NOT EXISTS management_level integer NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS hr_positions_code_uq ON hr_positions(lower(code)) WHERE code IS NOT NULL;

ALTER TABLE employees ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS position_id uuid;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS employment_type text;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS monthly_wage numeric(14,2);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS hourly_wage numeric(14,2);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS commission_percent numeric(7,4);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS employee_position_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  position_id uuid NOT NULL REFERENCES hr_positions(id),
  location_id uuid REFERENCES locations(id),
  is_primary boolean NOT NULL DEFAULT false,
  weekly_hours numeric(5,2),
  valid_from date NOT NULL DEFAULT CURRENT_DATE,
  valid_to date,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
CREATE INDEX IF NOT EXISTS employee_position_employee_idx ON employee_position_assignments(employee_id, is_active);
CREATE UNIQUE INDEX IF NOT EXISTS employee_one_primary_position_uq
  ON employee_position_assignments(employee_id) WHERE is_primary AND is_active;

CREATE TABLE IF NOT EXISTS employment_contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  employment_type_id uuid NOT NULL REFERENCES employment_types(id),
  contract_number text,
  start_date date NOT NULL,
  end_date date,
  probation_end_date date,
  weekly_hours numeric(5,2),
  work_schedule_type text,
  cost_center text,
  tax_category text,
  notes text,
  document_url text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date IS NULL OR end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS employment_contract_employee_idx ON employment_contracts(employee_id, is_active);

CREATE TABLE IF NOT EXISTS compensation_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  code text,
  description text,
  monthly_base numeric(14,2) NOT NULL DEFAULT 0,
  hourly_rate numeric(14,2) NOT NULL DEFAULT 0,
  daily_rate numeric(14,2) NOT NULL DEFAULT 0,
  shift_rate numeric(14,2) NOT NULL DEFAULT 0,
  service_commission_percent numeric(7,4) NOT NULL DEFAULT 0,
  product_commission_percent numeric(7,4) NOT NULL DEFAULT 0,
  revenue_commission_percent numeric(7,4) NOT NULL DEFAULT 0,
  attendance_bonus numeric(14,2) NOT NULL DEFAULT 0,
  target_bonus numeric(14,2) NOT NULL DEFAULT 0,
  overtime_multiplier numeric(6,3) NOT NULL DEFAULT 1.5,
  weekend_multiplier numeric(6,3) NOT NULL DEFAULT 1,
  evening_multiplier numeric(6,3) NOT NULL DEFAULT 1,
  currency char(3) NOT NULL DEFAULT 'HUF',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS compensation_plans_code_uq ON compensation_plans(lower(code)) WHERE code IS NOT NULL;

CREATE TABLE IF NOT EXISTS employee_compensation_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  compensation_plan_id uuid REFERENCES compensation_plans(id),
  monthly_base numeric(14,2),
  hourly_rate numeric(14,2),
  daily_rate numeric(14,2),
  service_commission_percent numeric(7,4),
  product_commission_percent numeric(7,4),
  revenue_commission_percent numeric(7,4),
  valid_from date NOT NULL DEFAULT CURRENT_DATE,
  valid_to date,
  reason text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
CREATE INDEX IF NOT EXISTS employee_compensation_employee_idx ON employee_compensation_assignments(employee_id, valid_from DESC);
CREATE UNIQUE INDEX IF NOT EXISTS employee_one_active_compensation_uq ON employee_compensation_assignments(employee_id) WHERE is_active;

CREATE TABLE IF NOT EXISTS commission_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  compensation_plan_id uuid REFERENCES compensation_plans(id) ON DELETE CASCADE,
  employee_id uuid REFERENCES employees(id) ON DELETE CASCADE,
  position_id uuid REFERENCES hr_positions(id) ON DELETE CASCADE,
  service_id uuid REFERENCES services(id) ON DELETE CASCADE,
  product_id uuid REFERENCES products(id) ON DELETE CASCADE,
  rule_type text NOT NULL,
  calculation_type text NOT NULL DEFAULT 'percent',
  value numeric(14,4) NOT NULL DEFAULT 0,
  threshold_from numeric(14,2),
  threshold_to numeric(14,2),
  valid_from date NOT NULL DEFAULT CURRENT_DATE,
  valid_to date,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS commission_rules_lookup_idx ON commission_rules(employee_id, position_id, service_id, product_id, is_active);

CREATE TABLE IF NOT EXISTS timesheets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  location_id uuid REFERENCES locations(id),
  work_date date NOT NULL,
  clock_in timestamptz,
  clock_out timestamptz,
  break_minutes integer NOT NULL DEFAULT 0,
  regular_minutes integer NOT NULL DEFAULT 0,
  overtime_minutes integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'draft',
  note text,
  approved_by text,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS timesheets_employee_day_uq ON timesheets(employee_id, work_date);

CREATE TABLE IF NOT EXISTS leave_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  name text NOT NULL,
  is_paid boolean NOT NULL DEFAULT true,
  requires_approval boolean NOT NULL DEFAULT true,
  color text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS leave_types_code_uq ON leave_types(lower(code));
INSERT INTO leave_types(code,name,is_paid,requires_approval,color) VALUES
 ('annual','Éves szabadság',true,true,'#7557df'),
 ('sick','Betegszabadság',true,true,'#ef6a7b'),
 ('unpaid','Fizetés nélküli szabadság',false,true,'#8b93a5'),
 ('parental','Szülői szabadság',true,true,'#34a58a'),
 ('other','Egyéb távollét',false,true,'#d29a36')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS leave_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  leave_type_id uuid NOT NULL REFERENCES leave_types(id),
  date_from date NOT NULL,
  date_to date NOT NULL,
  minutes_per_day integer,
  reason text,
  status text NOT NULL DEFAULT 'pending',
  approved_by text,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (date_to >= date_from)
);
CREATE INDEX IF NOT EXISTS leave_requests_employee_dates_idx ON leave_requests(employee_id, date_from, date_to);

CREATE TABLE IF NOT EXISTS audit_log (
  id bigserial PRIMARY KEY,
  actor_user_id text,
  actor_role text,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  location_id text,
  old_data jsonb,
  new_data jsonb,
  request_id text,
  ip_address inet,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_entity_idx ON audit_log(entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_actor_idx ON audit_log(actor_user_id, created_at DESC);

INSERT INTO employee_position_assignments(employee_id,position_id,location_id,is_primary,valid_from,is_active)
SELECT e.id,e.position_id,e.location_id,true,CURRENT_DATE,true
FROM employees e
JOIN hr_positions p ON p.id=e.position_id
WHERE e.position_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM employee_position_assignments x WHERE x.employee_id=e.id AND x.is_primary AND x.is_active);

INSERT INTO schema_migrations(version,description)
VALUES ('20260804_HR_V2','HR V2: foglalkoztatás, munkakörök, szerződések, bérezés, munkaidő, szabadság, audit')
ON CONFLICT (version) DO NOTHING;

COMMIT;
