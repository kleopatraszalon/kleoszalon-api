import pool from "../db";

export async function ensureKioskAdmin() {
  await pool.query(`
    ALTER TABLE menus ADD COLUMN IF NOT EXISTS code text;
    ALTER TABLE menus ADD COLUMN IF NOT EXISTS feature_key text;
    ALTER TABLE menus ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
    CREATE UNIQUE INDEX IF NOT EXISTS menus_code_uq ON menus(code) WHERE code IS NOT NULL;
  `);

  let settingsId = (await pool.query(`
    SELECT id FROM menus
    WHERE code='settings' OR lower(name) IN ('beállítások és adminisztráció','beállítások','adminisztráció')
    ORDER BY CASE WHEN code='settings' THEN 0 ELSE 1 END,id LIMIT 1
  `)).rows[0]?.id;

  if (!settingsId) {
    settingsId = (await pool.query(`
      INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
      VALUES('settings','Beállítások és adminisztráció','Settings',NULL,190,NULL,NULL,true)
      ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,icon=EXCLUDED.icon,is_active=true
      RETURNING id
    `)).rows[0].id;
  }

  const menuId = (await pool.query(`
    INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
    VALUES('screens.kiosk','Kiosk admin','MonitorSmartphone','/kiosk',172,$1,NULL,true)
    ON CONFLICT(code) DO UPDATE SET
      name=EXCLUDED.name,icon=EXCLUDED.icon,route=EXCLUDED.route,order_index=EXCLUDED.order_index,
      parent_id=EXCLUDED.parent_id,feature_key=NULL,is_active=true
    RETURNING id
  `,[settingsId])).rows[0].id;

  await pool.query(`
    INSERT INTO role_menu_permissions(
      role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,
      can_view_financial,can_manage_permissions,scope_type,updated_at
    )
    SELECT role_key,$1,true,true,true,false,false,false,false,false,scope_type,now()
    FROM (VALUES
      ('admin','all_locations'),
      ('manager','all_locations'),
      ('location_manager','own_location'),
      ('receptionist','own_location'),
      ('salon_manager','own_location')
    ) AS r(role_key,scope_type)
    ON CONFLICT(role_key,menu_id) DO UPDATE SET
      can_view=true,can_create=true,can_edit=true,can_delete=false,can_approve=false,
      scope_type=EXCLUDED.scope_type,updated_at=now()
  `,[menuId]).catch(() => undefined);
}

export default ensureKioskAdmin;
