BEGIN;
INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
SELECT 'settings.system-health','Rendszerellenőrzés / UAT','ClipboardCheck','/admin/system-health',85,s.id,NULL,true
FROM menus s WHERE s.code='settings'
ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,icon=EXCLUDED.icon,route=EXCLUDED.route,order_index=EXCLUDED.order_index,parent_id=EXCLUDED.parent_id,is_active=true;
INSERT INTO role_menu_permissions(role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,can_manage_permissions,scope_type)
SELECT 'admin',m.id,true,false,false,false,false,true,true,true,'all_locations' FROM menus m WHERE m.code='settings.system-health'
ON CONFLICT(role_key,menu_id) DO UPDATE SET can_view=true,can_export=true,can_view_financial=true,can_manage_permissions=true,scope_type='all_locations';
COMMIT;
