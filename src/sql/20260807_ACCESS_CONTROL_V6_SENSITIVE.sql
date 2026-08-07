BEGIN;

-- ============================================================
-- ÉRZÉKENY JOGOSULTSÁGOK – AI / CHAT / AUDIT / DASHBOARD / BÉRADAT
-- ============================================================

-- Feature-szintű alapok.
INSERT INTO role_feature_permissions(role_key,feature_key,can_use,scope_type,updated_at)
VALUES
  ('admin','ai_use',true,'all_locations',now()),
  ('admin','ai_stats',true,'all_locations',now()),
  ('admin','staff_chat',true,'all_locations',now()),
  ('admin','staff_chat_all',true,'all_locations',now()),
  ('admin','management_dashboard',true,'all_locations',now()),
  ('admin','audit',true,'all_locations',now()),

  ('manager','ai_use',true,'all_locations',now()),
  ('manager','ai_stats',true,'all_locations',now()),
  ('manager','staff_chat',true,'all_locations',now()),
  ('manager','staff_chat_all',true,'all_locations',now()),
  ('manager','management_dashboard',true,'all_locations',now()),
  ('manager','audit',true,'all_locations',now()),

  ('receptionist','ai_use',true,'own_location',now()),
  ('receptionist','ai_stats',false,'own_location',now()),
  ('receptionist','staff_chat',true,'own_location',now()),
  ('receptionist','staff_chat_all',false,'own_location',now()),
  ('receptionist','management_dashboard',false,'own_location',now()),
  ('receptionist','audit',false,'own_location',now()),

  ('employee','ai_use',true,'own',now()),
  ('employee','ai_stats',false,'own',now()),
  ('employee','staff_chat',true,'own',now()),
  ('employee','staff_chat_all',false,'own',now()),
  ('employee','management_dashboard',false,'own',now()),
  ('employee','audit',false,'own',now())
ON CONFLICT(role_key,feature_key) DO UPDATE SET
  can_use=EXCLUDED.can_use,
  scope_type=EXCLUDED.scope_type,
  updated_at=now();

-- ADMIN: érzékeny menük teljes joga.
INSERT INTO role_menu_permissions(
  role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,
  can_export,can_view_financial,can_manage_permissions,scope_type,updated_at
)
SELECT 'admin',m.id,true,true,true,true,true,true,true,true,'all_locations',now()
FROM menus m
WHERE COALESCE(m.is_active,true)
  AND m.code IN ('analytics','analytics.main','team.payroll','settings.audit')
ON CONFLICT(role_key,menu_id) DO UPDATE SET
  can_view=true,can_create=true,can_edit=true,can_delete=true,can_approve=true,
  can_export=true,can_view_financial=true,can_manage_permissions=true,
  scope_type='all_locations',updated_at=now();

-- MANAGER: pénzügyi KPI és béradat megtekinthető; audit olvasható/exportálható.
INSERT INTO role_menu_permissions(
  role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,
  can_export,can_view_financial,can_manage_permissions,scope_type,updated_at
)
SELECT 'manager',m.id,
  true,
  CASE WHEN m.code='team.payroll' THEN true ELSE false END,
  CASE WHEN m.code='team.payroll' THEN true ELSE false END,
  false,
  CASE WHEN m.code='team.payroll' THEN true ELSE false END,
  CASE WHEN m.code IN ('analytics.main','settings.audit') THEN true ELSE false END,
  CASE WHEN m.code IN ('analytics','analytics.main','team.payroll') THEN true ELSE false END,
  false,
  'all_locations',now()
FROM menus m
WHERE COALESCE(m.is_active,true)
  AND m.code IN ('analytics','analytics.main','team.payroll','settings.audit')
ON CONFLICT(role_key,menu_id) DO UPDATE SET
  can_view=EXCLUDED.can_view,
  can_create=EXCLUDED.can_create,
  can_edit=EXCLUDED.can_edit,
  can_delete=EXCLUDED.can_delete,
  can_approve=EXCLUDED.can_approve,
  can_export=EXCLUDED.can_export,
  can_view_financial=EXCLUDED.can_view_financial,
  scope_type=EXCLUDED.scope_type,
  updated_at=now();

-- RECEPCIÓ: nincs béradat, pénzügyi dashboard KPI, audit vagy AI-statisztika.
INSERT INTO role_menu_permissions(
  role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,
  can_export,can_view_financial,can_manage_permissions,scope_type,updated_at
)
SELECT 'receptionist',m.id,
  CASE WHEN m.code='analytics' THEN true ELSE false END,
  false,false,false,false,false,false,false,'own_location',now()
FROM menus m
WHERE COALESCE(m.is_active,true)
  AND m.code IN ('analytics','analytics.main','team.payroll','settings.audit')
ON CONFLICT(role_key,menu_id) DO UPDATE SET
  can_view=EXCLUDED.can_view,
  can_create=false,can_edit=false,can_delete=false,can_approve=false,
  can_export=false,can_view_financial=false,can_manage_permissions=false,
  scope_type='own_location',updated_at=now();

-- MUNKATÁRS: érzékeny dashboard, béradmin és audit tiltott.
INSERT INTO role_menu_permissions(
  role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,
  can_export,can_view_financial,can_manage_permissions,scope_type,updated_at
)
SELECT 'employee',m.id,false,false,false,false,false,false,false,false,'own',now()
FROM menus m
WHERE COALESCE(m.is_active,true)
  AND m.code IN ('analytics','analytics.main','team.payroll','settings.audit')
ON CONFLICT(role_key,menu_id) DO UPDATE SET
  can_view=false,can_create=false,can_edit=false,can_delete=false,can_approve=false,
  can_export=false,can_view_financial=false,can_manage_permissions=false,
  scope_type='own',updated_at=now();

COMMIT;

-- Ellenőrzés:
-- SELECT role_key,feature_key,can_use,scope_type
-- FROM role_feature_permissions
-- WHERE feature_key IN ('ai_use','ai_stats','staff_chat','staff_chat_all','management_dashboard','audit')
-- ORDER BY role_key,feature_key;
--
-- SELECT p.role_key,m.code,p.can_view,p.can_edit,p.can_export,p.can_view_financial,p.scope_type
-- FROM role_menu_permissions p JOIN menus m ON m.id=p.menu_id
-- WHERE m.code IN ('analytics','analytics.main','team.payroll','settings.audit')
-- ORDER BY p.role_key,m.code;
