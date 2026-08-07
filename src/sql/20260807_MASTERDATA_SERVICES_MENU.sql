BEGIN;

-- Szolgáltatási törzs rendezése: kategóriák -> szolgáltatások -> szakember-hozzárendelések.
-- A meglévő masterdata.service-types rekordot átnevezzük, hogy üzletileg egyértelmű legyen.
UPDATE menus
SET name = 'Szolgáltatási kategóriák',
    route = '/masterdata/service-categories',
    feature_key = 'service_categories',
    order_index = 40,
    is_active = true
WHERE code = 'masterdata.service-types';

WITH parent AS (
  SELECT id FROM menus WHERE code = 'masterdata' LIMIT 1
)
INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
SELECT 'masterdata.services','Szolgáltatások',NULL,'/masterdata/services',41,parent.id,'services',true FROM parent
ON CONFLICT(code) DO UPDATE SET
  name=EXCLUDED.name, route=EXCLUDED.route, order_index=EXCLUDED.order_index,
  parent_id=EXCLUDED.parent_id, feature_key=EXCLUDED.feature_key, is_active=true;

WITH parent AS (
  SELECT id FROM menus WHERE code = 'masterdata' LIMIT 1
)
INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
SELECT 'masterdata.employee-services','Szakember–szolgáltatás beállítások',NULL,'/masterdata/employee-services',42,parent.id,'employee_services',true FROM parent
ON CONFLICT(code) DO UPDATE SET
  name=EXCLUDED.name, route=EXCLUDED.route, order_index=EXCLUDED.order_index,
  parent_id=EXCLUDED.parent_id, feature_key=EXCLUDED.feature_key, is_active=true;

-- A kapcsolódó terméktörzs közvetlenül a szolgáltatási blokk után következzen.
UPDATE menus SET order_index = 50 WHERE code = 'masterdata.product-types';

COMMIT;
