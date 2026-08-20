BEGIN;

-- A régi terméktörzs egyes telepítéseiben csak taxonomy_updated_at létezett.
-- Az időbeli ár-cache szinkronhoz egységes updated_at mezőt adunk hozzá.
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

INSERT INTO schema_migrations(version,description)
VALUES('20260817_PRODUCT_PRICE_HISTORY_PREP','Terméktörzs előkészítése időbeli ár-cache szinkronhoz')
ON CONFLICT(version) DO NOTHING;

COMMIT;
