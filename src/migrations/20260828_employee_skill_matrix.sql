ALTER TABLE employee_service_overrides
  ADD COLUMN IF NOT EXISTS skill_level smallint NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS can_perform boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS qualification_name text,
  ADD COLUMN IF NOT EXISTS qualification_number text,
  ADD COLUMN IF NOT EXISTS qualification_valid_until date,
  ADD COLUMN IF NOT EXISTS qualification_verified boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS skill_notes text,
  ADD COLUMN IF NOT EXISTS skill_updated_at timestamptz NOT NULL DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'employee_service_overrides_skill_level_check'
  ) THEN
    ALTER TABLE employee_service_overrides
      ADD CONSTRAINT employee_service_overrides_skill_level_check
      CHECK (skill_level BETWEEN 1 AND 5);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS employee_service_skill_expiry_idx
  ON employee_service_overrides(qualification_valid_until)
  WHERE qualification_valid_until IS NOT NULL;

CREATE INDEX IF NOT EXISTS employee_service_skill_employee_idx
  ON employee_service_overrides(employee_id, can_perform, skill_level);
