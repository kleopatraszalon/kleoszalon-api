BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS login_name text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS location_id uuid;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS login_name text;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS password_hash text;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS role jsonb NOT NULL DEFAULT '["employee"]'::jsonb;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS location_id uuid;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- Tesztjelszó mindhárom új fiókhoz: Teszt1234!
-- Bcrypt: $2b$12$Zea7mWMY.2wv.oUi.WwFJOfrsbBbxdOEHv8r5dbyq7W76NFUJIsQ.
DO $$
DECLARE
  role_udt text;
  r record;
  role_json text;
  v_location uuid;
  affected bigint;
BEGIN
  SELECT id INTO v_location
  FROM locations
  WHERE lower(name) LIKE '%salgótarján%' OR lower(name) LIKE '%salgotarjan%'
  ORDER BY name LIMIT 1;
  IF v_location IS NULL THEN SELECT id INTO v_location FROM locations ORDER BY name LIMIT 1; END IF;

  SELECT udt_name INTO role_udt
  FROM information_schema.columns
  WHERE table_schema=current_schema() AND table_name='users' AND column_name='role'
  LIMIT 1;

  -- Korábbi demo adminfiókok átnevezése. A sorrend szándékos:
  -- előbb admin2 -> admin1, majd a felszabadult admin2-re admin3 -> admin2.
  UPDATE users
     SET full_name='H. Rebeka',
         login_name='admin1',
         email='demo.admin1@kleoszalon.hu',
         password_hash='$2b$12$Zea7mWMY.2wv.oUi.WwFJOfrsbBbxdOEHv8r5dbyq7W76NFUJIsQ.',
         location_id=NULL
   WHERE lower(COALESCE(email,''))='demo.admin2@kleoszalon.hu'
     AND lower(COALESCE(login_name,''))='admin2'
     AND COALESCE(full_name,'')='DEMO Admin 2';

  UPDATE users
     SET full_name='H. N. Andrea',
         login_name='admin2',
         email='demo.admin2@kleoszalon.hu',
         password_hash='$2b$12$Zea7mWMY.2wv.oUi.WwFJOfrsbBbxdOEHv8r5dbyq7W76NFUJIsQ.',
         location_id=NULL
   WHERE lower(COALESCE(email,''))='demo.admin3@kleoszalon.hu'
     AND lower(COALESCE(login_name,''))='admin3'
     AND COALESCE(full_name,'')='DEMO Admin 3';

  FOR r IN SELECT * FROM (VALUES
    ('H. Rebeka','admin1','demo.admin1@kleoszalon.hu','admin',NULL::uuid),
    ('H. N. Andrea','admin2','demo.admin2@kleoszalon.hu','admin',NULL::uuid),
    ('DEMO Üzletvezető','uzletvezeto1','demo.uzletvezeto@kleoszalon.hu','location_manager',v_location)
  ) AS v(full_name,login_name,email,role_key,location_id)
  LOOP
    role_json:=to_json(r.role_key::text)::text;
    IF role_udt='jsonb' THEN
      EXECUTE 'UPDATE users SET full_name=$1,login_name=$2,password_hash=$3,role=$4::jsonb,location_id=$5 WHERE lower(email)=lower($6)'
        USING r.full_name,r.login_name,'$2b$12$Zea7mWMY.2wv.oUi.WwFJOfrsbBbxdOEHv8r5dbyq7W76NFUJIsQ.',role_json,r.location_id,r.email;
      GET DIAGNOSTICS affected=ROW_COUNT;
      IF affected=0 THEN EXECUTE 'INSERT INTO users(full_name,login_name,email,password_hash,role,location_id) VALUES($1,$2,$3,$4,$5::jsonb,$6)'
        USING r.full_name,r.login_name,r.email,'$2b$12$Zea7mWMY.2wv.oUi.WwFJOfrsbBbxdOEHv8r5dbyq7W76NFUJIsQ.',role_json,r.location_id; END IF;
    ELSIF role_udt='json' THEN
      EXECUTE 'UPDATE users SET full_name=$1,login_name=$2,password_hash=$3,role=$4::json,location_id=$5 WHERE lower(email)=lower($6)'
        USING r.full_name,r.login_name,'$2b$12$Zea7mWMY.2wv.oUi.WwFJOfrsbBbxdOEHv8r5dbyq7W76NFUJIsQ.',role_json,r.location_id,r.email;
      GET DIAGNOSTICS affected=ROW_COUNT;
      IF affected=0 THEN EXECUTE 'INSERT INTO users(full_name,login_name,email,password_hash,role,location_id) VALUES($1,$2,$3,$4,$5::json,$6)'
        USING r.full_name,r.login_name,r.email,'$2b$12$Zea7mWMY.2wv.oUi.WwFJOfrsbBbxdOEHv8r5dbyq7W76NFUJIsQ.',role_json,r.location_id; END IF;
    ELSE
      UPDATE users SET full_name=r.full_name,login_name=r.login_name,password_hash='$2b$12$Zea7mWMY.2wv.oUi.WwFJOfrsbBbxdOEHv8r5dbyq7W76NFUJIsQ.',role=r.role_key,location_id=r.location_id WHERE lower(email)=lower(r.email);
      IF NOT FOUND THEN INSERT INTO users(full_name,login_name,email,password_hash,role,location_id) VALUES(r.full_name,r.login_name,r.email,'$2b$12$Zea7mWMY.2wv.oUi.WwFJOfrsbBbxdOEHv8r5dbyq7W76NFUJIsQ.',r.role_key,r.location_id); END IF;
    END IF;
  END LOOP;

  UPDATE employees SET full_name='DEMO Üzletvezető',login_name='uzletvezeto1',password_hash='$2b$12$Zea7mWMY.2wv.oUi.WwFJOfrsbBbxdOEHv8r5dbyq7W76NFUJIsQ.',role='["location_manager"]'::jsonb,location_id=v_location,active=true,updated_at=now()
  WHERE lower(COALESCE(email,''))=lower('demo.uzletvezeto@kleoszalon.hu') OR lower(COALESCE(login_name,''))='uzletvezeto1';
  IF NOT FOUND THEN
    INSERT INTO employees(full_name,email,login_name,password_hash,role,location_id,active,updated_at)
    VALUES('DEMO Üzletvezető','demo.uzletvezeto@kleoszalon.hu','uzletvezeto1','$2b$12$Zea7mWMY.2wv.oUi.WwFJOfrsbBbxdOEHv8r5dbyq7W76NFUJIsQ.','["location_manager"]'::jsonb,v_location,true,now());
  END IF;
END $$;

INSERT INTO access_roles(role_key,name,description,level,is_system,is_active)
VALUES('location_manager','Üzletvezető','Saját telephely napi operatív irányítása',70,true,true)
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS role_feature_permissions (
  role_key text NOT NULL,
  feature_key text NOT NULL,
  can_use boolean NOT NULL DEFAULT false,
  scope_type text NOT NULL DEFAULT 'own_location',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(role_key,feature_key)
);

INSERT INTO role_feature_permissions(role_key,feature_key,can_use,scope_type,updated_at)
SELECT 'location_manager',x,true,'own_location',now()
FROM unnest(ARRAY[
  'management_dashboard','appointments','customers','crm','hr','inventory','procurement','finance','checklists'
]) x
ON CONFLICT(role_key,feature_key) DO UPDATE SET can_use=true,scope_type='own_location',updated_at=now();

-- Először explicit tiltás minden aktív menüre. Ez azért szükséges, hogy a későbbi
-- dinamikus menü-seedek se örökítsenek véletlenül szélesebb jogosultságot.
INSERT INTO role_menu_permissions(
  role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,
  can_view_financial,can_manage_permissions,scope_type,updated_at
)
SELECT 'location_manager',m.id,false,false,false,false,false,false,false,false,'own_location',now()
FROM menus m WHERE COALESCE(m.is_active,true)=true
ON CONFLICT(role_key,menu_id) DO UPDATE SET
  can_view=false,can_create=false,can_edit=false,can_delete=false,can_approve=false,
  can_export=false,can_view_financial=false,can_manage_permissions=false,
  scope_type='own_location',updated_at=now();

-- A saját üzlet napi működéséhez szükséges menük.
INSERT INTO role_menu_permissions(
  role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,
  can_view_financial,can_manage_permissions,scope_type,updated_at
)
SELECT 'location_manager',m.id,true,
  CASE WHEN m.code IN ('appointments','appointments.calendar','customers','customers.clients','customers.crm','team.employees','team.schedule','finance.workorders','inventory.stock','procurement.orders')
         OR m.route IN ('/appointments/calendar','/employees','/modules/clients','/modules/crm','/workorders/new') THEN true ELSE false END,
  CASE WHEN m.code IN ('appointments','appointments.calendar','customers','customers.clients','customers.crm','team.employees','team.schedule','team.attendance','finance.workorders','inventory.stock','procurement.orders')
         OR m.route IN ('/appointments/calendar','/employees','/modules/clients','/modules/crm','/workorders','/workorders/list') THEN true ELSE false END,
  false,false,
  CASE WHEN m.code IN ('dashboard','finance.workorders','inventory.stock','procurement.orders') OR m.route='/' THEN true ELSE false END,
  CASE WHEN m.code IN ('dashboard','finance','finance.workorders') OR m.route IN ('/','/workorders','/workorders/list','/workorders/new') THEN true ELSE false END,
  false,'own_location',now()
FROM menus m
WHERE COALESCE(m.is_active,true)=true AND (
  m.code IN (
    'dashboard',
    'appointments','appointments.calendar','appointments.list',
    'customers','customers.clients','customers.crm',
    'team','team.employees','team.schedule','team.attendance','team.vacations',
    'finance','finance.workorders',
    'inventory','inventory.products','inventory.stock',
    'procurement','procurement.dashboard','procurement.suggestions','procurement.orders',
    'knowledge','knowledge.checklists'
  )
  OR m.route IN (
    '/','/appointments/calendar','/modules/team/timetable','/modules/team/attendance',
    '/employees','/hr','/modules/clients','/modules/crm','/modules/customers/clients','/modules/customers/crm',
    '/workorders','/workorders/list','/workorders/new',
    '/warehouse','/warehouse/list','/warehouse/products',
    '/warehouse?view=procurement&section=dashboard','/warehouse?view=procurement&section=suggestions','/warehouse?view=procurement&section=orders',
    '/knowledge-base/checklists'
  )
)
ON CONFLICT(role_key,menu_id) DO UPDATE SET
  can_view=EXCLUDED.can_view,can_create=EXCLUDED.can_create,can_edit=EXCLUDED.can_edit,
  can_delete=false,can_approve=false,can_export=EXCLUDED.can_export,
  can_view_financial=EXCLUDED.can_view_financial,can_manage_permissions=false,
  scope_type='own_location',updated_at=now();

INSERT INTO schema_migrations(version,description)
VALUES('20260808_DEMO_ADMINS_LOCATION_MANAGER_V1','Két DEMO admin + telephelyre korlátozott üzletvezetői fiók és jogosultságok')
ON CONFLICT(version) DO NOTHING;

COMMIT;
