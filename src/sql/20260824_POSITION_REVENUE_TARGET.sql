ALTER TABLE hr_positions
  ADD COLUMN IF NOT EXISTS revenue_target_per_hour numeric(14,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN hr_positions.revenue_target_per_hour IS
  'Elvárt nettó árbevétel egy beosztott, szünettel csökkentett munkaórára, HUF-ban.';

INSERT INTO schema_migrations(version,description)
VALUES('20260824_001_POSITION_REVENUE_TARGET','Munkakörönkénti órás bevételi cél')
ON CONFLICT(version) DO NOTHING;
