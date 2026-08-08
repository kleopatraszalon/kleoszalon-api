import pool from "../db";
import { DEFAULT_WEBSITE_CONFIG } from "./defaultWebsiteConfig";

export async function ensureWebsiteCms() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS website_cms (
      id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      draft jsonb NOT NULL,
      published jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      published_at timestamptz,
      updated_by bigint
    );
    CREATE TABLE IF NOT EXISTS website_cms_revisions (
      id bigserial PRIMARY KEY,
      revision_type text NOT NULL CHECK (revision_type IN ('draft','publish')),
      config jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by bigint
    );
  `);

  await pool.query(
    `INSERT INTO website_cms(id,draft,published)
     VALUES(1,$1::jsonb,$1::jsonb)
     ON CONFLICT(id) DO NOTHING`,
    [JSON.stringify(DEFAULT_WEBSITE_CONFIG)]
  );

  // A Weboldal admin a Beállítások és adminisztráció alatt jelenik meg.
  await pool.query(`
    ALTER TABLE menus ADD COLUMN IF NOT EXISTS code text;
    ALTER TABLE menus ADD COLUMN IF NOT EXISTS feature_key text;
    ALTER TABLE menus ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
    CREATE UNIQUE INDEX IF NOT EXISTS menus_code_uq ON menus(code) WHERE code IS NOT NULL;
  `);

  const parent = await pool.query(`
    SELECT id FROM menus
    WHERE code IN ('settings','settings.admin','administration')
       OR lower(name) IN ('beállítások és adminisztráció','beállítások','adminisztráció')
    ORDER BY CASE WHEN code='settings' THEN 0 ELSE 1 END,id
    LIMIT 1
  `);
  let parentId = parent.rows[0]?.id ? Number(parent.rows[0].id) : null;
  if (!parentId) {
    const created = await pool.query(`
      INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
      VALUES('settings','Beállítások és adminisztráció','Settings',NULL,190,NULL,'audit',true)
      ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,icon=EXCLUDED.icon,is_active=true
      RETURNING id
    `);
    parentId = Number(created.rows[0].id);
  }

  const menu = await pool.query(`
    INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
    VALUES('settings.website','Weboldal admin','Globe2','/admin/website',170,$1,'marketing',true)
    ON CONFLICT(code) DO UPDATE SET
      name=EXCLUDED.name,icon=EXCLUDED.icon,route=EXCLUDED.route,order_index=EXCLUDED.order_index,
      parent_id=EXCLUDED.parent_id,feature_key=EXCLUDED.feature_key,is_active=true
    RETURNING id
  `, [parentId]);

  const menuId = Number(menu.rows[0].id);
  await pool.query(`
    INSERT INTO role_menu_permissions(
      role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,
      can_view_financial,can_manage_permissions,scope_type,updated_at
    )
    VALUES
      ('admin',$1,true,true,true,false,true,true,false,true,'all_locations',now()),
      ('manager',$1,true,true,true,false,true,true,false,false,'all_locations',now())
    ON CONFLICT(role_key,menu_id) DO UPDATE SET
      can_view=true,can_create=true,can_edit=true,can_approve=true,can_export=true,
      scope_type='all_locations',updated_at=now()
  `, [menuId]).catch(() => undefined);
}
