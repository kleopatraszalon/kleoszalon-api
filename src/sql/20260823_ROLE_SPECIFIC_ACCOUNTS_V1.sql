BEGIN;

-- Tesztfiókok közös, egyedileg generált ideiglenes jelszóval.
-- A jelszó nincs a forráskódban; csak az erős PBKDF2-SHA256 lenyomat kerül tárolásra.
DO $$
DECLARE
  role_udt text;
  v_location uuid;
  r record;
  role_json text;
  affected bigint;
BEGIN
  SELECT id INTO v_location FROM locations ORDER BY name LIMIT 1;
  SELECT udt_name INTO role_udt FROM information_schema.columns
   WHERE table_schema=current_schema() AND table_name='users' AND column_name='role' LIMIT 1;

  FOR r IN SELECT * FROM (VALUES
    ('DEMO Szalonvezető','szalonvezeto1','demo.szalonvezeto@kleoszalon.hu','salon_manager',v_location),
    ('DEMO Központi vezető','vezeto1','demo.vezeto@kleoszalon.hu','manager',NULL::uuid),
    ('DEMO HR vezető','hr1','demo.hr@kleoszalon.hu','hr_manager',NULL::uuid)
  ) AS v(full_name,login_name,email,role_key,location_id)
  LOOP
    role_json:=to_json(r.role_key::text)::text;
    IF role_udt='jsonb' THEN
      EXECUTE 'UPDATE users SET full_name=$1,login_name=$2,password_hash=$3,role=$4::jsonb,location_id=$5 WHERE lower(email)=lower($6)'
        USING r.full_name,r.login_name,'pbkdf2$210000$5dfd8f777d9c172511c5f8e3c9d804eb$c1092d28139410c8d5dcfffda0a9db03981dd072e8825dfc8720325d05ca656c',role_json,r.location_id,r.email;
      GET DIAGNOSTICS affected=ROW_COUNT;
      IF affected=0 THEN EXECUTE 'INSERT INTO users(full_name,login_name,email,password_hash,role,location_id) VALUES($1,$2,$3,$4,$5::jsonb,$6)'
        USING r.full_name,r.login_name,r.email,'pbkdf2$210000$5dfd8f777d9c172511c5f8e3c9d804eb$c1092d28139410c8d5dcfffda0a9db03981dd072e8825dfc8720325d05ca656c',role_json,r.location_id; END IF;
    ELSIF role_udt='json' THEN
      EXECUTE 'UPDATE users SET full_name=$1,login_name=$2,password_hash=$3,role=$4::json,location_id=$5 WHERE lower(email)=lower($6)'
        USING r.full_name,r.login_name,'pbkdf2$210000$5dfd8f777d9c172511c5f8e3c9d804eb$c1092d28139410c8d5dcfffda0a9db03981dd072e8825dfc8720325d05ca656c',role_json,r.location_id,r.email;
      GET DIAGNOSTICS affected=ROW_COUNT;
      IF affected=0 THEN EXECUTE 'INSERT INTO users(full_name,login_name,email,password_hash,role,location_id) VALUES($1,$2,$3,$4,$5::json,$6)'
        USING r.full_name,r.login_name,r.email,'pbkdf2$210000$5dfd8f777d9c172511c5f8e3c9d804eb$c1092d28139410c8d5dcfffda0a9db03981dd072e8825dfc8720325d05ca656c',role_json,r.location_id; END IF;
    ELSE
      UPDATE users SET full_name=r.full_name,login_name=r.login_name,password_hash='pbkdf2$210000$5dfd8f777d9c172511c5f8e3c9d804eb$c1092d28139410c8d5dcfffda0a9db03981dd072e8825dfc8720325d05ca656c',role=r.role_key,location_id=r.location_id WHERE lower(email)=lower(r.email);
      IF NOT FOUND THEN INSERT INTO users(full_name,login_name,email,password_hash,role,location_id) VALUES(r.full_name,r.login_name,r.email,'pbkdf2$210000$5dfd8f777d9c172511c5f8e3c9d804eb$c1092d28139410c8d5dcfffda0a9db03981dd072e8825dfc8720325d05ca656c',r.role_key,r.location_id); END IF;
    END IF;
  END LOOP;
END $$;

INSERT INTO access_roles(role_key,name,description,level,is_system,is_active) VALUES
 ('salon_manager','Szalonvezető','Saját telephely napi és munkatársi irányítása',75,true,true),
 ('manager','Központi vezető','Összes telephely vezetői és riport hozzáférése',85,true,true),
 ('hr_manager','HR vezető','Munkaügyi, bérezési, toborzási és képzési hozzáférés',80,true,true)
ON CONFLICT(role_key) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,level=EXCLUDED.level,is_active=true;

INSERT INTO role_feature_permissions(role_key,feature_key,can_use,scope_type,updated_at)
SELECT role_key,feature_key,true,scope_type,now() FROM (VALUES
 ('salon_manager','management_dashboard','own_location'),('salon_manager','appointments','own_location'),('salon_manager','customers','own_location'),('salon_manager','hr','own_location'),('salon_manager','inventory','own_location'),('salon_manager','finance','own_location'),
 ('manager','management_dashboard','all_locations'),('manager','analytics','all_locations'),('manager','finance','all_locations'),('manager','hr','all_locations'),('manager','inventory','all_locations'),('manager','appointments','all_locations'),
 ('hr_manager','hr','all_locations'),('hr_manager','payroll','all_locations'),('hr_manager','recruitment','all_locations'),('hr_manager','training','all_locations'),('hr_manager','knowledge_base','all_locations')
) v(role_key,feature_key,scope_type)
ON CONFLICT(role_key,feature_key) DO UPDATE SET can_use=true,scope_type=EXCLUDED.scope_type,updated_at=now();

INSERT INTO role_menu_permissions(role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,can_manage_permissions,scope_type,updated_at)
SELECT r.role_key,m.id,
 true,
 (r.role_key<>'manager' OR m.code LIKE 'team.%'),
 (r.role_key<>'manager' OR m.code LIKE 'team.%'),
 false,(r.role_key IN ('manager','hr_manager')),true,
 (r.role_key IN ('manager','hr_manager')),false,r.scope_type,now()
FROM (VALUES ('salon_manager','own_location'),('manager','all_locations'),('hr_manager','all_locations')) r(role_key,scope_type)
JOIN menus m ON COALESCE(m.is_active,true) AND (
 (r.role_key='salon_manager' AND (m.code ~ '^(dashboard|appointments|customers|team|finance.workorders|inventory|procurement|knowledge)' OR m.route IN ('/','/appointments/calendar','/appointments/list','/workorders','/employees','/modules/team/timetable','/modules/customers/clients','/warehouse','/knowledge-base/library')))
 OR (r.role_key='manager' AND (m.code ~ '^(dashboard|analytics|locations|finance|inventory|procurement|team)' OR m.route IN ('/','/admin/vir','/reports/top-metrics','/reports/profit','/reports/expected-revenue','/masterdata/salons','/finance','/warehouse','/employees')))
 OR (r.role_key='hr_manager' AND (m.code ~ '^(dashboard|team|knowledge)' OR m.route IN ('/','/employees','/hr/positions','/modules/team/timetable','/modules/team/attendance','/modules/team/payroll','/knowledge-base/library')))
)
ON CONFLICT(role_key,menu_id) DO UPDATE SET can_view=true,can_create=EXCLUDED.can_create,can_edit=EXCLUDED.can_edit,can_delete=false,can_approve=EXCLUDED.can_approve,can_export=true,can_view_financial=EXCLUDED.can_view_financial,can_manage_permissions=false,scope_type=EXCLUDED.scope_type,updated_at=now();

INSERT INTO schema_migrations(version,description)
VALUES('20260823_ROLE_SPECIFIC_ACCOUNTS_V1','Szalonvezetői, központi vezetői és HR tesztfiókok szerepkörre szabott menükkel')
ON CONFLICT(version) DO NOTHING;

COMMIT;
