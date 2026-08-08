BEGIN;

WITH p AS (SELECT id FROM menus WHERE code='knowledge' LIMIT 1)
INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
SELECT 'knowledge.checklists','Check listák','ClipboardCheck','/knowledge-base/checklists',15,p.id,'knowledge_base',true
FROM p
ON CONFLICT(code) DO UPDATE SET
  name=EXCLUDED.name,
  icon=EXCLUDED.icon,
  route=EXCLUDED.route,
  order_index=EXCLUDED.order_index,
  parent_id=EXCLUDED.parent_id,
  feature_key=EXCLUDED.feature_key,
  is_active=true;

INSERT INTO role_menu_permissions(
  role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,
  can_export,can_view_financial,can_manage_permissions,scope_type,updated_at
)
SELECT 'admin',m.id,true,true,true,true,true,true,true,true,'all_locations',now()
FROM menus m
WHERE m.code IN ('knowledge','knowledge.checklists')
ON CONFLICT(role_key,menu_id) DO UPDATE SET
  can_view=true,can_create=true,can_edit=true,can_delete=true,can_approve=true,
  can_export=true,can_view_financial=true,can_manage_permissions=true,
  scope_type='all_locations',updated_at=now();

INSERT INTO role_menu_permissions(
  role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,
  can_export,can_view_financial,can_manage_permissions,scope_type,updated_at
)
SELECT r.role_key,m.id,true,false,false,false,false,false,false,false,r.scope_type,now()
FROM (VALUES
  ('manager','all_locations'),
  ('receptionist','own_location'),
  ('employee','own')
) AS r(role_key,scope_type)
JOIN menus m ON m.code IN ('knowledge','knowledge.checklists')
ON CONFLICT(role_key,menu_id) DO UPDATE SET
  can_view=true,
  scope_type=EXCLUDED.scope_type,
  updated_at=now();

INSERT INTO schema_migrations(version,description)
VALUES ('20260808_CHECKLIST_MENU_V1','Tudásbázis / Check listák menü és szerepkör alapú láthatóság')
ON CONFLICT(version) DO NOTHING;

COMMIT;
