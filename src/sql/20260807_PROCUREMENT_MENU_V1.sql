BEGIN;

INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
VALUES ('procurement','Beszerzés','ShoppingBag',NULL,75,NULL,'inventory',true)
ON CONFLICT(code) DO UPDATE SET
  name=EXCLUDED.name,
  icon=EXCLUDED.icon,
  route=EXCLUDED.route,
  order_index=EXCLUDED.order_index,
  parent_id=NULL,
  feature_key='inventory',
  is_active=true;

WITH p AS (SELECT id FROM menus WHERE code='procurement')
INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
SELECT x.code,x.name,NULL,x.route,x.order_index,p.id,'inventory',true
FROM p CROSS JOIN (VALUES
  ('procurement.dashboard','Beszerzési dashboard','/warehouse?view=procurement&section=dashboard',10),
  ('procurement.suggestions','Rendelési javaslatok','/warehouse?view=procurement&section=suggestions',20),
  ('procurement.approvals','Jóváhagyásra vár','/warehouse?view=procurement&section=approvals',30),
  ('procurement.orders','Beszerzési rendelések','/warehouse?view=procurement&section=orders',40),
  ('procurement.suppliers','Beszállítók','/warehouse?view=procurement&section=suppliers',50),
  ('procurement.prices','Beszállítói árak','/warehouse?view=procurement&section=prices',60),
  ('procurement.performance','Beszállítói teljesítmény','/warehouse?view=procurement&section=performance',70),
  ('procurement.deviations','Eltérések','/warehouse?view=procurement&section=deviations',80)
) AS x(code,name,route,order_index)
ON CONFLICT(code) DO UPDATE SET
  name=EXCLUDED.name,
  route=EXCLUDED.route,
  order_index=EXCLUDED.order_index,
  parent_id=EXCLUDED.parent_id,
  feature_key='inventory',
  is_active=true;

-- A meglévő Raktár és készlet jogosultságait örökítjük a Beszerzés menüre.
INSERT INTO role_menu_permissions(
  role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,
  can_view_financial,can_manage_permissions,scope_type
)
SELECT
  rp.role_key,target.id,rp.can_view,rp.can_create,rp.can_edit,rp.can_delete,rp.can_approve,rp.can_export,
  rp.can_view_financial,rp.can_manage_permissions,rp.scope_type
FROM role_menu_permissions rp
JOIN menus source ON source.id=rp.menu_id AND source.code='warehouse'
CROSS JOIN menus target
WHERE target.code='procurement' OR target.code LIKE 'procurement.%'
ON CONFLICT(role_key,menu_id) DO NOTHING;

COMMIT;
