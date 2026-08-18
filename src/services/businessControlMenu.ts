import db from "../db";
import { clearShortCache } from "../performance/shortCache";

let ready=false;

export async function ensureBusinessControlMenu(){
  if(ready)return;
  try{
    const menus=Boolean((await db.query(`SELECT to_regclass('public.menus') IS NOT NULL ok`)).rows[0]?.ok);
    if(!menus)return;

    await db.query(`
      INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
      VALUES
        ('finance','Pénzügy és pénztár','WalletCards',NULL,60,NULL,'finance',true),
        ('settings','Beállítások és adminisztráció','Settings',NULL,190,NULL,'settings',true)
      ON CONFLICT(code) DO UPDATE SET
        name=EXCLUDED.name,
        icon=EXCLUDED.icon,
        route=NULL,
        parent_id=NULL,
        feature_key=EXCLUDED.feature_key,
        is_active=true
    `);

    await db.query(`WITH p AS (SELECT id FROM menus WHERE code='finance' LIMIT 1)
      INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
      SELECT x.code,x.name,x.icon,x.route,x.order_index,p.id,'finance',true FROM p CROSS JOIN (VALUES
        ('finance.reconciliation','Pénzügyi egyeztető központ','BadgeCheck','/finance/reconciliation',65),
        ('finance.transaction_trace','Tranzakció-életút','GitBranch','/finance/transaction-trace',66)
      ) x(code,name,icon,route,order_index)
      ON CONFLICT(code) DO UPDATE SET
        name=EXCLUDED.name,
        icon=EXCLUDED.icon,
        route=EXCLUDED.route,
        order_index=EXCLUDED.order_index,
        parent_id=EXCLUDED.parent_id,
        feature_key='finance',
        is_active=true`);

    await db.query(`WITH p AS (SELECT id FROM menus WHERE code='settings' LIMIT 1)
      INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
      SELECT 'settings.system_health','Rendszerállapot','Activity','/admin/system-health',190,p.id,'audit',true FROM p
      ON CONFLICT(code) DO UPDATE SET
        name='Rendszerállapot',
        icon='Activity',
        route='/admin/system-health',
        order_index=190,
        parent_id=EXCLUDED.parent_id,
        feature_key='audit',
        is_active=true`);

    const perms=Boolean((await db.query(`SELECT to_regclass('public.role_menu_permissions') IS NOT NULL ok`)).rows[0]?.ok);
    if(perms){
      await db.query(`INSERT INTO role_menu_permissions(
          role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,
          can_export,can_view_financial,can_manage_permissions,scope_type,updated_at
        )
        SELECT r.role_key,m.id,true,false,false,false,false,true,
          (m.code IN('finance','finance.reconciliation','finance.transaction_trace')),false,'all_locations',now()
        FROM (VALUES('admin'),('manager')) r(role_key)
        CROSS JOIN menus m
        WHERE m.code IN('finance','finance.reconciliation','finance.transaction_trace','settings','settings.system_health')
        ON CONFLICT(role_key,menu_id) DO UPDATE SET
          can_view=true,
          can_export=true,
          can_view_financial=EXCLUDED.can_view_financial,
          scope_type='all_locations',
          updated_at=now()`);
    }

    clearShortCache("menu:");
    ready=true;
  }catch(error:any){
    console.warn('[reconciliation] critical menu registration skipped:',error?.message||error);
  }
}
