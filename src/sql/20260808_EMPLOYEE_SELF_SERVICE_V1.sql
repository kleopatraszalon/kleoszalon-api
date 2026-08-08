BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS employee_leave_balances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  balance_year integer NOT NULL,
  entitlement_days numeric(6,2) NOT NULL DEFAULT 20,
  carried_days numeric(6,2) NOT NULL DEFAULT 0,
  adjustment_days numeric(6,2) NOT NULL DEFAULT 0,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(employee_id,balance_year)
);
CREATE INDEX IF NOT EXISTS employee_leave_balances_lookup_idx
  ON employee_leave_balances(employee_id,balance_year);

-- Alap éves keret. A tényleges egyéni pótszabadságok később adminból módosíthatók
-- a carried_days / adjustment_days mezőkkel; itt nem állítunk jogszabályi pótnapokat
-- hiányos családi vagy egyéb személyes adatok alapján.
INSERT INTO employee_leave_balances(employee_id,balance_year,entitlement_days)
SELECT e.id,EXTRACT(YEAR FROM CURRENT_DATE)::int,20
FROM employees e
WHERE COALESCE(e.active,true)=true
ON CONFLICT(employee_id,balance_year) DO NOTHING;

-- A belső chathez szükséges feature tábla régebbi adatbázisokon is legyen biztosan jelen.
CREATE TABLE IF NOT EXISTS role_feature_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_key text NOT NULL,
  feature_key text NOT NULL,
  can_use boolean NOT NULL DEFAULT false,
  scope_type text NOT NULL DEFAULT 'own_location',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(role_key,feature_key)
);

INSERT INTO role_feature_permissions(role_key,feature_key,can_use,scope_type)
VALUES
 ('employee','staff_chat',true,'own_location'),
 ('receptionist','staff_chat',true,'own_location'),
 ('manager','staff_chat',true,'all_locations')
ON CONFLICT(role_key,feature_key) DO UPDATE SET
 can_use=EXCLUDED.can_use,scope_type=EXCLUDED.scope_type,updated_at=now();

INSERT INTO schema_migrations(version,description)
VALUES('20260808_EMPLOYEE_SELF_SERVICE_V1','Munkatársi saját dashboard és éves szabadságkeret alapadatok')
ON CONFLICT(version) DO NOTHING;

COMMIT;
