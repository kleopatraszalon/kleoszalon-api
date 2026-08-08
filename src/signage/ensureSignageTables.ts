import type { Pool } from "pg";

const DEFAULT_APPEARANCE = {
  template: "neon",
  colors: { background: "#09070a", surface: "#171219", surfaceAlt: "#211720", text: "#fffaf5", muted: "#cfc4c8", gold: "#b69861", accent: "#ec008c", success: "#41d67c" },
  effects: { glow: 32, blur: 18, radius: 26, contrast: 1, motion: "medium", ambient: true, scanlines: false },
  popup: { enabled: true, intervalSec: 180, durationSec: 12, initialDelaySec: 45, source: "flash_then_deal", animation: "impact", showPrice: true }
};

export async function ensureSignageTables(pool: Pool) {
  try { await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`); } catch {}

  let hasGenRandomUuid = false;
  try {
    const r = await pool.query(`SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'gen_random_uuid') AS ok;`);
    hasGenRandomUuid = Boolean(r.rows?.[0]?.ok);
  } catch { hasGenRandomUuid = false; }

  const idCol = hasGenRandomUuid
    ? `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`
    : `id text PRIMARY KEY DEFAULT md5(random()::text || clock_timestamp()::text)`;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.signage_services (
      ${idCol}, name text NOT NULL, category text DEFAULT '', duration_min int, price_text text DEFAULT '',
      show boolean NOT NULL DEFAULT true, priority int NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  try { await pool.query(`ALTER TABLE public.signage_services ADD COLUMN IF NOT EXISTS show boolean NOT NULL DEFAULT true;`); } catch {}

  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.signage_deals (
      ${idCol}, title text NOT NULL, subtitle text DEFAULT '', price_text text DEFAULT '', valid_from date, valid_to date,
      active boolean NOT NULL DEFAULT true, priority int NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.signage_professionals (
      ${idCol}, name text NOT NULL, title text DEFAULT '', note text DEFAULT '', photo_url text DEFAULT '',
      show boolean NOT NULL DEFAULT true, is_free boolean NOT NULL DEFAULT true, priority int NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  try { await pool.query(`ALTER TABLE public.signage_professionals ADD COLUMN IF NOT EXISTS show boolean NOT NULL DEFAULT true;`); } catch {}
  try { await pool.query(`ALTER TABLE public.signage_professionals ADD COLUMN IF NOT EXISTS is_free boolean NOT NULL DEFAULT true;`); } catch {}

  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.signage_quotes (
      ${idCol}, category text NOT NULL CHECK (category IN ('fitness','beauty','general')), text text NOT NULL,
      author text DEFAULT '', active boolean NOT NULL DEFAULT true, priority int NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.signage_videos (
      ${idCol}, youtube_id text NOT NULL, title text DEFAULT '', enabled boolean NOT NULL DEFAULT true,
      priority int NOT NULL DEFAULT 0, duration_sec int NOT NULL DEFAULT 60,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.signage_flash_promos (
      ${idCol}, title text NOT NULL, body text NOT NULL DEFAULT '', start_at timestamptz, end_at timestamptz,
      enabled boolean NOT NULL DEFAULT true, priority int NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.signage_settings (
      key text PRIMARY KEY, value text NOT NULL DEFAULT '', updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  await pool.query(
    `INSERT INTO public.signage_settings(key, value)
     VALUES ('nameday_template', 'Ma a {names} nevű vendégeink 20% kedvezményben részesülnek!!!')
     ON CONFLICT (key) DO NOTHING;`
  );
  await pool.query(
    `INSERT INTO public.signage_settings(key,value)
     VALUES('appearance_config',$1)
     ON CONFLICT(key) DO NOTHING`, [JSON.stringify(DEFAULT_APPEARANCE)]
  );

  try {
    const applied = (await pool.query(`SELECT value FROM public.signage_settings WHERE key='appearance_extreme_v1_applied' LIMIT 1`)).rows[0]?.value;
    if (!applied) {
      const row = (await pool.query(`SELECT value FROM public.signage_settings WHERE key='appearance_config' LIMIT 1`)).rows[0];
      let current:any={}; try { current=JSON.parse(String(row?.value||'{}')); } catch {}
      const next={...DEFAULT_APPEARANCE,...current,template:'neon',colors:{...DEFAULT_APPEARANCE.colors,...(current.colors||{})},effects:{...DEFAULT_APPEARANCE.effects,...(current.effects||{})},popup:{...DEFAULT_APPEARANCE.popup,...(current.popup||{})}};
      await pool.query(`UPDATE public.signage_settings SET value=$1,updated_at=now() WHERE key='appearance_config'`,[JSON.stringify(next)]);
      await pool.query(`INSERT INTO public.signage_settings(key,value,updated_at) VALUES('appearance_extreme_v1_applied','1',now()) ON CONFLICT(key) DO UPDATE SET value='1',updated_at=now()`);
    }
  } catch (e) { console.warn('Signage neon migration skipped:', e); }

  // VIR menü: Kijelző admin és Kijelző kinézet közvetlen testvérként jelenjen meg
  // a Beállítások és adminisztráció alatt. A Sidebar jelenleg két szintet renderel,
  // ezért a korábbi Kijelző admin -> Kijelző kinézet harmadik szint láthatatlan volt.
  try {
    await pool.query(`ALTER TABLE menus ADD COLUMN IF NOT EXISTS code text`);
    await pool.query(`ALTER TABLE menus ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS menus_code_uq ON menus(code) WHERE code IS NOT NULL`);

    let settingsId = (await pool.query(`
      SELECT id FROM menus
      WHERE code='settings' OR lower(name) IN ('beállítások és adminisztráció','beállítások','adminisztráció')
      ORDER BY CASE WHEN code='settings' THEN 0 ELSE 1 END,id LIMIT 1
    `)).rows[0]?.id || null;
    if (!settingsId) {
      settingsId = (await pool.query(`
        INSERT INTO menus(code,name,icon,route,order_index,parent_id,is_active)
        VALUES('settings','Beállítások és adminisztráció','Settings',NULL,190,NULL,true)
        ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,icon=EXCLUDED.icon,is_active=true
        RETURNING id
      `)).rows[0]?.id;
    }

    // A régi Kijelző admin is kerüljön biztosan ugyanide.
    await pool.query(`
      UPDATE menus SET parent_id=$1,is_active=true
      WHERE code IN ('screens.signage','signage') OR route='/signage'
    `,[settingsId]);

    const menuId = (await pool.query(`
      INSERT INTO menus(code,name,icon,route,order_index,parent_id,is_active)
      VALUES('screens.signage.appearance','Kijelző kinézet','Palette','/signage/appearance',174,$1,true)
      ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,icon=EXCLUDED.icon,route=EXCLUDED.route,order_index=EXCLUDED.order_index,parent_id=EXCLUDED.parent_id,is_active=true
      RETURNING id`, [settingsId])).rows[0]?.id;

    if (menuId) {
      await pool.query(`
        INSERT INTO role_menu_permissions(role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,can_manage_permissions,scope_type,updated_at)
        SELECT role_key,$1,true,true,true,false,false,false,false,false,scope_type,now()
        FROM (VALUES ('admin','all_locations'),('manager','all_locations'),('location_manager','own_location'),('receptionist','own_location'),('salon_manager','own_location')) r(role_key,scope_type)
        ON CONFLICT(role_key,menu_id) DO UPDATE SET can_view=true,can_create=true,can_edit=true,scope_type=EXCLUDED.scope_type,updated_at=now()
      `,[menuId]);
    }
  } catch (e) { console.warn('Signage appearance menu seed skipped:', e); }
}
