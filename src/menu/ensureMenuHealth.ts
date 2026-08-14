import pool from '../db';
import { ensureMenuHealth as ensureLegacyMenuHealth } from './ensureMenuHealthLegacy';

async function safe(sql:string,params:any[]=[]){try{await pool.query(sql,params)}catch(error:any){console.warn('CRM menü önjavítási részlépés kihagyva:',error?.message||error)}}

export async function ensureMenuHealth(){
  await ensureLegacyMenuHealth();
  await pool.query(`WITH p AS (SELECT id FROM menus WHERE code='settings' LIMIT 1)
    INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
    SELECT 'settings.audit','Audit és rendszeresemény-napló','ShieldCheck','/modules/settings/audit-log',205,p.id,'audit',true FROM p
    ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,icon=EXCLUDED.icon,route=EXCLUDED.route,order_index=EXCLUDED.order_index,parent_id=EXCLUDED.parent_id,feature_key='audit',is_active=true`);

  await safe(`WITH p AS (SELECT id FROM menus WHERE code='customers' LIMIT 1)
    INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
    SELECT 'customers.forms','Kérdőívek és nyilatkozatok','ClipboardList','/modules/customers/forms',65,p.id,'clients',true FROM p
    ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,icon=EXCLUDED.icon,route=EXCLUDED.route,order_index=EXCLUDED.order_index,parent_id=EXCLUDED.parent_id,feature_key='clients',is_active=true`);
  await safe(`WITH p AS (SELECT id FROM menus WHERE code='customers' LIMIT 1)
    INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
    SELECT 'customers.duplicate_review','Duplikációk jóváhagyása','Merge','/modules/customers/duplicate-review',70,p.id,'clients',true FROM p
    ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,icon=EXCLUDED.icon,route=EXCLUDED.route,order_index=EXCLUDED.order_index,parent_id=EXCLUDED.parent_id,feature_key='clients',is_active=true`);

  await safe(`INSERT INTO role_menu_permissions(role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,can_manage_permissions,scope_type,updated_at)
    SELECT 'admin',m.id,true,true,true,true,true,true,false,true,'all_locations',now()
    FROM menus m WHERE m.code IN('customers.forms','customers.duplicate_review')
    ON CONFLICT(role_key,menu_id) DO UPDATE SET can_view=true,can_create=true,can_edit=true,can_delete=true,can_approve=true,can_export=true,scope_type='all_locations',updated_at=now()`);
  await safe(`INSERT INTO role_menu_permissions(role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,can_manage_permissions,scope_type,updated_at)
    SELECT r.role_key,m.id,true,false,true,false,true,false,false,false,'own_location',now()
    FROM (VALUES('manager'),('location_manager'),('salon_manager')) r(role_key) CROSS JOIN menus m
    WHERE m.code IN('customers.forms','customers.duplicate_review')
    ON CONFLICT(role_key,menu_id) DO UPDATE SET can_view=true,can_edit=true,can_delete=false,can_approve=true,can_export=false,scope_type='own_location',updated_at=now()`);
  await safe(`INSERT INTO role_menu_permissions(role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,can_manage_permissions,scope_type,updated_at)
    SELECT 'receptionist',m.id,true,false,false,false,false,false,false,false,'own_location',now()
    FROM menus m WHERE m.code IN('customers.forms','customers.duplicate_review')
    ON CONFLICT(role_key,menu_id) DO UPDATE SET can_view=true,can_create=false,can_edit=false,can_delete=false,can_approve=false,can_export=false,scope_type='own_location',updated_at=now()`);
}
