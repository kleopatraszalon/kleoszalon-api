import type { Pool } from "pg";

/**
 * Létrehozza a signage-hez szükséges DB táblákat (IF NOT EXISTS).
 * Ezek kizárólag a kijelző/admin felülethez kellenek.
 */
export async function ensureSignageTables(pool: Pool) {
  // pgcrypto kell a gen_random_uuid()-hoz (ha nincs jogosultság, nem állunk meg)
  try {
    await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);
  } catch {
    // ignore
  }

  // Deals
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.signage_deals (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
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

  // Quotes
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.signage_quotes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
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

  // Service overrides (services táblára épít)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.signage_service_overrides (
      service_id uuid PRIMARY KEY REFERENCES public.services(id) ON DELETE CASCADE,
      enabled boolean NOT NULL DEFAULT true,
      price_text_override text,
      priority int NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_signage_service_overrides_enabled
    ON public.signage_service_overrides (enabled, priority);
  `);

  // Professionals (kijelző specifikus, külön tábla)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.signage_professionals (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      title text DEFAULT '',
      note text DEFAULT '',
      photo_url text DEFAULT '',
      available boolean NOT NULL DEFAULT true,
      priority int NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_signage_professionals_available
    ON public.signage_professionals (available, priority, updated_at);
  `);
}
