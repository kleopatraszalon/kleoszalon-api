import type { Pool } from "pg";

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
      ${idCol},
      name text NOT NULL,
      category text DEFAULT '',
      duration_min int,
      price_text text DEFAULT '',
      show boolean NOT NULL DEFAULT true,
      priority int NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  try { await pool.query(`ALTER TABLE public.signage_services ADD COLUMN IF NOT EXISTS show boolean NOT NULL DEFAULT true;`); } catch {}

  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.signage_deals (
      ${idCol},
      title text NOT NULL,
      subtitle text DEFAULT '',
      price_text text DEFAULT '',
      valid_from date,
      valid_to date,
      active boolean NOT NULL DEFAULT true,
      priority int NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.signage_professionals (
      ${idCol},
      name text NOT NULL,
      title text DEFAULT '',
      note text DEFAULT '',
      photo_url text DEFAULT '',
      show boolean NOT NULL DEFAULT true,
      is_free boolean NOT NULL DEFAULT true,
      priority int NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  try { await pool.query(`ALTER TABLE public.signage_professionals ADD COLUMN IF NOT EXISTS show boolean NOT NULL DEFAULT true;`); } catch {}
  try { await pool.query(`ALTER TABLE public.signage_professionals ADD COLUMN IF NOT EXISTS is_free boolean NOT NULL DEFAULT true;`); } catch {}

  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.signage_quotes (
      ${idCol},
      category text NOT NULL CHECK (category IN ('fitness','beauty','general')),
      text text NOT NULL,
      author text DEFAULT '',
      active boolean NOT NULL DEFAULT true,
      priority int NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.signage_videos (
      ${idCol},
      youtube_id text NOT NULL,
      title text DEFAULT '',
      enabled boolean NOT NULL DEFAULT true,
      priority int NOT NULL DEFAULT 0,
      duration_sec int NOT NULL DEFAULT 60,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  // Villám akciók (felső sávban)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.signage_flash_promos (
      ${idCol},
      title text NOT NULL,
      body text NOT NULL DEFAULT '',
      start_at timestamptz,
      end_at timestamptz,
      enabled boolean NOT NULL DEFAULT true,
      priority int NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  // Egyszerű kulcs-érték beállítások (pl. névnapos üzenet sablon)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.signage_settings (
      key text PRIMARY KEY,
      value text NOT NULL DEFAULT '',
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  // alap névnap-sablon csak első létrehozáskor
  await pool.query(
    `INSERT INTO public.signage_settings(key, value)
     VALUES ('nameday_template', 'Ma a {names} nevű vendégeink 20% kedvezményben részesülnek!!!')
     ON CONFLICT (key) DO NOTHING;`
  );

}