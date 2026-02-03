-- Adds `is_free` flag for signage professionals.
-- Safe to run multiple times.

ALTER TABLE IF EXISTS signage_professionals
  ADD COLUMN IF NOT EXISTS is_free BOOLEAN NOT NULL DEFAULT TRUE;

-- If you previously used `available` as availability and it exists, copy it over.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'signage_professionals' AND column_name = 'available'
  ) THEN
    EXECUTE 'UPDATE signage_professionals SET is_free = available WHERE is_free IS DISTINCT FROM available';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS signage_professionals_show_priority_idx
  ON signage_professionals (show, priority DESC);
