INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
SELECT 'team.import','Importálás és duplikációkezelés',NULL,'/modules/team/import',70,t.id,'staff_import',true
FROM menus t WHERE t.code='team'
ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,route=EXCLUDED.route,order_index=EXCLUDED.order_index,
parent_id=EXCLUDED.parent_id,feature_key=EXCLUDED.feature_key,is_active=true;
