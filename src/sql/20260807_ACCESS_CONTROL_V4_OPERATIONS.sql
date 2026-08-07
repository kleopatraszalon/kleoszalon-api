BEGIN;

-- ============================================================
-- MŰVELETSZINTŰ ALAPJOGOSULTSÁGOK – PÉNZÜGY / HR / RAKTÁR
-- Idempotens: meglévő egyedi admin-beállításokat nem ír felül,
-- kivéve az admin szerepkört, amely mindig teljes hozzáférésű.
-- ============================================================

-- ADMIN: minden aktív menüponton teljes hozzáférés.
INSERT INTO role_menu_permissions(
  role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,
  can_export,can_view_financial,can_manage_permissions,scope_type,updated_at
)
SELECT 'admin',m.id,true,true,true,true,true,true,true,true,'all_locations',now()
FROM menus m
WHERE COALESCE(m.is_active,true)
ON CONFLICT(role_key,menu_id) DO UPDATE SET
  can_view=true,can_create=true,can_edit=true,can_delete=true,can_approve=true,
  can_export=true,can_view_financial=true,can_manage_permissions=true,
  scope_type='all_locations',updated_at=now();

-- MANAGER: üzleti modulok teljes kezelése, törlés és jogosultság-admin nélkül.
INSERT INTO role_menu_permissions(
  role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,
  can_export,can_view_financial,can_manage_permissions,scope_type,updated_at
)
SELECT 'manager',m.id,true,true,true,false,true,true,true,false,'all_locations',now()
FROM menus m
WHERE COALESCE(m.is_active,true)
  AND (
    m.code IN ('finance','team','inventory','analytics','procurement')
    OR m.code LIKE 'finance.%'
    OR m.code LIKE 'team.%'
    OR m.code LIKE 'inventory.%'
    OR m.code LIKE 'analytics.%'
    OR m.code LIKE 'procurement.%'
    OR m.code='settings.audit'
  )
ON CONFLICT(role_key,menu_id) DO NOTHING;

-- RECEPCIÓ: pénztár napi használata, HR alapadatok olvasása,
-- raktárkészlet és beszerzési operáció; béradat, törlés és jóváhagyás nélkül.
INSERT INTO role_menu_permissions(
  role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,
  can_export,can_view_financial,can_manage_permissions,scope_type,updated_at
)
SELECT 'receptionist',m.id,
  true,
  CASE WHEN m.code IN (
    'finance.checkout','finance.transactions','finance.workorders',
    'inventory.stock','inventory.transfers','inventory.usage',
    'procurement.suggestions','procurement.orders','procurement.suppliers'
  ) THEN true ELSE false END,
  CASE WHEN m.code IN (
    'finance.checkout','finance.workorders',
    'inventory.stock','inventory.transfers','inventory.usage',
    'procurement.orders','procurement.suppliers','procurement.prices'
  ) THEN true ELSE false END,
  false,
  false,
  CASE WHEN m.code IN ('finance.transactions','finance.workorders','inventory.stock','procurement.orders') THEN true ELSE false END,
  CASE WHEN m.code IN ('finance.checkout','finance.transactions','finance.cash','finance.workorders') THEN true ELSE false END,
  false,
  'own_location',now()
FROM menus m
WHERE COALESCE(m.is_active,true)
  AND m.code IN (
    'finance','finance.checkout','finance.transactions','finance.cash','finance.workorders',
    'team','team.employees','team.schedule','team.vacations',
    'inventory','inventory.products','inventory.stock','inventory.transfers','inventory.usage','inventory.adjustment',
    'procurement','procurement.dashboard','procurement.suggestions','procurement.orders','procurement.suppliers','procurement.prices'
  )
ON CONFLICT(role_key,menu_id) DO NOTHING;

-- MUNKATÁRS: saját HR/beosztási információk láthatók, pénzügy/raktár/beszerzés tiltva.
INSERT INTO role_menu_permissions(
  role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,
  can_export,can_view_financial,can_manage_permissions,scope_type,updated_at
)
SELECT 'employee',m.id,
  CASE WHEN m.code IN ('team','team.employees','team.schedule','team.vacations') THEN true ELSE false END,
  false,false,false,false,false,false,false,
  'own',now()
FROM menus m
WHERE COALESCE(m.is_active,true)
  AND (
    m.code IN ('finance','team','inventory','procurement')
    OR m.code LIKE 'finance.%'
    OR m.code LIKE 'team.%'
    OR m.code LIKE 'inventory.%'
    OR m.code LIKE 'procurement.%'
  )
ON CONFLICT(role_key,menu_id) DO NOTHING;

-- Feature-szintű biztosítás.
INSERT INTO role_feature_permissions(role_key,feature_key,can_use,scope_type,updated_at)
VALUES
  ('admin','finance',true,'all_locations',now()),
  ('admin','hr',true,'all_locations',now()),
  ('admin','inventory',true,'all_locations',now()),
  ('admin','audit',true,'all_locations',now()),
  ('manager','finance',true,'all_locations',now()),
  ('manager','hr',true,'all_locations',now()),
  ('manager','inventory',true,'all_locations',now()),
  ('manager','audit',true,'all_locations',now()),
  ('receptionist','finance',true,'own_location',now()),
  ('receptionist','hr',true,'own_location',now()),
  ('receptionist','inventory',true,'own_location',now()),
  ('receptionist','audit',false,'own_location',now()),
  ('employee','finance',false,'own',now()),
  ('employee','hr',true,'own',now()),
  ('employee','inventory',false,'own',now()),
  ('employee','audit',false,'own',now())
ON CONFLICT(role_key,feature_key) DO NOTHING;

COMMIT;

-- Ellenőrzés:
-- SELECT p.role_key,m.code,p.can_view,p.can_create,p.can_edit,p.can_delete,
--        p.can_approve,p.can_export,p.can_view_financial,p.scope_type
-- FROM role_menu_permissions p JOIN menus m ON m.id=p.menu_id
-- WHERE m.code IN ('finance','team','inventory','settings.audit')
--    OR m.code LIKE 'finance.%' OR m.code LIKE 'team.%' OR m.code LIKE 'inventory.%'
-- ORDER BY p.role_key,m.order_index,m.id;
