BEGIN;

DO $$
DECLARE v_role_type text; v_user_id uuid;
BEGIN
 SELECT udt_name INTO v_role_type FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='role' LIMIT 1;
 SELECT id INTO v_user_id FROM users WHERE lower(COALESCE(login_name,''))=lower('könyvelés') OR lower(COALESCE(email,''))=lower('konyveles@kleoszalon.hu') LIMIT 1;
 IF v_user_id IS NULL THEN
  IF v_role_type='jsonb' THEN INSERT INTO users(full_name,email,login_name,password_hash,role,location_id) VALUES('Könyvelés','konyveles@kleoszalon.hu','könyvelés','$2b$12$7yCjqwhiLLMvIH0H8wzDIud7cTOHC.uU2MZUKIDWrYhbzGZvocwsO','["accounting"]'::jsonb,NULL);
  ELSIF v_role_type='json' THEN INSERT INTO users(full_name,email,login_name,password_hash,role,location_id) VALUES('Könyvelés','konyveles@kleoszalon.hu','könyvelés','$2b$12$7yCjqwhiLLMvIH0H8wzDIud7cTOHC.uU2MZUKIDWrYhbzGZvocwsO','["accounting"]'::json,NULL);
  ELSE INSERT INTO users(full_name,email,login_name,password_hash,role,location_id) VALUES('Könyvelés','konyveles@kleoszalon.hu','könyvelés','$2b$12$7yCjqwhiLLMvIH0H8wzDIud7cTOHC.uU2MZUKIDWrYhbzGZvocwsO','accounting',NULL); END IF;
 ELSE
  IF v_role_type='jsonb' THEN UPDATE users SET role='["accounting"]'::jsonb,location_id=NULL WHERE id=v_user_id;
  ELSIF v_role_type='json' THEN UPDATE users SET role='["accounting"]'::json,location_id=NULL WHERE id=v_user_id;
  ELSE UPDATE users SET role='accounting',location_id=NULL WHERE id=v_user_id; END IF;
 END IF;
END $$;

-- A live UAT kimutatta, hogy egy részben migrált adatbázisban a szerepkör-regiszter
-- lemaradhat a permission sorok mögött. A kanonikus mező neve `name`.
UPDATE access_roles SET
 name='Könyvelés',
 description='Könyvelői moduladmin: teljes jogosultság a Pénzügyek, NAV, bér, Beszerzés és Raktár/Készlet modulokban minden telephelyre. A szükséges ügyfél-, dolgozói-, riport-, tudástár- és törzsadatok elérhetők. Globális rendszer- és jogosultságadminisztráció nem része a szerepkörnek; munkalap csak lezárt és archivált.',
 level=80,is_system=true,is_active=true,updated_at=now()
WHERE lower(role_key)='accounting';
INSERT INTO access_roles(role_key,name,description,level,is_system,is_active,updated_at)
SELECT 'accounting','Könyvelés','Könyvelői moduladmin: teljes jogosultság a Pénzügyek, NAV, bér, Beszerzés és Raktár/Készlet modulokban minden telephelyre. A szükséges ügyfél-, dolgozói-, riport-, tudástár- és törzsadatok elérhetők. Globális rendszer- és jogosultságadminisztráció nem része a szerepkörnek; munkalap csak lezárt és archivált.',80,true,true,now()
WHERE NOT EXISTS(SELECT 1 FROM access_roles WHERE lower(role_key)='accounting');

-- A kanonikus szerepkör-regiszter két korábban fail-closed migrációval létrehozott
-- szerepkörét is helyreállítjuk, ha egy régi live DB-ben a szerepkör sor hiányzik.
INSERT INTO access_roles(role_key,name,description,level,is_system,is_active,updated_at)
SELECT x.role_key,x.name,x.description,x.level,true,true,now()
FROM (VALUES
 ('salon_manager','Szalonvezető','Saját telephely operatív adatai, alapvetően olvasási jogosultsággal',60),
 ('customer','Ügyfél','Saját foglalások, munkalapok és ügyfélfiók',10)
) x(role_key,name,description,level)
WHERE NOT EXISTS(SELECT 1 FROM access_roles ar WHERE lower(ar.role_key)=x.role_key);

-- A role_feature_permissions kanonikus sémája egy feature-szintű `can_use` kaput tartalmaz.
-- A műveletszintű CRUD/export jogokat a role_menu_permissions hordozza.
INSERT INTO role_feature_permissions(role_key,feature_key,can_use,scope_type,updated_at)
VALUES
 ('accounting','finance',true,'all_locations',now()),
 ('accounting','payroll',true,'all_locations',now()),
 ('accounting','inventory',true,'all_locations',now()),
 ('accounting','procurement',true,'all_locations',now()),
 ('accounting','hr',true,'all_locations',now()),
 ('accounting','employees',true,'all_locations',now()),
 ('accounting','clients',true,'all_locations',now()),
 ('accounting','crm',true,'all_locations',now()),
 ('accounting','reports',true,'all_locations',now()),
 ('accounting','management_dashboard',true,'all_locations',now()),
 ('accounting','knowledge_base',true,'all_locations',now()),
 ('accounting','audit',true,'all_locations',now()),
 ('accounting','marketing',true,'all_locations',now()),
 ('accounting','masterdata',true,'all_locations',now())
ON CONFLICT(role_key,feature_key) DO UPDATE SET
 can_use=EXCLUDED.can_use,scope_type='all_locations',updated_at=now();

-- Alapból minden menü tiltott; kizárólag a könyvelési munkakörhöz szükséges területek kapnak hozzáférést.
INSERT INTO role_menu_permissions(role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,can_manage_permissions,scope_type,updated_at)
SELECT 'accounting',m.id,false,false,false,false,false,false,false,false,'all_locations',now() FROM menus m
ON CONFLICT(role_key,menu_id) DO UPDATE SET can_view=false,can_create=false,can_edit=false,can_delete=false,can_approve=false,can_export=false,can_view_financial=false,can_manage_permissions=false,scope_type='all_locations',updated_at=now();

-- Teljes moduladmin: Pénzügy/NAV, bér, Beszerzés, Raktár/Készlet.
UPDATE role_menu_permissions p SET
 can_view=true,
 can_create=true,
 can_edit=true,
 can_delete=true,
 can_approve=true,
 can_export=true,
 can_view_financial=true,
 can_manage_permissions=false,
 scope_type='all_locations',
 updated_at=now()
FROM menus m
WHERE p.menu_id=m.id AND p.role_key='accounting' AND (
 m.code='finance' OR m.code LIKE 'finance.%' OR
 m.code LIKE 'payroll%' OR
 m.code='inventory' OR m.code LIKE 'inventory.%' OR
 m.code='procurement' OR m.code LIKE 'procurement.%'
);

-- Könyvelési forrás- és kontrolladatok: megtekintés/export minden telephelyre.
UPDATE role_menu_permissions p SET
 can_view=true,
 can_create=false,
 can_edit=false,
 can_delete=false,
 can_approve=false,
 can_export=true,
 can_view_financial=true,
 can_manage_permissions=false,
 scope_type='all_locations',
 updated_at=now()
FROM menus m
WHERE p.menu_id=m.id AND p.role_key='accounting' AND (
 m.code='dashboard' OR
 m.code LIKE 'employees%' OR m.code LIKE 'team.employees%' OR
 m.code LIKE 'clients%' OR m.code LIKE 'customers%' OR m.code LIKE 'crm%' OR
 m.code LIKE 'masterdata%' OR
 m.code LIKE 'reports%' OR
 m.code LIKE 'knowledge%' OR
 m.code LIKE 'audit%' OR m.code='settings.audit' OR
 m.code LIKE 'marketing%'
);

-- Munkalap könyvelőként csak lezárt/archivált bizonylati forrás, olvasásra és exportra.
UPDATE role_menu_permissions p SET
 can_view=true,can_create=false,can_edit=false,can_delete=false,can_approve=false,can_export=true,can_view_financial=true,can_manage_permissions=false,scope_type='all_locations',updated_at=now()
FROM menus m WHERE p.menu_id=m.id AND p.role_key='accounting' AND m.code='finance.workorders';

INSERT INTO schema_migrations(version,description,applied_at)
VALUES('20260814_ACCOUNTING_USER_RBAC_V1','Accounting module-admin for finance NAV payroll procurement inventory; supporting data read/export; no global permission admin',now())
ON CONFLICT(version) DO UPDATE SET description=EXCLUDED.description,applied_at=now();
COMMIT;
