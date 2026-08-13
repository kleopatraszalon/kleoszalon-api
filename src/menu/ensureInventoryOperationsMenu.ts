import db from "../db";

async function safe(sql:string,params:any[]=[]){try{await db.query(sql,params)}catch(error:any){console.warn("Inventory v4 menü seed kihagyva:",error?.message||error)}}

export async function ensureInventoryOperationsMenu(){
  await safe(`WITH p AS (SELECT id FROM menus WHERE code='inventory' LIMIT 1)
    INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
    SELECT 'inventory.operations','Raktárak és készletműveletek','Warehouse','/warehouse/operations',30,p.id,'inventory',true FROM p
    ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,icon=EXCLUDED.icon,route=EXCLUDED.route,order_index=EXCLUDED.order_index,parent_id=EXCLUDED.parent_id,feature_key='inventory',is_active=true`);

  await safe(`INSERT INTO role_menu_permissions(role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,can_manage_permissions,scope_type,updated_at)
    SELECT 'admin',m.id,true,true,true,true,true,true,false,true,'all_locations',now() FROM menus m WHERE m.code='inventory.operations'
    ON CONFLICT(role_key,menu_id) DO UPDATE SET can_view=true,can_create=true,can_edit=true,can_delete=true,can_approve=true,can_export=true,scope_type='all_locations',updated_at=now()`);

  await safe(`INSERT INTO role_menu_permissions(role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,can_manage_permissions,scope_type,updated_at)
    SELECT 'manager',m.id,true,true,true,false,true,true,false,false,'all_locations',now() FROM menus m WHERE m.code='inventory.operations'
    ON CONFLICT(role_key,menu_id) DO UPDATE SET can_view=true,can_create=true,can_edit=true,can_delete=false,can_approve=true,can_export=true,scope_type='all_locations',updated_at=now()`);

  await safe(`INSERT INTO role_menu_permissions(role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,can_manage_permissions,scope_type,updated_at)
    SELECT r.role_key,m.id,true,true,true,false,CASE WHEN r.role_key='location_manager' THEN true ELSE false END,true,false,false,'own_location',now()
    FROM (VALUES('location_manager'),('salon_manager'),('receptionist')) r(role_key) CROSS JOIN menus m WHERE m.code='inventory.operations'
    ON CONFLICT(role_key,menu_id) DO UPDATE SET can_view=true,can_create=true,can_edit=true,can_delete=false,can_approve=EXCLUDED.can_approve,can_export=true,scope_type='own_location',updated_at=now()`);

  await safe(`INSERT INTO role_menu_permissions(role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,can_manage_permissions,scope_type,updated_at)
    SELECT r.role_key,m.id,false,false,false,false,false,false,false,false,'own_location',now()
    FROM (VALUES('employee'),('customer')) r(role_key) CROSS JOIN menus m WHERE m.code='inventory.operations'
    ON CONFLICT(role_key,menu_id) DO UPDATE SET can_view=false,can_create=false,can_edit=false,can_delete=false,can_approve=false,can_export=false,updated_at=now()`);
}
