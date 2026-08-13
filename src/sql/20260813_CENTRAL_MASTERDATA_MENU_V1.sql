BEGIN;

INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
VALUES('masterdata','Törzsadatok','Database',NULL,145,NULL,'master_data',true)
ON CONFLICT(code) DO UPDATE SET
  name=EXCLUDED.name,
  icon=EXCLUDED.icon,
  route=NULL,
  order_index=EXCLUDED.order_index,
  parent_id=NULL,
  feature_key=EXCLUDED.feature_key,
  is_active=true;

WITH parent AS (
  SELECT id FROM menus WHERE code='masterdata' LIMIT 1
), items(code,name,route,order_index,feature_key) AS (
  VALUES
    ('masterdata.central','Központi törzsadatok','/masterdata',5,'master_data'),
    ('masterdata.salons','Szalonok','/masterdata/salons',10,'master_data'),
    ('masterdata.departments','Részlegek','/masterdata/departments',30,'departments'),
    ('masterdata.assets','Eszközök és eszköztípusok','/masterdata/assets',60,'assets'),
    ('masterdata.suppliers','Partnerek / Beszállítók','/masterdata/suppliers',70,'suppliers'),
    ('masterdata.leave-types','Szabadságtípusok','/masterdata/leave-types',80,'leave_types'),
    ('masterdata.units','Mennyiségi egységek','/masterdata/units',90,'units'),
    ('masterdata.price-types','Ártípusok','/masterdata/price-types',100,'price_types'),
    ('masterdata.warehouses','Raktárak','/masterdata/warehouses',110,'warehouses'),
    ('masterdata.movement-types','Készletmozgás-típusok','/masterdata/movement-types',120,'movement_types'),
    ('masterdata.payment-methods','Fizetési módok','/masterdata/payment-methods',125,'finance'),
    ('masterdata.transaction-types','Pénzügyi tranzakciótípusok','/masterdata/financial-transaction-types',130,'financial_transaction_types')
)
INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
SELECT i.code,i.name,NULL,i.route,i.order_index,p.id,i.feature_key,true
FROM items i CROSS JOIN parent p
ON CONFLICT(code) DO UPDATE SET
  name=EXCLUDED.name,
  route=EXCLUDED.route,
  order_index=EXCLUDED.order_index,
  parent_id=EXCLUDED.parent_id,
  feature_key=EXCLUDED.feature_key,
  is_active=true;

COMMIT;
