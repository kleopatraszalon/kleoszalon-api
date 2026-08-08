BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Korábbi adatbázis-verziókban az employment_types.id előfordulhatott
-- integer/bigint típussal. A HR V2 már UUID-t használ; a két típus közötti
-- FK eltérés az egész HR + Finance/NAV bootstrapot meg tudta állítani.
DO $$
DECLARE
  id_udt text;
  contract_type_udt text;
BEGIN
  IF to_regclass('public.employment_types') IS NULL THEN
    RETURN;
  END IF;

  SELECT c.udt_name INTO id_udt
  FROM information_schema.columns c
  WHERE c.table_schema='public' AND c.table_name='employment_types' AND c.column_name='id';

  IF id_udt IS NULL OR id_udt='uuid' THEN
    RETURN;
  END IF;

  ALTER TABLE employment_types ADD COLUMN IF NOT EXISTS id_uuid uuid;
  UPDATE employment_types SET id_uuid=gen_random_uuid() WHERE id_uuid IS NULL;
  ALTER TABLE employment_types ALTER COLUMN id_uuid SET NOT NULL;

  IF to_regclass('public.employment_contracts') IS NOT NULL THEN
    SELECT c.udt_name INTO contract_type_udt
    FROM information_schema.columns c
    WHERE c.table_schema='public' AND c.table_name='employment_contracts' AND c.column_name='employment_type_id';

    IF contract_type_udt IS NOT NULL THEN
      ALTER TABLE employment_contracts DROP CONSTRAINT IF EXISTS employment_contracts_employment_type_id_fkey;
      ALTER TABLE employment_contracts ADD COLUMN IF NOT EXISTS employment_type_uuid uuid;

      UPDATE employment_contracts ec
      SET employment_type_uuid=et.id_uuid
      FROM employment_types et
      WHERE ec.employment_type_uuid IS NULL
        AND ec.employment_type_id::text=et.id::text;

      -- Olyan árva legacy hivatkozást nem dobunk el csendben. Az FK később
      -- csak akkor lesz visszakapcsolva, ha minden meglévő szerződés párosítható.
      IF EXISTS (
        SELECT 1 FROM employment_contracts
        WHERE employment_type_id IS NOT NULL AND employment_type_uuid IS NULL
      ) THEN
        RAISE EXCEPTION 'Legacy employment_contracts hivatkozás nem párosítható employment_types rekordhoz';
      END IF;

      ALTER TABLE employment_contracts DROP COLUMN employment_type_id;
      ALTER TABLE employment_contracts RENAME COLUMN employment_type_uuid TO employment_type_id;
    END IF;
  END IF;

  ALTER TABLE employment_types DROP CONSTRAINT IF EXISTS employment_types_pkey;
  ALTER TABLE employment_types DROP COLUMN id;
  ALTER TABLE employment_types RENAME COLUMN id_uuid TO id;
  ALTER TABLE employment_types ALTER COLUMN id SET DEFAULT gen_random_uuid();
  ALTER TABLE employment_types ADD CONSTRAINT employment_types_pkey PRIMARY KEY(id);

  IF to_regclass('public.employment_contracts') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='employment_contracts' AND column_name='employment_type_id'
     ) THEN
    -- Régi adatbázisban a szerződés típusa lehetett NULL. Ettől a javítás ne
    -- álljon meg; NOT NULL csak akkor kerül vissza, ha a történeti adatok ezt engedik.
    IF NOT EXISTS (SELECT 1 FROM employment_contracts WHERE employment_type_id IS NULL) THEN
      ALTER TABLE employment_contracts ALTER COLUMN employment_type_id SET NOT NULL;
    END IF;
    ALTER TABLE employment_contracts
      ADD CONSTRAINT employment_contracts_employment_type_id_fkey
      FOREIGN KEY(employment_type_id) REFERENCES employment_types(id)
      ON UPDATE CASCADE ON DELETE RESTRICT;
  END IF;
END $$;

COMMIT;
