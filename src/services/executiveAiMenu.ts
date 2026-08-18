import db from "../db";
import { clearShortCache } from "../performance/shortCache";

let ready=false;

export async function ensureExecutiveAiMenu(){
  if(ready)return;
  try{
    const menus=Boolean((await db.query(`SELECT to_regclass('public.menus') IS NOT NULL ok`)).rows[0]?.ok);
    if(!menus)return;

    await db.query(`
      INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
      VALUES('analytics','Statisztika és VIR','ChartNoAxesCombined',NULL,80,NULL,'analytics',true)
      ON CONFLICT(code) DO UPDATE SET
        name='Statisztika és VIR',icon='ChartNoAxesCombined',route=NULL,parent_id=NULL,feature_key='analytics',is_active=true
    `);

    await db.query(`WITH p AS (SELECT id FROM menus WHERE code='analytics' LIMIT 1)
      INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
      SELECT x.code,x.name,x.icon,x.route,x.order_index,p.id,'analytics',true FROM p CROSS JOIN (VALUES
        ('analytics.executive_ai','AI vezetői asszisztens','BrainCircuit','/finance/executive-ai',15),
        ('analytics.exception_center','Exception Command Center','Siren','/finance/exception-command-center',16),
        ('analytics.exception_intelligence','Exception Intelligence','ChartNoAxesCombined','/finance/exception-command-center/intelligence',17),
        ('analytics.exception_capa','CAPA központ','ClipboardCheck','/finance/exception-command-center/capa',18),
        ('analytics.major_incident','Major Incident / War Room','MonitorPlay','/finance/exception-command-center/major-incidents',19),
        ('analytics.resilience_recovery','Resilience & Recovery','Activity','/finance/exception-command-center/resilience',20),
        ('analytics.business_continuity_gameday','Üzletmenet-folytonossági GameDay','ShieldCheck','/finance/exception-command-center/gameday',21)
      ) x(code,name,icon,route,order_index)
      ON CONFLICT(code) DO UPDATE SET
        name=EXCLUDED.name,icon=EXCLUDED.icon,route=EXCLUDED.route,order_index=EXCLUDED.order_index,
        parent_id=EXCLUDED.parent_id,feature_key='analytics',is_active=true`);

    const perms=Boolean((await db.query(`SELECT to_regclass('public.role_menu_permissions') IS NOT NULL ok`)).rows[0]?.ok);
    if(perms){
      await db.query(`INSERT INTO role_menu_permissions(
          role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,
          can_export,can_view_financial,can_manage_permissions,scope_type,updated_at
        )
        SELECT r.role_key,m.id,true,false,true,false,true,true,true,false,'all_locations',now()
        FROM (VALUES('admin'),('manager')) r(role_key)
        CROSS JOIN menus m WHERE m.code IN('analytics','analytics.executive_ai','analytics.exception_center','analytics.exception_intelligence','analytics.exception_capa','analytics.major_incident','analytics.resilience_recovery','analytics.business_continuity_gameday')
        ON CONFLICT(role_key,menu_id) DO UPDATE SET
          can_view=true,
          can_edit=EXCLUDED.can_edit,
          can_approve=EXCLUDED.can_approve,
          can_export=true,
          can_view_financial=true,
          scope_type='all_locations',
          updated_at=now()`);
      await db.query(`UPDATE role_menu_permissions p
        SET can_view=false,can_create=false,can_edit=false,can_delete=false,
            can_approve=false,can_export=false,can_view_financial=false,updated_at=now()
        FROM menus m
        WHERE p.menu_id=m.id
          AND m.code IN('analytics.executive_ai','analytics.exception_center','analytics.exception_intelligence','analytics.exception_capa','analytics.major_incident','analytics.resilience_recovery','analytics.business_continuity_gameday')
          AND lower(p.role_key) NOT IN('admin','manager')`);
    }

    clearShortCache("menu:");
    ready=true;
  }catch(error:any){
    console.warn('[executive-controls] critical menu registration skipped:',error?.message||error);
  }
}