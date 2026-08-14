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

INSERT INTO access_roles(role_key,label,description,level,is_system,is_active,updated_at)
VALUES('accounting','Könyvelés','Könyvelői moduladmin: teljes jogosultság a Pénzügyek, NAV, bér, Beszerzés és Raktár/Készlet modulokban minden telephelyre. A szükséges ügyfél-, dolgozói-, riport-, tudástár- és törzsadatok elérhetők. Globális rendszer- és jogosultságadminisztráció nem része a szerepkörnek; munkalap csak lezárt és archivált.',80,true,true,now())
ON CONFLICT(role_key) DO UPDATE SET label=EXCLUDED.label,description=EXCLUDED.description,level=EXCLUDED.level,is_active=true,updated_at=now();

-- Moduladmin jogosultságok a könyvelő napi munkaterületein.
INSERT INTO role_feature_permissions(role_key,feature_key,can_view,can_create,can_edit,can_delete,can_export,scope_type,updated_at)
VALUES
 ('accounting','finance',true,true,true,true,true,'all_locations',now()),
 ('accounting','payroll',true,true,true,true,true,'all_locations',now()),
 ('accounting','inventory',true,true,true,true,true,'all_locations',now()),
 ('accounting','procurement',true,true,true,true,true,'all_locations',now()),
 ('accounting','hr',true,false,false,false,true,'all_locations',now()),
 ('accounting','employees',true,false,false,false,true,'all_locations',now()),
 ('accounting','clients',true,false,false,false,true,'all_locations',now()),
 ('accounting','crm',true,false,false,false,true,'all_locations',now()),
 ('accounting','reports',true,false,false,false,true,'all_locations',now()),
 ('accounting','management_dashboard',true,false,false,false,true,'all_locations',now()),
 ('accounting','knowledge_base',true,false,false,false,true,'all_locations',now()),
 ('accounting','audit',true,false,false,false,true,'all_locations',now()),
 ('accounting','marketing',true,false,false,false,true,'all_locations',now()),
 ('accounting','masterdata',true,false,false,false,true,'all_locations',now())
ON CONFLICT(role_key,feature_key) DO UPDATE SET
 can_view=EXCLUDED.can_view,can_create=EXCLUDED.can_create,can_edit=EXCLUDED.can_edit,can_delete=EXCLUDED.can_delete,can_export=EXCLUDED.can_export,scope_type='all_locations',updated_at=now();

-- Alapból minden menü tiltott; kizárólag a könyvelési munkakörhöz szükséges területek kapnak hozzáférést.
INSERT INTO role_menu_permissions(role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,manage_permissions,scope_type,updated_at)
SELECT 'accounting',m.id,false,false,false,false,false,false,false,false,'all_locations',now() FROM menus m
ON CONFLICT(role_key,menu_id) DO UPDATE SET can_view=false,can_create=false,can_edit=false,can_delete=false,can_approve=false,can_export=false,can_view_financial=false,manage_permissions=false,scope_type='all_locations',updated_at=now();

-- Teljes moduladmin: Pénzügy/NAV, bér, Beszerzés, Raktár/Készlet.
UPDATE role_menu_permissions p SET
 can_view=true,
 can_create=true,
 can_edit=true,
 can_delete=true,
 can_approve=true,
 can_export=true,
 can_view_financial=true,
 manage_permissions=false,
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
 manage_permissions=false,
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
 can_view=true,can_create=false,can_edit=false,can_delete=false,can_approve=false,can_export=true,can_view_financial=true,manage_permissions=false,scope_type='all_locations',updated_at=now()
FROM menus m WHERE p.menu_id=m.id AND p.role_key='accounting' AND m.code='finance.workorders';

INSERT INTO schema_migrations(version,description,applied_at)
VALUES('20260814_ACCOUNTING_USER_RBAC_V1','Accounting module-admin for finance NAV payroll procurement inventory; supporting data read/export; no global permission admin',now())
ON CONFLICT(version) DO UPDATE SET description=EXCLUDED.description,applied_at=now();
COMMIT;
