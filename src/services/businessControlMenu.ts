import db from "../db";
let ready=false;
export async function ensureBusinessControlMenu(){
 if(ready)return;
 try{
  const menus=Boolean((await db.query(`SELECT to_regclass('public.menus') IS NOT NULL ok`)).rows[0]?.ok);if(!menus)return;
  await db.query(`WITH p AS (SELECT id FROM menus WHERE code='finance' LIMIT 1)
    INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
    SELECT 'finance.reconciliation','Pénzügyi egyeztető központ','BadgeCheck','/finance/reconciliation',65,p.id,'finance',true FROM p
    ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,icon=EXCLUDED.icon,route=EXCLUDED.route,order_index=EXCLUDED.order_index,parent_id=EXCLUDED.parent_id,feature_key='finance',is_active=true`);
  const perms=Boolean((await db.query(`SELECT to_regclass('public.role_menu_permissions') IS NOT NULL ok`)).rows[0]?.ok);
  if(perms)await db.query(`INSERT INTO role_menu_permissions(role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,can_manage_permissions,scope_type,updated_at)
    SELECT r.role_key,m.id,true,false,false,false,false,true,true,false,'all_locations',now()
    FROM (VALUES('admin'),('manager')) r(role_key) CROSS JOIN menus m WHERE m.code='finance.reconciliation'
    ON CONFLICT(role_key,menu_id) DO UPDATE SET can_view=true,can_export=true,can_view_financial=true,scope_type='all_locations',updated_at=now()`);
  ready=true;
 }catch(error:any){console.warn('[reconciliation] menu registration skipped:',error?.message||error)}
}
