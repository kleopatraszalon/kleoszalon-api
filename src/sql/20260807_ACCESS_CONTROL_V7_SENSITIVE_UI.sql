BEGIN;

-- Audit menü valódi oldalra kötése.
UPDATE menus
SET name='Audit és rendszeresemény-napló',
    route='/modules/settings/audit-log',
    feature_key='audit',
    is_active=true
WHERE code='settings.audit';

-- Chat felügyelet külön adminisztrációs menüpont.
WITH parent AS (
  SELECT id FROM menus WHERE code='settings' LIMIT 1
)
INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
SELECT 'settings.chat-supervision','Munkatársi chat felügyelet',NULL,
       '/modules/settings/chat-supervision',55,parent.id,'staff_chat_all',true
FROM parent
ON CONFLICT(code) DO UPDATE SET
  name=EXCLUDED.name,
  route=EXCLUDED.route,
  order_index=EXCLUDED.order_index,
  parent_id=EXCLUDED.parent_id,
  feature_key=EXCLUDED.feature_key,
  is_active=true;

-- Admin: teljes audit + chat felügyelet.
INSERT INTO role_menu_permissions(
  role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,
  can_export,can_view_financial,can_manage_permissions,scope_type,updated_at
)
SELECT 'admin',m.id,true,true,true,true,true,true,true,true,'all_locations',now()
FROM menus m
WHERE m.code IN ('settings.audit','settings.chat-supervision')
ON CONFLICT(role_key,menu_id) DO UPDATE SET
  can_view=true,can_create=true,can_edit=true,can_delete=true,can_approve=true,
  can_export=true,can_view_financial=true,can_manage_permissions=true,
  scope_type='all_locations',updated_at=now();

-- Manager: megtekintés + audit export + teljes chat felügyelet, admin jog nélkül.
INSERT INTO role_menu_permissions(
  role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,
  can_export,can_view_financial,can_manage_permissions,scope_type,updated_at
)
SELECT 'manager',m.id,true,false,false,false,false,
       CASE WHEN m.code='settings.audit' THEN true ELSE false END,
       false,false,'all_locations',now()
FROM menus m
WHERE m.code IN ('settings.audit','settings.chat-supervision')
ON CONFLICT(role_key,menu_id) DO UPDATE SET
  can_view=EXCLUDED.can_view,
  can_create=false,can_edit=false,can_delete=false,can_approve=false,
  can_export=EXCLUDED.can_export,
  can_view_financial=false,can_manage_permissions=false,
  scope_type='all_locations',updated_at=now();

-- Recepció és munkatárs ne lássa a felügyeleti menüpontokat.
INSERT INTO role_menu_permissions(
  role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,
  can_export,can_view_financial,can_manage_permissions,scope_type,updated_at
)
SELECT r.role_key,m.id,false,false,false,false,false,false,false,false,
       CASE WHEN r.role_key='employee' THEN 'own' ELSE 'own_location' END,now()
FROM (VALUES('receptionist'),('employee')) r(role_key)
CROSS JOIN menus m
WHERE m.code IN ('settings.audit','settings.chat-supervision')
ON CONFLICT(role_key,menu_id) DO UPDATE SET
  can_view=false,can_create=false,can_edit=false,can_delete=false,can_approve=false,
  can_export=false,can_view_financial=false,can_manage_permissions=false,
  scope_type=EXCLUDED.scope_type,updated_at=now();

-- Feature szint.
INSERT INTO role_feature_permissions(role_key,feature_key,can_use,scope_type,updated_at)
VALUES
 ('admin','staff_chat_all',true,'all_locations',now()),
 ('manager','staff_chat_all',true,'all_locations',now()),
 ('receptionist','staff_chat_all',false,'own_location',now()),
 ('employee','staff_chat_all',false,'own',now()),
 ('admin','audit',true,'all_locations',now()),
 ('manager','audit',true,'all_locations',now()),
 ('receptionist','audit',false,'own_location',now()),
 ('employee','audit',false,'own',now())
ON CONFLICT(role_key,feature_key) DO UPDATE SET
 can_use=EXCLUDED.can_use,scope_type=EXCLUDED.scope_type,updated_at=now();

COMMIT;

-- Ellenőrzés:
-- SELECT m.code,m.name,m.route,m.feature_key,p.role_key,p.can_view,p.can_export
-- FROM menus m LEFT JOIN role_menu_permissions p ON p.menu_id=m.id
-- WHERE m.code IN ('settings.audit','settings.chat-supervision') ORDER BY m.code,p.role_key;
