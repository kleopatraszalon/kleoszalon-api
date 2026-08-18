import db from "../db";

async function safe(sql:string,params:any[]=[]){
  try{await db.query(sql,params)}catch(error:any){console.warn("Finance v5 menü bootstrap részlépés kihagyva:",error?.message||error)}
}

export async function ensureFinanceV5Menu(){
  await safe(`WITH p AS (SELECT id FROM menus WHERE code='finance' LIMIT 1),
    items(code,name,route,ord,feature_key) AS (VALUES
      ('finance.dashboard','Pénzügyi áttekintés','/finance',10,'finance'),
      ('finance.checkout','Pénztár és fizetés','/finance/checkout',20,'pos_checkout'),
      ('finance.transactions','Pénzügyi műveletek','/finance/transactions',30,'finance'),
      ('finance.cash','Számlák és pénztárak','/finance/accounts',40,'finance'),
      ('finance.partners','Partnerek','/finance/partners',50,'finance'),
      ('finance.payment_categories','Pénztárbizonylat típusok','/finance/categories',60,'finance'),
      ('finance.documents','Dokumentumok','/finance/documents',70,'finance'),
      ('finance.fixed_assets','Tárgyi eszközök és amortizáció','/finance/fixed-assets',75,'finance'),
      ('finance.online','Online fizetés','/finance/online-payments',80,'online_payments'),
      ('finance.reports','Pénzügyi jelentések','/finance/reports',90,'finance_analytics'),
      ('finance.payment_methods','Fizetési módok és díjak','/finance/payment-methods',100,'finance'),
      ('finance.settings','Pénzügyi beállítások','/finance/settings',110,'finance')
    )
    INSERT INTO menus(code,name,route,order_index,parent_id,feature_key,is_active)
    SELECT i.code,i.name,i.route,i.ord,p.id,i.feature_key,true FROM p CROSS JOIN items i
    ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,route=EXCLUDED.route,order_index=EXCLUDED.order_index,parent_id=EXCLUDED.parent_id,feature_key=EXCLUDED.feature_key,is_active=true`);

  await safe(`INSERT INTO role_feature_permissions(role_key,feature_key,can_use,scope_type,updated_at)
    VALUES
      ('admin','finance',true,'all_locations',now()),('manager','finance',true,'all_locations',now()),
      ('location_manager','finance',true,'own_location',now()),('salon_manager','finance',true,'own_location',now()),
      ('receptionist','finance',true,'own_location',now()),('employee','finance',false,'own',now()),('customer','finance',false,'own',now())
    ON CONFLICT(role_key,feature_key) DO UPDATE SET can_use=EXCLUDED.can_use,scope_type=EXCLUDED.scope_type,updated_at=now()`);

  await safe(`INSERT INTO role_menu_permissions(role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,can_manage_permissions,scope_type,updated_at)
    SELECT r.role_key,m.id,true,true,true,CASE WHEN r.role_key='admin' THEN true ELSE false END,true,true,true,CASE WHEN r.role_key='admin' THEN true ELSE false END,
      CASE WHEN r.role_key IN('admin','manager') THEN 'all_locations' ELSE 'own_location' END,now()
    FROM (VALUES('admin'),('manager'),('location_manager')) r(role_key) CROSS JOIN menus m
    WHERE m.code='finance' OR m.code IN('finance.dashboard','finance.checkout','finance.transactions','finance.cash','finance.partners','finance.payment_categories','finance.documents','finance.fixed_assets','finance.online','finance.reports','finance.payment_methods','finance.settings','finance.nav_online_invoice')
    ON CONFLICT(role_key,menu_id) DO UPDATE SET can_view=true,can_create=true,can_edit=true,can_approve=true,can_export=true,can_view_financial=true,scope_type=EXCLUDED.scope_type,updated_at=now()`);

  await safe(`INSERT INTO role_menu_permissions(role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,can_manage_permissions,scope_type,updated_at)
    SELECT r.role_key,m.id,
      CASE WHEN m.code IN('finance','finance.dashboard','finance.checkout','finance.transactions','finance.cash','finance.partners','finance.documents','finance.online','finance.reports') OR (r.role_key='salon_manager' AND m.code='finance.fixed_assets') THEN true ELSE false END,
      CASE WHEN m.code IN('finance.checkout','finance.transactions','finance.partners','finance.documents') THEN true ELSE false END,
      CASE WHEN m.code IN('finance.checkout','finance.transactions','finance.partners','finance.documents') THEN true ELSE false END,
      false,false,
      CASE WHEN m.code IN('finance.transactions','finance.cash','finance.partners','finance.documents','finance.reports') OR (r.role_key='salon_manager' AND m.code='finance.fixed_assets') THEN true ELSE false END,
      CASE WHEN m.code IN('finance.dashboard','finance.checkout','finance.transactions','finance.cash','finance.partners','finance.documents','finance.reports') OR (r.role_key='salon_manager' AND m.code='finance.fixed_assets') THEN true ELSE false END,
      false,'own_location',now()
    FROM (VALUES('salon_manager'),('receptionist')) r(role_key) CROSS JOIN menus m WHERE m.code='finance' OR m.code LIKE 'finance.%'
    ON CONFLICT(role_key,menu_id) DO UPDATE SET can_view=EXCLUDED.can_view,can_create=EXCLUDED.can_create,can_edit=EXCLUDED.can_edit,can_delete=false,can_approve=false,can_export=EXCLUDED.can_export,can_view_financial=EXCLUDED.can_view_financial,scope_type='own_location',updated_at=now()`);

  await safe(`INSERT INTO role_menu_permissions(role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,can_manage_permissions,scope_type,updated_at)
    SELECT r.role_key,m.id,false,false,false,false,false,false,false,false,'own',now()
    FROM (VALUES('employee'),('customer')) r(role_key) CROSS JOIN menus m WHERE m.code='finance' OR m.code LIKE 'finance.%'
    ON CONFLICT(role_key,menu_id) DO UPDATE SET can_view=false,can_create=false,can_edit=false,can_delete=false,can_approve=false,can_export=false,can_view_financial=false,updated_at=now()`);
}
