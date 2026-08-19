BEGIN;

-- Migration Center v19: a célentitás többé nem öt fix táblára korlátozott.
-- Az API a public sémából dinamikusan építi fel a VIR migrációs katalógust.
ALTER TABLE IF EXISTS migration_runs
  DROP CONSTRAINT IF EXISTS migration_runs_entity_type_check;

ALTER TABLE IF EXISTS migration_runs
  ADD COLUMN IF NOT EXISTS schema_version integer NOT NULL DEFAULT 19;

COMMENT ON COLUMN migration_runs.entity_type IS
  'VIR public céltábla neve. V19-től schema-driven katalógusból validált.';
COMMENT ON COLUMN migration_runs.schema_version IS
  'A migrációs motor szerződésverziója; schema-wide működés kezdete: 19.';

COMMIT;
