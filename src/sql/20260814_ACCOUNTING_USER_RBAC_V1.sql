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
VALUES('accounting','Könyvelés','Teljes könyvelői munkakör: valamennyi telephely pénzügyei, NAV, számlák, bank/pénztár, bérfeladás, szállítók, készlet- és ügyfélforrásadatok, riportok, tudástár és ellenőrzések. Törlés és jogosultság-adminisztráció nélkül; munkalap csak lezárt és archivált.',70,true,true,now())
ON CONFLICT(role_key) DO UPDATE SET label=EXCLUDED.label,description=EXCLUDED.description,level=EXCLUDED.level,is_active=true,updated_at=now();

-- Könyvelői feature-jogok. A munkakörhöz szükséges üzleti forrásadatok minden szalonra kiterjednek.
INSERT INTO role_feature_permissions(role_key,feature_key,can_view,can_create,can_edit,can_delete,can_export,scope_type,updated_at)
VALUES
 ('accounting','finance',true,true,true,false,true,'all_locations',now()),
 ('accounting','payroll',true,true,true,false,true,'all_locations',now()),
 ('accounting','hr',true,false,false,false,true,'all_locations',now()),
 ('accounting','employees',true,false,false,false,true,'all_locations',now()),
 ('accounting','inventory',true,false,false,false,true,'all_locations',now()),
 ('accounting','procurement',true,true,true,false,true,'all_locations',now()),
 ('accounting','clients',true,false,false,false,true,'all_locations',now()),
 ('accounting','crm',true,false,false,false,true,'all_locations',now()),
 ('accounting','reports',true,false,false,false,true,'all_locations',now()),
 ('accounting','management_dashboard',true,false,false,false,true,'all_locations',now()),
 ('accounting','knowledge_base',true,false,false,false,true,'all_locations',now()),
 ('accounting','audit',true,false,false,false,true,'all_locations',now()),
 ('accounting','marketing',true,false,false,false,true,'all_locations',now()),
 ('accounting','masterdata',true,false,false,false,true,'all_locations',now())
ON CONFLICT(role_key,feature_key) DO UPDATE SET
 can_view=EXCLUDED.can_view,can_create=EXCLUDED.can_create,can_edit=EXCLUDED.can_edit,can_delete=false,can_export=EXCLUDED.can_export,scope_type='all_locations',updated_at=now();

-- Alaphelyzet: semmi nincs automatikusan engedélyezve, csak az alábbi könyvelői területek.
INSERT INTO role_menu_permissions(role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,manage_permissions,scope_type,updated_at)
SELECT 'accounting',m.id,false,false,false,false,false,false,false,false,'all_locations',now() FROM menus m
ON CONFLICT(role_key,menu_id) DO UPDATE SET can_view=false,can_create=false,can_edit=false,can_delete=false,can_approve=false,can_export=false,can_view_financial=false,manage_permissions=false,scope_type='all_locations',updated_at=now();

-- Minden, ami a könyvelési munkához szükséges, látható és exportálható.
-- Pénzügy/NAV/bér/beszerzés területen rögzítés és módosítás is engedélyezett.
UPDATE role_menu_permissions p SET
 can_view=true,
 can_create=CASE
   WHEN m.code='finance' OR m.code LIKE 'finance.%' OR m.code LIKE 'payroll%' OR m.code LIKE 'procurement%' THEN true
   ELSE false END,
 can_edit=CASE
   WHEN m.code='finance' OR m.code LIKE 'finance.%' OR m.code LIKE 'payroll%' OR m.code LIKE 'procurement%' THEN true
   ELSE false END,
 can_delete=false,
 can_approve=CASE WHEN m.code LIKE 'finance.%' OR m.code LIKE 'procurement%' THEN true ELSE false END,
 can_export=true,
 can_view_financial=true,
 manage_permissions=false,
 scope_type='all_locations',
 updated_at=now()
FROM menus m
WHERE p.menu_id=m.id AND p.role_key='accounting' AND (
 m.code='dashboard' OR
 m.code='finance' OR m.code LIKE 'finance.%' OR
 m.code LIKE 'payroll%' OR
 m.code LIKE 'employees%' OR m.code LIKE 'team.employees%' OR
 m.code LIKE 'inventory%' OR
 m.code LIKE 'procurement%' OR
 m.code LIKE 'clients%' OR m.code LIKE 'customers%' OR m.code LIKE 'crm%' OR
 m.code LIKE 'masterdata%' OR
 m.code LIKE 'reports%' OR
 m.code LIKE 'knowledge%' OR
 m.code LIKE 'audit%' OR m.code='settings.audit' OR
 m.code LIKE 'marketing%'
);

-- A munkalap könyvelőként kizárólag bizonylati forrás: csak lezárt/archivált és csak olvasás/export.
UPDATE role_menu_permissions p SET
 can_view=true,can_create=false,can_edit=false,can_delete=false,can_approve=false,can_export=true,can_view_financial=true,manage_permissions=false,scope_type='all_locations',updated_at=now()
FROM menus m WHERE p.menu_id=m.id AND p.role_key='accounting' AND m.code='finance.workorders';

INSERT INTO schema_migrations(version,description,applied_at)
VALUES('20260814_ACCOUNTING_USER_RBAC_V1','Complete accounting RBAC: finance/NAV/payroll/procurement edit, operational sources read/export, no delete/admin, archived workorders only',now())
ON CONFLICT(version) DO UPDATE SET description=EXCLUDED.description,applied_at=now();
COMMIT;
