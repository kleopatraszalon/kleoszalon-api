import pool from '../db';

async function safe(sql:string,params:any[]=[]){try{await pool.query(sql,params)}catch(error:any){console.warn('Menü önjavítási részlépés kihagyva:',error?.message||error)}}

export async function ensureMenuHealth(){
  await pool.query(`ALTER TABLE menus ADD COLUMN IF NOT EXISTS code text;ALTER TABLE menus ADD COLUMN IF NOT EXISTS feature_key text;ALTER TABLE menus ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;`);

  await safe(`UPDATE menus SET is_active=true WHERE code IN(
    'dashboard','appointments','appointments.workorders','finance','finance.dashboard','finance.checkout','finance.cash','customers.loyalty_program',
    'team','team.schedule','team.positions','inventory','procurement','settings','commerce.webshop','screens.signage','screens.kiosk','analytics.reports'
  )`);
  await safe(`UPDATE menus SET route='/finance',is_active=true WHERE code IN('finance.dashboard','finance.checkout','finance.cash')`);
  await safe(`WITH p AS (SELECT id FROM menus WHERE code='finance' LIMIT 1)
    UPDATE menus m SET name='Bér- és jutalékszámítás',route='/modules/team/payroll',parent_id=p.id,order_index=80,feature_key='payroll',is_active=true
    FROM p WHERE m.code='finance.payroll'`);
  await safe(`UPDATE menus SET is_active=false WHERE code='team.payroll'`);
  await safe(`UPDATE menus SET route='/workorders',is_active=true WHERE code='appointments.workorders'`);

  // Régi és vegyes útvonalak kanonizálása. Ezek a route-ok korábban a frontend wildcardjára
  // estek és bejelentkezett felhasználónál visszairányítottak az irányítópultra.
  await safe(`UPDATE menus SET route='/warehouse/products',is_active=true WHERE route IN('/products','/masterdata/products','/inventory/products')`);
  await safe(`UPDATE menus SET route='/appointments/calendar',is_active=true WHERE route='/appointments'`);
  await safe(`UPDATE menus SET route='/warehouse',is_active=true WHERE route='/inventory'`);
  await safe(`UPDATE menus SET route='/warehouse?view=procurement&section=dashboard',is_active=true WHERE route IN('/procurement','/warehouse/procurement')`);
  await safe(`UPDATE menus SET route='/modules/customers/clients',is_active=true WHERE route='/clients'`);
  await safe(`UPDATE menus SET route='/modules/customers/crm',is_active=true WHERE route='/crm'`);
  await safe(`UPDATE menus SET route='/employees',is_active=true WHERE route IN('/team','/staff')`);
  await safe(`UPDATE menus SET route='/masterdata/services',is_active=true WHERE route='/masterdata/services/'`);

  await pool.query(`DO $$ DECLARE p bigint; BEGIN
    SELECT id INTO p FROM menus WHERE code='appointments' OR (parent_id IS NULL AND lower(name) LIKE 'időpont%') ORDER BY CASE WHEN code='appointments' THEN 0 ELSE 1 END,id LIMIT 1;
    IF p IS NULL THEN INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active) VALUES('appointments','Időpontok és jelenlét','CalendarDays',NULL,20,NULL,'appointments',true) RETURNING id INTO p;
    ELSE UPDATE menus SET code=COALESCE(code,'appointments'),name='Időpontok és jelenlét',icon=COALESCE(icon,'CalendarDays'),is_active=true WHERE id=p; END IF;

    IF EXISTS(SELECT 1 FROM menus WHERE code='appointments.workorders') THEN
      UPDATE menus SET name='Munkalapok',route='/workorders',parent_id=p,order_index=25,feature_key='workorders',is_active=true WHERE code='appointments.workorders';
    ELSE
      UPDATE menus SET code='appointments.workorders',name='Munkalapok',route='/workorders',parent_id=p,order_index=25,feature_key='workorders',is_active=true
       WHERE id=(SELECT id FROM menus WHERE route IN('/workorders','/workorders/list') ORDER BY id LIMIT 1);
      IF NOT FOUND THEN INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active) VALUES('appointments.workorders','Munkalapok','ClipboardCheck','/workorders',25,p,'workorders',true); END IF;
    END IF;
    UPDATE menus SET is_active=false WHERE route IN('/workorders','/workorders/list') AND COALESCE(code,'')<>'appointments.workorders';
  END $$;`);

  await pool.query(`DO $$ DECLARE p bigint; BEGIN
    SELECT id INTO p FROM menus WHERE code='finance' OR (parent_id IS NULL AND (route='/finance' OR lower(name) LIKE 'pénzügy%')) ORDER BY CASE WHEN code='finance' THEN 0 ELSE 1 END,id LIMIT 1;
    IF p IS NULL THEN INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active) VALUES('finance','Pénzügyek','WalletCards',NULL,60,NULL,'finance',true) RETURNING id INTO p;
    ELSE UPDATE menus SET code=COALESCE(code,'finance'),name='Pénzügyek',icon=COALESCE(icon,'WalletCards'),is_active=true WHERE id=p; END IF;

    IF EXISTS(SELECT 1 FROM menus WHERE code='finance.nav_online_invoice') THEN
      UPDATE menus SET name='NAV Online Számla',route='/finance/nav-online-invoice',parent_id=p,order_index=150,feature_key='finance',is_active=true WHERE code='finance.nav_online_invoice';
    ELSE
      UPDATE menus SET code='finance.nav_online_invoice',name='NAV Online Számla',route='/finance/nav-online-invoice',parent_id=p,order_index=150,feature_key='finance',is_active=true
       WHERE id=(SELECT id FROM menus WHERE route='/finance/nav-online-invoice' ORDER BY id LIMIT 1);
      IF NOT FOUND THEN INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active) VALUES('finance.nav_online_invoice','NAV Online Számla','FileCheck2','/finance/nav-online-invoice',150,p,'finance',true); END IF;
    END IF;
    UPDATE menus SET is_active=false WHERE route='/finance/nav-online-invoice' AND COALESCE(code,'')<>'finance.nav_online_invoice';
  END $$;`);

  // 10. etap: központi ellátás stabil menüpont a Beszerzés alatt.
  await safe(`WITH p AS (SELECT id FROM menus WHERE code='procurement' LIMIT 1)
    INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
    SELECT 'procurement.central_supply','Központi ellátás',NULL,'/warehouse/central-supply',45,p.id,'inventory',true FROM p
    ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,route=EXCLUDED.route,order_index=EXCLUDED.order_index,parent_id=EXCLUDED.parent_id,feature_key='inventory',is_active=true`);


  // Terméktörzs v3: kézi taxonómia-felülvizsgálat csak menedzsmentnek.
  await safe(`WITH p AS (SELECT id FROM menus WHERE code='inventory' LIMIT 1)
    INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
    SELECT 'inventory.taxonomy_review','Besorolás ellenőrzése','Tags','/masterdata/products/taxonomy-review',35,p.id,'inventory',true FROM p
    ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,icon=EXCLUDED.icon,route=EXCLUDED.route,order_index=EXCLUDED.order_index,parent_id=EXCLUDED.parent_id,feature_key='inventory',is_active=true`);
  await safe(`INSERT INTO role_menu_permissions(role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,can_manage_permissions,scope_type,updated_at)
    SELECT r.role_key,m.id,true,false,true,false,true,true,false,false,CASE WHEN r.role_key='admin' THEN 'all_locations' ELSE 'own_location' END,now()
    FROM (VALUES('admin'),('manager')) r(role_key) CROSS JOIN menus m WHERE m.code='inventory.taxonomy_review'
    ON CONFLICT(role_key,menu_id) DO UPDATE SET can_view=true,can_edit=true,can_approve=true,can_export=true,scope_type=EXCLUDED.scope_type,updated_at=now()`);
  await safe(`INSERT INTO role_menu_permissions(role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,can_manage_permissions,scope_type,updated_at)
    SELECT r.role_key,m.id,false,false,false,false,false,false,false,false,'own_location',now()
    FROM (VALUES('location_manager'),('salon_manager'),('receptionist'),('employee'),('customer')) r(role_key) CROSS JOIN menus m WHERE m.code='inventory.taxonomy_review'
    ON CONFLICT(role_key,menu_id) DO UPDATE SET can_view=false,can_edit=false,can_approve=false,updated_at=now()`);

  await safe(`UPDATE menus SET route='/webshop/admin',is_active=true WHERE code='commerce.webshop'`);
  await safe(`UPDATE menus SET route='/signage',is_active=true WHERE code='screens.signage'`);
  await safe(`UPDATE menus SET route='/kiosk',is_active=true WHERE code='screens.kiosk'`);
  await safe(`UPDATE menus SET route='/finance',is_active=true WHERE code IN('finance.dashboard','finance.checkout','finance.cash')`);
  await safe(`UPDATE menus SET route='/modules/team/timetable',is_active=true WHERE code='team.schedule'`);
  await safe(`WITH p AS (SELECT id FROM menus WHERE code='customers' LIMIT 1) UPDATE menus m SET name='Törzsvásárlói program',route='/modules/customers/loyalty-program',parent_id=p.id,order_index=60,feature_key='loyalty',is_active=true FROM p WHERE m.code='customers.loyalty_program'`);
  await safe(`WITH p AS (SELECT id FROM menus WHERE code='team' LIMIT 1) UPDATE menus m SET name='Munkakörök',route='/hr/positions',parent_id=p.id,order_index=30,feature_key='hr',is_active=true FROM p WHERE m.code='team.positions'`);
  await safe(`WITH p AS (SELECT id FROM menus WHERE code='operations' LIMIT 1), items(code,name,route,ord) AS (VALUES ('operations.audits','Minőségellenőrzések és auditok','/operations/audits',70),('operations.incidents','Események és eltérések','/operations/incidents',80)) INSERT INTO menus(code,name,route,order_index,parent_id,feature_key,is_active) SELECT i.code,i.name,i.route,i.ord,p.id,'operations',true FROM p CROSS JOIN items i ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,route=EXCLUDED.route,order_index=EXCLUDED.order_index,parent_id=EXCLUDED.parent_id,feature_key='operations',is_active=true`);
  await safe(`UPDATE menus SET name='Hírlevelek',route='/marketing/newsletter',feature_key='newsletter',is_active=true WHERE code='marketing.newsletter'`);
  await safe(`UPDATE menus SET name='Hírlevelek és kampányok',is_active=true WHERE code='marketing'`);
  await safe(`UPDATE menus SET name='Napi akciók',route='/marketing/daily-deals',feature_key='daily_deals',is_active=true WHERE code='marketing.daily-deals'`);
  await safe(`UPDATE menus SET name='Tudásbázis',route='/knowledge-base/library',is_active=true WHERE code='knowledge.base'`);
  await safe(`UPDATE menus SET name='Folyamatok és szabályzatok',route='/knowledge-base/processes',is_active=true WHERE code='knowledge.procedures'`);
  await safe(`WITH p AS (SELECT id FROM menus WHERE code='knowledge' LIMIT 1) INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active) SELECT 'knowledge.quiz','Ellenőrző kvíz','GraduationCap','/knowledge-base/quiz',30,p.id,'knowledge_base',true FROM p ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,route=EXCLUDED.route,parent_id=EXCLUDED.parent_id,is_active=true`);
  await safe(`UPDATE menus SET route='/admin/vir/reports',is_active=true WHERE code='analytics.reports'`);
  await safe(`UPDATE menus SET route='/services',is_active=true WHERE code='settings.services'`);

  await safe(`UPDATE menus SET is_active=false WHERE code IN(
    'integrations','integrations.marketplace','integrations.api','integrations.logs',
    'marketing','marketing.campaigns','marketing.notifications','marketing.templates','marketing.segments','marketing.feedback',
    'online','online.widget','online.channels','online.clientapp','online.staffapp',
    'locations','locations.salons','locations.comparison','locations.central',
    'commerce.orders','commerce.coupons',
    'finance.online','finance.partners',
    'team.performance','team.vacations',
    'settings.categories','settings.payment','settings.customization','settings.audit','settings.system',
    'analytics.revenue','analytics.appointments','analytics.clients','analytics.staff','analytics.services','analytics.inventory'
  )`);

  await safe(`UPDATE menus m SET is_active=false WHERE m.code IS NULL AND m.is_active=true AND EXISTS(
    SELECT 1 FROM menus k WHERE k.code IS NOT NULL AND k.is_active=true AND k.id<>m.id AND COALESCE(k.route,'')<>'' AND k.route=m.route
  )`);

  await safe(`INSERT INTO role_menu_permissions(role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,can_manage_permissions,scope_type,updated_at)
    SELECT 'admin',m.id,true,true,true,true,true,true,true,true,'all_locations',now() FROM menus m WHERE m.code IN('appointments.workorders','finance.nav_online_invoice','procurement.central_supply')
    ON CONFLICT(role_key,menu_id) DO UPDATE SET can_view=true,can_create=true,can_edit=true,can_delete=true,can_approve=true,can_export=true,can_view_financial=true,can_manage_permissions=true,scope_type='all_locations',updated_at=now()`);
  await safe(`INSERT INTO role_menu_permissions(role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,can_manage_permissions,scope_type,updated_at)
    SELECT r.role_key,m.id,true,true,true,false,false,true,false,false,'own_location',now()
    FROM (VALUES('receptionist'),('location_manager')) r(role_key) CROSS JOIN menus m WHERE m.code='appointments.workorders'
    ON CONFLICT(role_key,menu_id) DO UPDATE SET can_view=true,can_create=true,can_edit=true,can_delete=false,scope_type='own_location',updated_at=now()`);
  await safe(`INSERT INTO role_menu_permissions(role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,can_manage_permissions,scope_type,updated_at)
    SELECT 'salon_manager',m.id,true,false,false,false,false,false,false,false,'own_location',now() FROM menus m WHERE m.code='appointments.workorders'
    ON CONFLICT(role_key,menu_id) DO UPDATE SET can_view=true,can_create=false,can_edit=false,can_delete=false,scope_type='own_location',updated_at=now()`);
  await safe(`INSERT INTO role_menu_permissions(role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,can_manage_permissions,scope_type,updated_at)
    SELECT r.role_key,m.id,false,false,false,false,false,false,false,false,'own_location',now()
    FROM (VALUES('receptionist'),('location_manager'),('salon_manager'),('employee'),('customer')) r(role_key) CROSS JOIN menus m WHERE m.code='finance.nav_online_invoice'
    ON CONFLICT(role_key,menu_id) DO UPDATE SET can_view=false,can_create=false,can_edit=false,can_delete=false,can_approve=false,can_export=false,can_view_financial=false,can_manage_permissions=false,updated_at=now()`);
  await safe(`INSERT INTO role_menu_permissions(role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,can_manage_permissions,scope_type,updated_at)
    SELECT r.role_key,m.id,true,false,false,false,false,false,false,false,'own_location',now()
    FROM (VALUES('location_manager'),('salon_manager'),('receptionist')) r(role_key) CROSS JOIN menus m WHERE m.code='procurement.central_supply'
    ON CONFLICT(role_key,menu_id) DO UPDATE SET can_view=true,can_create=false,can_edit=false,can_delete=false,can_approve=false,can_export=false,scope_type='own_location',updated_at=now()`);
}
