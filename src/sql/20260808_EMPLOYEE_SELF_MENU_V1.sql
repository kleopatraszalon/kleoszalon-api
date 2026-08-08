BEGIN;

-- Munkatársi chat a Csapat és HR csoport alatt.
INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
SELECT 'team.chat','Munkatársi chat','MessagesSquare','/staff/chat',35,p.id,'staff_chat',true
FROM menus p
WHERE p.code='team'
ON CONFLICT(code) DO UPDATE SET
 name=EXCLUDED.name,icon=EXCLUDED.icon,route=EXCLUDED.route,order_index=EXCLUDED.order_index,
 parent_id=EXCLUDED.parent_id,feature_key=EXCLUDED.feature_key,is_active=true;

-- A munkatársi/receptiós felület csak a saját munkavégzéshez szükséges menüket kapja.
UPDATE role_menu_permissions
SET can_view=false,can_create=false,can_edit=false,can_delete=false,can_approve=false,
    can_export=false,can_view_financial=false,can_manage_permissions=false,updated_at=now()
WHERE role_key IN ('employee','receptionist');

WITH wanted(code,scope_type,can_edit) AS (
  VALUES
    ('dashboard','own',false),
    ('team','own',false),
    ('team.schedule','own_location',true),
    ('team.chat','own_location',true),
    ('knowledge','own',false),
    ('knowledge.checklists','own',true)
)
INSERT INTO role_menu_permissions(
  role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,
  can_view_financial,can_manage_permissions,scope_type
)
SELECT r.role_key,m.id,true,false,w.can_edit,false,false,false,false,false,w.scope_type
FROM wanted w
JOIN menus m ON m.code=w.code
CROSS JOIN (VALUES('employee'),('receptionist')) r(role_key)
ON CONFLICT(role_key,menu_id) DO UPDATE SET
 can_view=true,can_create=false,can_edit=EXCLUDED.can_edit,can_delete=false,can_approve=false,
 can_export=false,can_view_financial=false,can_manage_permissions=false,scope_type=EXCLUDED.scope_type,updated_at=now();

INSERT INTO role_feature_permissions(role_key,feature_key,can_use,scope_type)
VALUES
 ('employee','staff_chat',true,'own_location'),
 ('receptionist','staff_chat',true,'own_location')
ON CONFLICT(role_key,feature_key) DO UPDATE SET can_use=true,scope_type=EXCLUDED.scope_type,updated_at=now();

INSERT INTO schema_migrations(version,description)
VALUES('20260808_EMPLOYEE_SELF_MENU_V1','Munkatársi saját menü: dashboard, beosztás, check lista és chat')
ON CONFLICT(version) DO NOTHING;

COMMIT;
