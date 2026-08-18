import db from "../db";
import { clearShortCache } from "../performance/shortCache";

let ready=false;

export async function ensureManagementImprovementMenu(){
  if(ready)return;
  const menus=Boolean((await db.query(`SELECT to_regclass('public.menus') IS NOT NULL ok`)).rows[0]?.ok);
  if(!menus)return;

  await db.query(`
    INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
    VALUES('operations','Vállalatirányítási eszközök','ClipboardCheck',NULL,120,NULL,'operations',true)
    ON CONFLICT(code) DO UPDATE SET
      name=EXCLUDED.name,
      icon=COALESCE(menus.icon,EXCLUDED.icon),
      route=NULL,
      parent_id=NULL,
      feature_key='operations',
      is_active=true
  `);

  await db.query(`WITH p AS (SELECT id FROM menus WHERE code='operations' LIMIT 1)
    INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
    SELECT 'operations.improvement','Fejlesztési projektek és CAPA','ChartNoAxesCombined','/operations/improvement',65,p.id,'operations',true FROM p
    ON CONFLICT(code) DO UPDATE SET
      name=EXCLUDED.name,
      icon=EXCLUDED.icon,
      route=EXCLUDED.route,
      order_index=EXCLUDED.order_index,
      parent_id=EXCLUDED.parent_id,
      feature_key='operations',
      is_active=true
  `);

  const permissions=Boolean((await db.query(`SELECT to_regclass('public.role_menu_permissions') IS NOT NULL ok`)).rows[0]?.ok);
  if(permissions){
    await db.query(`INSERT INTO role_menu_permissions(
        role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,
        can_export,can_view_financial,can_manage_permissions,scope_type,updated_at
      )
      SELECT r.role_key,m.id,true,true,true,false,true,true,false,false,'all_locations',now()
      FROM (VALUES('admin'),('manager')) r(role_key)
      CROSS JOIN menus m
      WHERE m.code IN('operations','operations.improvement')
      ON CONFLICT(role_key,menu_id) DO UPDATE SET
        can_view=true,can_create=true,can_edit=true,can_delete=false,can_approve=true,
        can_export=true,can_view_financial=false,can_manage_permissions=false,
        scope_type='all_locations',updated_at=now()`);

    await db.query(`INSERT INTO role_menu_permissions(
        role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,
        can_export,can_view_financial,can_manage_permissions,scope_type,updated_at
      )
      SELECT r.role_key,m.id,false,false,false,false,false,false,false,false,'own_location',now()
      FROM (VALUES('location_manager'),('salon_manager'),('receptionist'),('employee'),('customer')) r(role_key)
      CROSS JOIN menus m
      WHERE m.code='operations.improvement'
      ON CONFLICT(role_key,menu_id) DO UPDATE SET
        can_view=false,can_create=false,can_edit=false,can_delete=false,can_approve=false,
        can_export=false,can_view_financial=false,can_manage_permissions=false,
        scope_type='own_location',updated_at=now()`);
  }

  clearShortCache("menu:");
  ready=true;
}

export default ensureManagementImprovementMenu;
