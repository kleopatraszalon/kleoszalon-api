BEGIN;

-- Dedicated bookkeeping account. The source contains only a bcrypt hash, never the clear-text password.
DO $$
DECLARE
  v_role_type text;
  v_user_id uuid;
BEGIN
  SELECT udt_name INTO v_role_type
  FROM information_schema.columns
  WHERE table_schema='public' AND table_name='users' AND column_name='role'
  LIMIT 1;

  SELECT id INTO v_user_id
  FROM users
  WHERE lower(COALESCE(login_name,''))=lower('könyvelés')
     OR lower(COALESCE(email,''))=lower('konyveles@kleoszalon.hu')
  LIMIT 1;

  IF v_user_id IS NULL THEN
    IF v_role_type='jsonb' THEN
      INSERT INTO users(full_name,email,login_name,password_hash,role,location_id)
      VALUES('Könyvelés','konyveles@kleoszalon.hu','könyvelés','$2b$12$7yCjqwhiLLMvIH0H8wzDIud7cTOHC.uU2MZUKIDWrYhbzGZvocwsO','["accounting"]'::jsonb,NULL);
    ELSIF v_role_type='json' THEN
      INSERT INTO users(full_name,email,login_name,password_hash,role,location_id)
      VALUES('Könyvelés','konyveles@kleoszalon.hu','könyvelés','$2b$12$7yCjqwhiLLMvIH0H8wzDIud7cTOHC.uU2MZUKIDWrYhbzGZvocwsO','["accounting"]'::json,NULL);
    ELSE
      INSERT INTO users(full_name,email,login_name,password_hash,role,location_id)
      VALUES('Könyvelés','konyveles@kleoszalon.hu','könyvelés','$2b$12$7yCjqwhiLLMvIH0H8wzDIud7cTOHC.uU2MZUKIDWrYhbzGZvocwsO','accounting',NULL);
    END IF;
  ELSE
    IF v_role_type='jsonb' THEN
      UPDATE users SET full_name='Könyvelés',email='konyveles@kleoszalon.hu',login_name='könyvelés',password_hash='$2b$12$7yCjqwhiLLMvIH0H8wzDIud7cTOHC.uU2MZUKIDWrYhbzGZvocwsO',role='["accounting"]'::jsonb,location_id=NULL WHERE id=v_user_id;
    ELSIF v_role_type='json' THEN
      UPDATE users SET full_name='Könyvelés',email='konyveles@kleoszalon.hu',login_name='könyvelés',password_hash='$2b$12$7yCjqwhiLLMvIH0H8wzDIud7cTOHC.uU2MZUKIDWrYhbzGZvocwsO',role='["accounting"]'::json,location_id=NULL WHERE id=v_user_id;
    ELSE
      UPDATE users SET full_name='Könyvelés',email='konyveles@kleoszalon.hu',login_name='könyvelés',password_hash='$2b$12$7yCjqwhiLLMvIH0H8wzDIud7cTOHC.uU2MZUKIDWrYhbzGZvocwsO',role='accounting',location_id=NULL WHERE id=v_user_id;
    END IF;
  END IF;
END $$;

INSERT INTO access_roles(role_key,label,description,level,is_system,is_active,updated_at)
VALUES('accounting','Könyvelés','Központi pénzügyi és könyvelési hozzáférés; munkalapok csak lezárt és archivált állapotban.',60,true,true,now())
ON CONFLICT(role_key) DO UPDATE SET
  label=EXCLUDED.label,
  description=EXCLUDED.description,
  level=EXCLUDED.level,
  is_active=true,
  updated_at=now();

INSERT INTO role_feature_permissions(role_key,feature_key,can_view,can_create,can_edit,can_delete,can_export,scope_type,updated_at)
VALUES('accounting','finance',true,true,true,false,true,'all_locations',now())
ON CONFLICT(role_key,feature_key) DO UPDATE SET
  can_view=true,can_create=true,can_edit=true,can_delete=false,can_export=true,scope_type='all_locations',updated_at=now();

-- Fail closed: every non-accounting menu remains hidden unless explicitly granted below.
INSERT INTO role_menu_permissions(role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,manage_permissions,scope_type,updated_at)
SELECT 'accounting',m.id,false,false,false,false,false,false,false,false,'all_locations',now()
FROM menus m
ON CONFLICT(role_key,menu_id) DO UPDATE SET
  can_view=false,can_create=false,can_edit=false,can_delete=false,can_approve=false,can_export=false,can_view_financial=false,manage_permissions=false,scope_type='all_locations',updated_at=now();

-- Accounting navigation: role dashboard + the finance tree. Work orders are deliberately read-only.
UPDATE role_menu_permissions p
SET can_view=true,
    can_create=CASE WHEN m.code='finance.workorders' THEN false ELSE true END,
    can_edit=CASE WHEN m.code='finance.workorders' THEN false ELSE true END,
    can_delete=false,
    can_approve=false,
    can_export=true,
    can_view_financial=true,
    manage_permissions=false,
    scope_type='all_locations',
    updated_at=now()
FROM menus m
WHERE p.menu_id=m.id
  AND p.role_key='accounting'
  AND (m.code='dashboard' OR m.code='finance' OR (m.code LIKE 'finance.%' AND m.code<>'finance.payroll'));

INSERT INTO schema_migrations(version,description,applied_at)
VALUES('20260814_ACCOUNTING_USER_RBAC_V1','Accounting user, finance RBAC and read-only archived workorder access',now())
ON CONFLICT(version) DO UPDATE SET description=EXCLUDED.description,applied_at=now();

COMMIT;
