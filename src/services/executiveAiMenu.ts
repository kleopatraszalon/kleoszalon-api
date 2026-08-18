import db from "../db";
import { clearShortCache } from "../performance/shortCache";

let ready=false;

export async function ensureExecutiveAiMenu(){
  if(ready)return;
  try{
    const menus=Boolean((await db.query(`SELECT to_regclass('public.menus') IS NOT NULL ok`)).rows[0]?.ok);
    if(!menus)return;

    // Self-heal the analytics root as well, so this menu does not depend on a
    // legacy seed or a later menu-maintenance pass.
    await db.query(`
      INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
      VALUES('analytics','Statisztika és VIR','ChartNoAxesCombined',NULL,80,NULL,'analytics',true)
      ON CONFLICT(code) DO UPDATE SET
        name='Statisztika és VIR',
        icon='ChartNoAxesCombined',
        route=NULL,
        parent_id=NULL,
        feature_key='analytics',
        is_active=true
    `);

    await db.query(`WITH p AS (SELECT id FROM menus WHERE code='analytics' LIMIT 1)
      INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
      SELECT 'analytics.executive_ai','AI vezetői asszisztens','BrainCircuit','/finance/executive-ai',15,p.id,'analytics',true FROM p
      ON CONFLICT(code) DO UPDATE SET
        name='AI vezetői asszisztens',
        icon='BrainCircuit',
        route='/finance/executive-ai',
        order_index=15,
        parent_id=EXCLUDED.parent_id,
        feature_key='analytics',
        is_active=true`);

    const perms=Boolean((await db.query(`SELECT to_regclass('public.role_menu_permissions') IS NOT NULL ok`)).rows[0]?.ok);
    if(perms){
      await db.query(`INSERT INTO role_menu_permissions(
          role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,
          can_export,can_view_financial,can_manage_permissions,scope_type,updated_at
        )
        SELECT r.role_key,m.id,true,false,false,false,false,true,true,false,'all_locations',now()
        FROM (VALUES('admin'),('manager')) r(role_key)
        CROSS JOIN menus m WHERE m.code='analytics.executive_ai'
        ON CONFLICT(role_key,menu_id) DO UPDATE SET
          can_view=true,
          can_export=true,
          can_view_financial=true,
          scope_type='all_locations',
          updated_at=now()`);
      await db.query(`UPDATE role_menu_permissions p
        SET can_view=false,can_create=false,can_edit=false,can_delete=false,
            can_approve=false,can_export=false,can_view_financial=false,updated_at=now()
        FROM menus m
        WHERE p.menu_id=m.id
          AND m.code='analytics.executive_ai'
          AND lower(p.role_key) NOT IN('admin','manager')`);
    }

    clearShortCache("menu:");
    ready=true;
  }catch(error:any){
    console.warn('[executive-ai] critical menu registration skipped:',error?.message||error);
  }
}
