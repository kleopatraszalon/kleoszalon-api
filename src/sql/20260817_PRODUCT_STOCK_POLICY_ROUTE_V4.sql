BEGIN;
UPDATE vir_module_definitions SET route='/spec/product-stock-policy',updated_at=now() WHERE module_key='product-stock-policy';
INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
VALUES(
 'inventory.product-stock-policy','Termék készletszabályok','PackageCheck','/spec/product-stock-policy',63,
 (SELECT id FROM menus WHERE code IN('warehouse','inventory','masterdata') ORDER BY CASE code WHEN 'warehouse' THEN 0 WHEN 'inventory' THEN 1 ELSE 2 END LIMIT 1),
 'inventory',true
)
ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,icon=EXCLUDED.icon,route=EXCLUDED.route,order_index=EXCLUDED.order_index,
 parent_id=EXCLUDED.parent_id,feature_key=EXCLUDED.feature_key,is_active=true;
INSERT INTO role_menu_permissions
 (role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,can_manage_permissions,scope_type)
SELECT 'admin',m.id,true,true,true,false,true,true,true,true,'all_locations' FROM menus m WHERE m.code='inventory.product-stock-policy'
ON CONFLICT(role_key,menu_id) DO NOTHING;
INSERT INTO role_menu_permissions
 (role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,can_manage_permissions,scope_type)
SELECT 'manager',m.id,true,true,true,false,true,true,true,false,'all_locations' FROM menus m WHERE m.code='inventory.product-stock-policy'
ON CONFLICT(role_key,menu_id) DO NOTHING;
INSERT INTO schema_migrations(version,description)
VALUES('20260817_PRODUCT_STOCK_POLICY_ROUTE_V4','Termék készletszabály kezelőfelület átvezetése a generikus VIR /spec útvonalra')
ON CONFLICT(version) DO NOTHING;
COMMIT;
