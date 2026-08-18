BEGIN;

-- Runtime hardening for the account mapping trigger introduced by V2.
-- On INSERT PostgreSQL has no OLD row, therefore the operation branches before
-- any OLD reference. This keeps first-time company chart mapping safe.
CREATE OR REPLACE FUNCTION kleo_fixed_asset_mark_account_mapping()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NULLIF(btrim(COALESCE(NEW.external_account_code,'')),'') IS NULL THEN
    NEW.mapping_status := 'unmapped';
    NEW.mapping_approved_at := NULL;
    NEW.mapping_approved_by := NULL;
    RETURN NEW;
  END IF;

  IF TG_OP='INSERT' THEN
    NEW.mapping_status := 'approved';
    NEW.mapping_approved_at := now();
    NEW.mapping_approved_by := COALESCE(NULLIF(NEW.mapping_approved_by,''),'authorized-finance-user');
    RETURN NEW;
  END IF;

  IF NEW.external_account_code IS DISTINCT FROM OLD.external_account_code
     OR OLD.mapping_status IS DISTINCT FROM 'approved' THEN
    NEW.mapping_status := 'approved';
    NEW.mapping_approved_at := now();
    NEW.mapping_approved_by := COALESCE(NULLIF(NEW.mapping_approved_by,''),'authorized-finance-user');
  END IF;
  RETURN NEW;
END $$;

INSERT INTO schema_migrations(version,description,applied_at)
VALUES(
  '20260818_FIXED_ASSET_ACCOUNTING_GOVERNANCE_V3',
  'Fixed assets: safe first-time chart-of-accounts mapping trigger without OLD access on INSERT',
  now()
)
ON CONFLICT(version) DO UPDATE SET description=EXCLUDED.description,applied_at=now();

COMMIT;
