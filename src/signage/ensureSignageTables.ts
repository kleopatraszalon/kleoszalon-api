import type { Pool } from "pg";

/**
 * Signage (kijelző) táblák – teljesen külön a meglévő rendszertől.
 * Kérésre: a szolgáltatások külön táblában vannak (signage_services),
 * tehát nem függünk a public.services/service_types tábláktól (500 fix).
 */
export async function ensureSignageTables(pool: Pool) {
  // gen_random_uuid (pgcrypto) – ha nincs jog, fallbackkel működik
  try { await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`); } catch {}

  // van-e gen_random_uuid?
  let hasGenRandomUuid = false;
  try {
    const r = await pool.query(`SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'gen_random_uuid') AS ok;`);
    hasGenRandomUuid = Boolean(r.rows?.[0]?.ok);
  } catch {
    hasGenRandomUuid = false;
  }

  const idCol = hasGenRandomUuid
    ? `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`
    : `id text PRIMARY KEY DEFAULT md5(random()::text || clock_timestamp()::text)`;

  // --- Szolgáltatások (külön signage tábla) ---
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
    CREATE INDEX IF NOT EXISTS idx_signage_services_show
    ON public.signage_services (show, priority, updated_at);
  `);

  // --- Akciók ---
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
    CREATE INDEX IF NOT EXISTS idx_signage_deals_active_valid
    ON public.signage_deals (active, valid_from, valid_to, priority);
  `);

  // --- Szakemberek ---
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.signage_professionals (
      ${idCol},
      name text NOT NULL,
      title text DEFAULT '',
      note text DEFAULT '',
      photo_url text DEFAULT '',
      show boolean NOT NULL DEFAULT true,
      available boolean NOT NULL DEFAULT true,
      priority int NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  try { await pool.query(`ALTER TABLE public.signage_professionals ADD COLUMN IF NOT EXISTS show boolean NOT NULL DEFAULT true;`); } catch {}
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_signage_professionals_show_avail
    ON public.signage_professionals (show, available, priority, updated_at);
  `);

  // --- Idézetek ---
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
    CREATE INDEX IF NOT EXISTS idx_signage_quotes_active_cat
    ON public.signage_quotes (active, category, priority);
  `);

  // --- Videók (YouTube playlist) ---
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
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_signage_videos_enabled
    ON public.signage_videos (enabled, priority, updated_at);
  `);
}
