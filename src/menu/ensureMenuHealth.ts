import pool from '../db';
import { ensureMenuHealth as ensureLegacyMenuHealth } from './ensureMenuHealthLegacy';

async function safe(sql:string,params:any[]=[]){try{await pool.query(sql,params)}catch(error:any){console.warn('CRM/Stage18 menü önjavítási részlépés kihagyva:',error?.message||error)}}

export async function ensureMenuHealth(){
  await ensureLegacyMenuHealth();
  await pool.query(`WITH p AS (SELECT id FROM menus WHERE code='settings' LIMIT 1)
    INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
    SELECT 'settings.audit','Audit és rendszeresemény-napló','ShieldCheck','/modules/settings/audit-log',205,p.id,'audit',true FROM p
    ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,icon=EXCLUDED.icon,route=EXCLUDED.route,order_index=EXCLUDED.order_index,parent_id=EXCLUDED.parent_id,feature_key='audit',is_active=true`);
  await pool.query(`WITH p AS (SELECT id FROM menus WHERE code='settings' LIMIT 1)
    INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
    SELECT 'settings.gdpr','GDPR-központ','ShieldCheck','/admin/gdpr',210,p.id,'audit',true FROM p
    ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,icon=EXCLUDED.icon,route=EXCLUDED.route,order_index=EXCLUDED.order_index,parent_id=EXCLUDED.parent_id,feature_key='audit',is_active=true`);
  await pool.query(`WITH p AS (SELECT id FROM menus WHERE code='settings' LIMIT 1)
    INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
    SELECT 'settings.franchise','Franchise funnel / Mailchimp','Database','/settings?section=franchise',215,p.id,'franchise',true FROM p
    ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,icon=EXCLUDED.icon,route=EXCLUDED.route,order_index=EXCLUDED.order_index,parent_id=EXCLUDED.parent_id,feature_key='franchise',is_active=true`);
  await safe(`INSERT INTO role_menu_permissions(role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,can_manage_permissions,scope_type,updated_at)
    SELECT r.role_key,m.id,true,true,true,(r.role_key='admin'),(r.role_key='admin'),true,false,(r.role_key='admin'),'all_locations',now()
    FROM (VALUES('admin'),('manager')) r(role_key) CROSS JOIN menus m WHERE m.code='settings.gdpr'
    ON CONFLICT(role_key,menu_id) DO UPDATE SET can_view=true,can_create=true,can_edit=true,can_delete=(lower(role_menu_permissions.role_key)='admin'),can_approve=(lower(role_menu_permissions.role_key)='admin'),can_export=true,scope_type='all_locations',updated_at=now()`);
  await safe(`INSERT INTO role_menu_permissions(role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,can_manage_permissions,scope_type,updated_at)
    SELECT r.role_key,m.id,true,(r.role_key='admin'),(r.role_key='admin'),false,false,false,false,(r.role_key='admin'),'all_locations',now()
    FROM (VALUES('admin'),('manager')) r(role_key) CROSS JOIN menus m WHERE m.code='settings.franchise'
    ON CONFLICT(role_key,menu_id) DO UPDATE SET can_view=true,can_create=(lower(role_menu_permissions.role_key)='admin'),can_edit=(lower(role_menu_permissions.role_key)='admin'),can_delete=false,can_approve=false,can_export=false,can_manage_permissions=(lower(role_menu_permissions.role_key)='admin'),scope_type='all_locations',updated_at=now()`);

  await safe(`WITH p AS (SELECT id FROM menus WHERE code='customers' LIMIT 1)
    INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
    SELECT 'customers.forms','Kérdőívek és nyilatkozatok','ClipboardList','/modules/customers/forms',65,p.id,'clients',true FROM p
    ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,icon=EXCLUDED.icon,route=EXCLUDED.route,order_index=EXCLUDED.order_index,parent_id=EXCLUDED.parent_id,feature_key='clients',is_active=true`);
  await safe(`WITH p AS (SELECT id FROM menus WHERE code='customers' LIMIT 1)
    INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
    SELECT 'customers.duplicate_review','Duplikációk jóváhagyása','Merge','/modules/customers/duplicate-review',70,p.id,'clients',true FROM p
    ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,icon=EXCLUDED.icon,route=EXCLUDED.route,order_index=EXCLUDED.order_index,parent_id=EXCLUDED.parent_id,feature_key='clients',is_active=true`);

  // Stage18+: a Marketing főmenü és a kanonikus kampánymenük minden önjavítás után aktívak maradnak.
  await safe(`INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
    VALUES('marketing','Marketing','Megaphone',NULL,90,NULL,'marketing',true)
    ON CONFLICT(code) DO UPDATE SET name='Marketing',icon='Megaphone',route=NULL,parent_id=NULL,feature_key='marketing',is_active=true`);
  await safe(`WITH p AS (SELECT id FROM menus WHERE code='marketing' LIMIT 1)
    INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
    SELECT 'marketing.social','Social Hub','Megaphone','/marketing/newsletter?view=social',30,p.id,'newsletter',true FROM p
    ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,icon=EXCLUDED.icon,route=EXCLUDED.route,order_index=EXCLUDED.order_index,parent_id=EXCLUDED.parent_id,feature_key='newsletter',is_active=true`);
  await safe(`WITH p AS (SELECT id FROM menus WHERE code='marketing' LIMIT 1)
    INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
    SELECT 'marketing.flyer','Szórólaptervező','Palette','/flyer-designer.html',40,p.id,'marketing',true FROM p
    ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,icon=EXCLUDED.icon,route=EXCLUDED.route,order_index=EXCLUDED.order_index,parent_id=EXCLUDED.parent_id,feature_key='marketing',is_active=true`);
  await safe(`WITH p AS (SELECT id FROM menus WHERE code='marketing' LIMIT 1),
    v(code,name,icon,route,order_index) AS (VALUES
      ('marketing.ideas','Kampányötlet-generátor','Lightbulb','/marketing-studio.html?tool=ideas',50),
      ('marketing.calendar','Kampánynaptár','CalendarDays','/marketing-studio.html?tool=calendar',60),
      ('marketing.coupon','Kuponkészítő','TicketPercent','/marketing-studio.html?tool=coupon',70),
      ('marketing.packages','Csomagajánlat-tervező','Sparkles','/marketing-studio.html?tool=package',80),
      ('marketing.referral','Ajánlói program','Users','/marketing-studio.html?tool=referral',90),
      ('marketing.utm','Kampánylink / UTM','Link','/marketing-studio.html?tool=utm',100),
      ('marketing.winback','Visszahívó automatika','RefreshCw','/marketing-studio.html?tool=winback',110),
      ('marketing.occasions','Születésnap és névnap','Gift','/marketing-studio.html?tool=occasions',120),
      ('marketing.empty_slots','Üres időpont feltöltő','CalendarClock','/marketing-studio.html?tool=empty',130),
      ('marketing.roi','Marketing ROI Dashboard','ChartNoAxesCombined','/marketing-studio.html?tool=roi',140)
    )
    INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
    SELECT v.code,v.name,v.icon,v.route,v.order_index,p.id,'marketing',true FROM v CROSS JOIN p
    ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,icon=EXCLUDED.icon,route=EXCLUDED.route,order_index=EXCLUDED.order_index,parent_id=EXCLUDED.parent_id,feature_key='marketing',is_active=true`);
  await safe(`WITH p AS (SELECT id FROM menus WHERE code='marketing' LIMIT 1)
    UPDATE menus SET parent_id=p.id,is_active=true WHERE code IN('marketing.newsletter','marketing.daily-deals')`);

  await safe(`INSERT INTO role_menu_permissions(role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,can_manage_permissions,scope_type,updated_at)
    SELECT 'admin',m.id,true,true,true,true,true,true,false,true,'all_locations',now()
    FROM menus m WHERE m.code IN('customers.forms','customers.duplicate_review','marketing','marketing.newsletter','marketing.daily-deals','marketing.social','marketing.flyer','marketing.ideas','marketing.calendar','marketing.coupon','marketing.packages','marketing.referral','marketing.utm','marketing.winback','marketing.occasions','marketing.empty_slots','marketing.roi')
    ON CONFLICT(role_key,menu_id) DO UPDATE SET can_view=true,can_create=true,can_edit=true,can_delete=true,can_approve=true,can_export=true,scope_type='all_locations',updated_at=now()`);
  await safe(`INSERT INTO role_menu_permissions(role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,can_manage_permissions,scope_type,updated_at)
    SELECT r.role_key,m.id,true,false,true,false,true,false,false,false,'own_location',now()
    FROM (VALUES('manager'),('location_manager'),('salon_manager')) r(role_key) CROSS JOIN menus m
    WHERE m.code IN('customers.forms','customers.duplicate_review','marketing','marketing.newsletter','marketing.daily-deals','marketing.social','marketing.flyer','marketing.ideas','marketing.calendar','marketing.coupon','marketing.packages','marketing.referral','marketing.utm','marketing.winback','marketing.occasions','marketing.empty_slots','marketing.roi')
    ON CONFLICT(role_key,menu_id) DO UPDATE SET can_view=true,can_edit=true,can_delete=false,can_approve=true,can_export=false,scope_type='own_location',updated_at=now()`);
  await safe(`INSERT INTO role_menu_permissions(role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,can_manage_permissions,scope_type,updated_at)
    SELECT 'receptionist',m.id,true,false,false,false,false,false,false,false,'own_location',now()
    FROM menus m WHERE m.code IN('customers.forms','customers.duplicate_review')
    ON CONFLICT(role_key,menu_id) DO UPDATE SET can_view=true,can_create=false,can_edit=false,can_delete=false,can_approve=false,can_export=false,scope_type='own_location',updated_at=now()`);
  await safe(`INSERT INTO role_menu_permissions(role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,can_manage_permissions,scope_type,updated_at)
    SELECT r.role_key,m.id,false,false,false,false,false,false,false,false,'own_location',now()
    FROM (VALUES('receptionist'),('employee'),('customer')) r(role_key) CROSS JOIN menus m WHERE m.code IN('marketing','marketing.newsletter','marketing.daily-deals','marketing.social','marketing.flyer','marketing.ideas','marketing.calendar','marketing.coupon','marketing.packages','marketing.referral','marketing.utm','marketing.winback','marketing.occasions','marketing.empty_slots','marketing.roi')
    ON CONFLICT(role_key,menu_id) DO UPDATE SET can_view=false,can_create=false,can_edit=false,can_delete=false,can_approve=false,can_export=false,updated_at=now()`);

  // Egységes, felhasználóbarát megnevezések. Ez a blokk szándékosan az önjavítás végén fut,
  // hogy a korábbi migrációk vagy legacy menüjavítások ne írhassák vissza a régi feliratokat.
  await safe(`UPDATE menus SET name=CASE code
    WHEN 'appointments' THEN 'Időpontok és beosztás'
    WHEN 'finance.control' THEN 'Pénzügyi ellenőrzés és havi zárás'
    WHEN 'team' THEN 'Munkatársak és HR'
    WHEN 'team.evaluations' THEN 'Munkatársi értékelések'
    WHEN 'team.import' THEN 'Munkatárs-import és duplikációkezelés'
    WHEN 'procurement.dashboard' THEN 'Beszerzési áttekintés'
    WHEN 'procurement.approvals' THEN 'Jóváhagyásra váró tételek'
    WHEN 'inventory.taxonomy_review' THEN 'Termékbesorolás ellenőrzése'
    WHEN 'knowledge.base' THEN 'Tudásanyagok'
    WHEN 'knowledge.quiz' THEN 'Munkaköri teszt'
    WHEN 'marketing.social' THEN 'Közösségi média'
    WHEN 'marketing.utm' THEN 'Kampánylink és UTM'
    WHEN 'marketing.roi' THEN 'Marketing ROI'
    WHEN 'settings.system_health' THEN 'Rendszerállapot'
    WHEN 'settings.uat' THEN 'Átvételi tesztközpont (UAT)'
    WHEN 'settings.audit' THEN 'Audit- és rendszeresemény-napló'
    WHEN 'settings.franchise' THEN 'Franchise érdeklődők és Mailchimp'
    ELSE name END
    WHERE code IN(
      'appointments','finance.control','team','team.evaluations','team.import',
      'procurement.dashboard','procurement.approvals','inventory.taxonomy_review',
      'knowledge.base','knowledge.quiz','marketing.social','marketing.utm','marketing.roi',
      'settings.system_health','settings.uat','settings.audit','settings.franchise'
    )`);
}