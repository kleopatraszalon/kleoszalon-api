CREATE TABLE IF NOT EXISTS employee_work_time_profiles (
  employee_id uuid PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
  schedule_type text NOT NULL DEFAULT 'general',
  weekly_minutes integer NOT NULL DEFAULT 2400 CHECK (weekly_minutes BETWEEN 60 AND 4320),
  daily_minutes integer NOT NULL DEFAULT 480 CHECK (daily_minutes BETWEEN 60 AND 1440),
  frame_start date,
  frame_end date,
  settlement_period_weeks integer NOT NULL DEFAULT 1 CHECK (settlement_period_weeks BETWEEN 1 AND 52),
  min_daily_minutes integer NOT NULL DEFAULT 240 CHECK (min_daily_minutes BETWEEN 0 AND 720),
  max_daily_minutes integer NOT NULL DEFAULT 720 CHECK (max_daily_minutes BETWEEN 60 AND 1440),
  max_weekly_minutes integer NOT NULL DEFAULT 2880 CHECK (max_weekly_minutes BETWEEN 60 AND 4320),
  min_daily_rest_minutes integer NOT NULL DEFAULT 660 CHECK (min_daily_rest_minutes BETWEEN 0 AND 1440),
  min_weekly_rest_minutes integer NOT NULL DEFAULT 2880 CHECK (min_weekly_rest_minutes BETWEEN 0 AND 10080),
  break_after_six_hours integer NOT NULL DEFAULT 20,
  additional_break_after_nine_hours integer NOT NULL DEFAULT 25,
  allow_split_shift boolean NOT NULL DEFAULT false,
  allow_sunday boolean NOT NULL DEFAULT false,
  allow_public_holiday boolean NOT NULL DEFAULT false,
  allow_night_work boolean NOT NULL DEFAULT false,
  standby_position boolean NOT NULL DEFAULT false,
  multi_shift_activity boolean NOT NULL DEFAULT false,
  seasonal_activity boolean NOT NULL DEFAULT false,
  uninterrupted_activity boolean NOT NULL DEFAULT false,
  voluntary_overtime_agreement boolean NOT NULL DEFAULT false,
  annual_overtime_limit integer NOT NULL DEFAULT 250,
  voluntary_overtime_limit integer NOT NULL DEFAULT 150,
  valid_from date NOT NULL DEFAULT CURRENT_DATE,
  valid_to date,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS work_shifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  location_id uuid REFERENCES locations(id),
  work_date date NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  break_minutes integer NOT NULL DEFAULT 0 CHECK (break_minutes >= 0),
  shift_type text NOT NULL DEFAULT 'regular',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','cancelled')),
  is_overtime boolean NOT NULL DEFAULT false,
  overtime_ordered boolean NOT NULL DEFAULT false,
  is_standby boolean NOT NULL DEFAULT false,
  is_on_call boolean NOT NULL DEFAULT false,
  is_training boolean NOT NULL DEFAULT false,
  legal_override_reason text,
  note text,
  published_at timestamptz,
  published_by text,
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS work_shifts_employee_date_idx ON work_shifts(employee_id,work_date,status);
CREATE INDEX IF NOT EXISTS work_shifts_location_date_idx ON work_shifts(location_id,work_date,status);

CREATE TABLE IF NOT EXISTS work_schedule_publications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid REFERENCES locations(id),
  period_from date NOT NULL,
  period_to date NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  published_by text,
  note text,
  UNIQUE(location_id,period_from,period_to)
);

CREATE TABLE IF NOT EXISTS work_schedule_change_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id uuid REFERENCES work_shifts(id) ON DELETE SET NULL,
  employee_id uuid REFERENCES employees(id) ON DELETE SET NULL,
  action text NOT NULL,
  old_data jsonb,
  new_data jsonb,
  reason text,
  actor_user_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public_holidays (
  holiday_date date PRIMARY KEY,
  name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true
);
INSERT INTO public_holidays(holiday_date,name) VALUES
 ('2026-01-01','Újév'),('2026-03-15','Nemzeti ünnep'),('2026-04-03','Nagypéntek'),
 ('2026-04-06','Húsvéthétfő'),('2026-05-01','A munka ünnepe'),('2026-05-25','Pünkösdhétfő'),
 ('2026-08-20','Az államalapítás ünnepe'),('2026-10-23','Nemzeti ünnep'),
 ('2026-11-01','Mindenszentek'),('2026-12-25','Karácsony'),('2026-12-26','Karácsony')
ON CONFLICT(holiday_date) DO UPDATE SET name=EXCLUDED.name;

INSERT INTO employee_work_time_profiles(employee_id,weekly_minutes,daily_minutes)
SELECT e.id,
       COALESCE((SELECT round(c.weekly_hours*60)::int FROM employment_contracts c WHERE c.employee_id=e.id AND c.is_active ORDER BY c.start_date DESC LIMIT 1),2400),
       COALESCE((SELECT round(c.weekly_hours*12)::int FROM employment_contracts c WHERE c.employee_id=e.id AND c.is_active ORDER BY c.start_date DESC LIMIT 1),480)
FROM employees e
WHERE COALESCE(e.active,true)
ON CONFLICT(employee_id) DO NOTHING;

INSERT INTO schema_migrations(version,description)
VALUES ('20260805_WORK_SCHEDULE_V1','Munkaidőprofilok, dolgozói beosztások, közzététel és változásnapló')
ON CONFLICT(version) DO NOTHING;
