BEGIN;

-- Kleoszalon fixed-asset accounting governance V2
-- The subledger may only post with an explicitly mapped company chart of
-- accounts and an explicitly approved asset policy. Legacy master-equipment
-- data is imported as a review suggestion, never as an automatically approved
-- depreciation/maintenance policy.

ALTER TABLE gl_accounts
  ADD COLUMN IF NOT EXISTS mapping_status text NOT NULL DEFAULT 'unmapped',
  ADD COLUMN IF NOT EXISTS mapping_approved_by text,
  ADD COLUMN IF NOT EXISTS mapping_approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS mapping_note text;

ALTER TABLE fixed_assets
  ADD COLUMN IF NOT EXISTS depreciation_policy_approved_by text,
  ADD COLUMN IF NOT EXISTS depreciation_policy_approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS policy_review_reason text;

ALTER TABLE fixed_asset_maintenance_plans
  ADD COLUMN IF NOT EXISTS policy_source text NOT NULL DEFAULT 'manual';

ALTER TABLE gl_journal_lines
  ADD COLUMN IF NOT EXISTS external_account_code_snapshot text;

-- Existing non-empty company mappings are retained as approved. Empty mappings
-- remain fail-closed until an authorised finance user sets the actual account.
UPDATE gl_accounts
SET mapping_status='approved',
    mapping_approved_at=COALESCE(mapping_approved_at,now()),
    mapping_approved_by=COALESCE(mapping_approved_by,'existing-authorized-mapping')
WHERE NULLIF(btrim(COALESCE(external_account_code,'')),'') IS NOT NULL;

UPDATE gl_accounts
SET mapping_status='unmapped',mapping_approved_at=NULL,mapping_approved_by=NULL
WHERE NULLIF(btrim(COALESCE(external_account_code,'')),'') IS NULL;

CREATE OR REPLACE FUNCTION kleo_fixed_asset_mark_account_mapping()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NULLIF(btrim(COALESCE(NEW.external_account_code,'')),'') IS NULL THEN
    NEW.mapping_status := 'unmapped';
    NEW.mapping_approved_at := NULL;
    NEW.mapping_approved_by := NULL;
  ELSIF TG_OP='INSERT'
     OR NEW.external_account_code IS DISTINCT FROM OLD.external_account_code
     OR OLD.mapping_status IS DISTINCT FROM 'approved' THEN
    NEW.mapping_status := 'approved';
    NEW.mapping_approved_at := now();
    NEW.mapping_approved_by := COALESCE(NULLIF(NEW.mapping_approved_by,''),'authorized-finance-user');
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_kleo_fixed_asset_mark_account_mapping_insert ON gl_accounts;
CREATE TRIGGER trg_kleo_fixed_asset_mark_account_mapping_insert
BEFORE INSERT ON gl_accounts
FOR EACH ROW EXECUTE FUNCTION kleo_fixed_asset_mark_account_mapping();

DROP TRIGGER IF EXISTS trg_kleo_fixed_asset_mark_account_mapping_update ON gl_accounts;
DROP TRIGGER IF EXISTS trg_kleo_fixed_asset_mark_account_mapping ON gl_accounts;
CREATE TRIGGER trg_kleo_fixed_asset_mark_account_mapping_update
BEFORE UPDATE OF external_account_code ON gl_accounts
FOR EACH ROW EXECUTE FUNCTION kleo_fixed_asset_mark_account_mapping();

-- Only the dedicated accounting/admin roles may approve the final combination
-- of useful life, residual value, tax classification/rate and manufacturer
-- maintenance policy. Role lookup is performed from the actor stored in
-- updated_by so a generic manager PATCH cannot silently approve depreciation.
CREATE OR REPLACE FUNCTION kleo_fixed_asset_actor_can_approve(p_actor text)
RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE v_ok boolean := false;
BEGIN
  IF NULLIF(btrim(COALESCE(p_actor,'')),'') IS NULL THEN RETURN false; END IF;
  IF to_regclass('public.users') IS NULL THEN RETURN false; END IF;

  SELECT EXISTS(
    SELECT 1 FROM users u
    WHERE (
      u.id::text=p_actor OR
      lower(COALESCE(to_jsonb(u)->>'email',''))=lower(p_actor) OR
      lower(COALESCE(to_jsonb(u)->>'login_name',''))=lower(p_actor)
    )
    AND (
      lower(COALESCE(to_jsonb(u)->>'role','')) LIKE '%accounting%' OR
      lower(COALESCE(to_jsonb(u)->>'role','')) LIKE '%bookkeeper%' OR
      lower(COALESCE(to_jsonb(u)->>'role','')) LIKE '%konyveles%' OR
      lower(COALESCE(to_jsonb(u)->>'role','')) LIKE '%könyvelés%' OR
      lower(COALESCE(to_jsonb(u)->>'role','')) LIKE '%admin%' OR
      lower(COALESCE(to_jsonb(u)->>'role','')) LIKE '%rendszergazda%'
    )
  ) INTO v_ok;
  RETURN COALESCE(v_ok,false);
END $$;

CREATE OR REPLACE FUNCTION kleo_fixed_asset_validate_policy_approval()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  approval_requested boolean;
  policy_changed boolean;
  maintenance_ready boolean;
BEGIN
  -- A new asset cannot be born approved because its manufacturer maintenance
  -- plan cannot exist until the asset id exists. It always enters review first.
  IF TG_OP='INSERT' THEN
    IF NEW.depreciation_policy_status='approved' THEN
      NEW.depreciation_policy_status := 'needs_review';
      NEW.policy_review_reason := 'Új eszköz: a számviteli, TAO- és gyártói karbantartási adatok külön jóváhagyása szükséges.';
    END IF;
    NEW.depreciation_policy_approved_by := NULL;
    NEW.depreciation_policy_approved_at := NULL;
    RETURN NEW;
  END IF;

  approval_requested := NEW.depreciation_policy_status='approved'
                        AND OLD.depreciation_policy_status IS DISTINCT FROM 'approved';
  policy_changed := OLD.depreciation_policy_status='approved'
                    AND NEW.depreciation_policy_status='approved'
                    AND (
                      NEW.useful_life_months IS DISTINCT FROM OLD.useful_life_months OR
                      NEW.residual_value IS DISTINCT FROM OLD.residual_value OR
                      NEW.depreciation_method IS DISTINCT FROM OLD.depreciation_method OR
                      NEW.book_annual_rate IS DISTINCT FROM OLD.book_annual_rate OR
                      NEW.tax_depreciation_rate IS DISTINCT FROM OLD.tax_depreciation_rate OR
                      NEW.tax_classification IS DISTINCT FROM OLD.tax_classification OR
                      NEW.capitalized_cost IS DISTINCT FROM OLD.capitalized_cost
                    );

  IF policy_changed THEN
    NEW.depreciation_policy_status := 'needs_review';
    NEW.depreciation_policy_approved_by := NULL;
    NEW.depreciation_policy_approved_at := NULL;
    NEW.policy_review_reason := 'A jóváhagyott számviteli/adózási paraméter megváltozott; új könyvelői jóváhagyás szükséges.';
    RETURN NEW;
  END IF;

  IF approval_requested THEN
    IF NOT kleo_fixed_asset_actor_can_approve(NEW.updated_by) THEN
      RAISE EXCEPTION 'Az amortizációs politika végleges jóváhagyását csak a Könyvelés vagy rendszergazda végezheti.' USING ERRCODE='42501';
    END IF;
    IF COALESCE(NEW.useful_life_months,0) <= 0 THEN
      RAISE EXCEPTION 'A hasznos élettartam jóváhagyás előtt kötelező.' USING ERRCODE='23514';
    END IF;
    IF COALESCE(NEW.residual_value,0) < 0 OR COALESCE(NEW.residual_value,0) > COALESCE(NEW.capitalized_cost,0) THEN
      RAISE EXCEPTION 'A maradványérték hibás vagy meghaladja a bekerülési értéket.' USING ERRCODE='23514';
    END IF;
    IF NULLIF(btrim(COALESCE(NEW.tax_classification,'')),'') IS NULL THEN
      RAISE EXCEPTION 'A TAO/VTSZ besorolás jóváhagyás előtt kötelező.' USING ERRCODE='23514';
    END IF;
    IF NEW.tax_depreciation_rate IS NULL OR NEW.tax_depreciation_rate < 0 THEN
      RAISE EXCEPTION 'Az adó szerinti leírási kulcs jóváhagyás előtt kötelező.' USING ERRCODE='23514';
    END IF;

    SELECT EXISTS(
      SELECT 1
      FROM fixed_asset_maintenance_plans mp
      WHERE mp.asset_id=NEW.id
        AND mp.active=true
        AND COALESCE(mp.frequency_value,0)>0
        AND mp.next_due_at IS NOT NULL
        AND NULLIF(btrim(COALESCE(mp.manufacturer_reference,'')),'') IS NOT NULL
        AND lower(mp.manufacturer_reference) NOT LIKE 'migrált%'
        AND lower(mp.manufacturer_reference) NOT LIKE 'migralt%'
        AND CASE WHEN jsonb_typeof(mp.checklist)='array' THEN jsonb_array_length(mp.checklist) ELSE 0 END > 0
    ) INTO maintenance_ready;

    IF NOT maintenance_ready THEN
      RAISE EXCEPTION 'A gyártói/jogszabályi karbantartási periódus, dokumentumhivatkozás, következő esedékesség és ellenőrzőlista jóváhagyás előtt kötelező.' USING ERRCODE='23514';
    END IF;

    NEW.depreciation_policy_approved_by := NEW.updated_by;
    NEW.depreciation_policy_approved_at := now();
    NEW.policy_review_reason := NULL;
  ELSIF NEW.depreciation_policy_status IS DISTINCT FROM 'approved' THEN
    NEW.depreciation_policy_approved_by := NULL;
    NEW.depreciation_policy_approved_at := NULL;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_kleo_fixed_asset_validate_policy_approval ON fixed_assets;
CREATE TRIGGER trg_kleo_fixed_asset_validate_policy_approval
BEFORE INSERT OR UPDATE ON fixed_assets
FOR EACH ROW EXECUTE FUNCTION kleo_fixed_asset_validate_policy_approval();

-- Maintenance changes invalidate an already approved asset policy, forcing a
-- deliberate accounting re-approval after a manufacturer instruction changes.
CREATE OR REPLACE FUNCTION kleo_fixed_asset_invalidate_policy_from_maintenance()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_asset_id uuid;
BEGIN
  IF TG_OP='DELETE' THEN v_asset_id := OLD.asset_id; ELSE v_asset_id := NEW.asset_id; END IF;
  UPDATE fixed_assets
     SET depreciation_policy_status='needs_review',
         depreciation_policy_approved_by=NULL,
         depreciation_policy_approved_at=NULL,
         policy_review_reason='A karbantartási terv megváltozott; új könyvelői jóváhagyás szükséges.',
         updated_at=now()
   WHERE id=v_asset_id AND depreciation_policy_status='approved';
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;

DROP TRIGGER IF EXISTS trg_kleo_fixed_asset_invalidate_policy_from_maintenance ON fixed_asset_maintenance_plans;
CREATE TRIGGER trg_kleo_fixed_asset_invalidate_policy_from_maintenance
AFTER INSERT OR UPDATE OR DELETE ON fixed_asset_maintenance_plans
FOR EACH ROW EXECUTE FUNCTION kleo_fixed_asset_invalidate_policy_from_maintenance();

-- Preserve the exact external account mapping used at posting time. A later
-- chart-of-accounts change must not rewrite historical journal interpretation.
CREATE OR REPLACE FUNCTION kleo_fixed_asset_require_mapped_account()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_source_type text;
  v_external text;
  v_mapping_status text;
BEGIN
  SELECT source_type INTO v_source_type FROM gl_journal_entries WHERE id=NEW.entry_id;
  SELECT external_account_code,mapping_status
    INTO v_external,v_mapping_status
    FROM gl_accounts WHERE code=NEW.account_code;

  IF COALESCE(v_source_type,'') LIKE 'fixed_asset_%' OR COALESCE(v_source_type,'')='manual' THEN
    IF NULLIF(btrim(COALESCE(v_external,'')),'') IS NULL OR COALESCE(v_mapping_status,'unmapped')<>'approved' THEN
      RAISE EXCEPTION 'A(z) % belső főkönyvi számla nincs jóváhagyott Kleoszalon számlatükör-számlához rendelve.',NEW.account_code USING ERRCODE='23514';
    END IF;
  END IF;

  NEW.external_account_code_snapshot := NULLIF(btrim(COALESCE(v_external,'')),'');
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_kleo_fixed_asset_require_mapped_account ON gl_journal_lines;
CREATE TRIGGER trg_kleo_fixed_asset_require_mapped_account
BEFORE INSERT OR UPDATE OF account_code ON gl_journal_lines
FOR EACH ROW EXECUTE FUNCTION kleo_fixed_asset_require_mapped_account();

-- Defence in depth: capitalization, depreciation and capital improvements may
-- never post from an unapproved asset card even if an API regression bypasses
-- the application-level checks.
CREATE OR REPLACE FUNCTION kleo_fixed_asset_require_approved_policy_for_journal()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_asset_id uuid;
  v_policy text;
BEGIN
  IF NEW.source_type='fixed_asset_capitalization' THEN
    v_asset_id := NULLIF(NEW.source_id,'')::uuid;
  ELSIF NEW.source_type='fixed_asset_depreciation' THEN
    SELECT asset_id INTO v_asset_id FROM fixed_asset_depreciation_entries WHERE id=NULLIF(NEW.source_id,'')::uuid;
  ELSIF NEW.source_type='fixed_asset_improvement' THEN
    SELECT asset_id INTO v_asset_id FROM fixed_asset_maintenance_orders WHERE id=NULLIF(NEW.source_id,'')::uuid;
  ELSE
    RETURN NEW;
  END IF;

  IF v_asset_id IS NULL THEN
    RAISE EXCEPTION 'A tárgyi eszköz könyvelési tételhez nem oldható fel eszközazonosító.' USING ERRCODE='23514';
  END IF;

  SELECT depreciation_policy_status INTO v_policy FROM fixed_assets WHERE id=v_asset_id AND active=true;
  IF COALESCE(v_policy,'needs_review')<>'approved' THEN
    RAISE EXCEPTION 'A tárgyi eszköz számviteli, TAO- és karbantartási politikája nincs jóváhagyva.' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_kleo_fixed_asset_require_approved_policy_for_journal ON gl_journal_entries;
CREATE TRIGGER trg_kleo_fixed_asset_require_approved_policy_for_journal
BEFORE INSERT ON gl_journal_entries
FOR EACH ROW EXECUTE FUNCTION kleo_fixed_asset_require_approved_policy_for_journal();

-- Legacy master_equipment service intervals are copied only as review proposals.
-- They deliberately start with a "Migrált" manufacturer reference, which the
-- approval trigger refuses until the real manufacturer manual/reference is set.
DO $$
BEGIN
  IF to_regclass('public.master_equipment') IS NOT NULL THEN
    INSERT INTO fixed_asset_maintenance_plans(
      asset_id,title,maintenance_type,trigger_type,frequency_value,frequency_unit,
      manufacturer_reference,checklist,responsible_role,estimated_minutes,estimated_cost,
      last_completed_at,next_due_at,active,policy_source,created_by
    )
    SELECT
      a.id,
      'Megelőző karbantartás – gyártói előírás ellenőrzendő',
      'preventive','time',
      CASE WHEN COALESCE(to_jsonb(e)->>'service_interval_days','') ~ '^[0-9]+$'
           THEN GREATEST((to_jsonb(e)->>'service_interval_days')::int,1) ELSE 1 END,
      'day',
      'Migrált master_equipment szervizperiódus – a gyártói kézikönyv pontos hivatkozásával jóváhagyandó',
      jsonb_build_array('Gyártói karbantartási kézikönyv szerinti feladatlista rögzítendő'),
      'Karbantartás',0,0,
      CASE WHEN COALESCE(to_jsonb(e)->>'last_service_at','') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN (to_jsonb(e)->>'last_service_at')::date ELSE NULL END,
      CASE
        WHEN COALESCE(to_jsonb(e)->>'next_service_at','') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN (to_jsonb(e)->>'next_service_at')::date
        ELSE (COALESCE(a.commissioned_at,a.purchase_date,CURRENT_DATE)
              + ((CASE WHEN COALESCE(to_jsonb(e)->>'service_interval_days','') ~ '^[0-9]+$'
                        THEN GREATEST((to_jsonb(e)->>'service_interval_days')::int,1) ELSE 1 END)::text || ' days')::interval)::date
      END,
      true,'legacy_master_equipment','masterdata_sync'
    FROM fixed_assets a
    JOIN master_equipment e ON a.source_master_equipment_id=e.id::text
    WHERE COALESCE(to_jsonb(e)->>'service_interval_days','') ~ '^[0-9]+$'
      AND (to_jsonb(e)->>'service_interval_days')::int > 0
      AND NOT EXISTS(
        SELECT 1 FROM fixed_asset_maintenance_plans mp
        WHERE mp.asset_id=a.id AND mp.active=true
      );
  END IF;
END $$;

-- Every legacy master-equipment row remains review-required until an authorised
-- accounting user sets the actual useful life, residual value, TAO data and
-- replaces the migrated maintenance reference with the manufacturer source.
UPDATE fixed_assets
SET depreciation_policy_status='needs_review',
    depreciation_policy_approved_by=NULL,
    depreciation_policy_approved_at=NULL,
    policy_review_reason=COALESCE(policy_review_reason,'Migrált eszköz: számviteli, TAO- és gyártói karbantartási adatok jóváhagyása szükséges.'),
    updated_at=now()
WHERE source_master_equipment_id IS NOT NULL
  AND capitalization_journal_id IS NULL;

-- Readiness views for audit, UAT and accounting reconciliation.
CREATE OR REPLACE VIEW fixed_asset_governance_readiness_v AS
SELECT
  (SELECT COUNT(*)::int FROM gl_accounts
    WHERE code LIKE 'FA-%' AND (mapping_status<>'approved' OR NULLIF(btrim(COALESCE(external_account_code,'')),'') IS NULL)) AS unmapped_gl_accounts,
  (SELECT COUNT(*)::int FROM fixed_assets
    WHERE active=true AND status NOT IN('disposed','sold','scrapped') AND depreciation_policy_status<>'approved') AS assets_needing_policy_review,
  (SELECT COUNT(*)::int FROM fixed_assets a
    WHERE a.active=true AND a.status NOT IN('disposed','sold','scrapped') AND NOT EXISTS(
      SELECT 1 FROM fixed_asset_maintenance_plans mp
      WHERE mp.asset_id=a.id AND mp.active=true
        AND COALESCE(mp.frequency_value,0)>0
        AND mp.next_due_at IS NOT NULL
        AND NULLIF(btrim(COALESCE(mp.manufacturer_reference,'')),'') IS NOT NULL
        AND lower(mp.manufacturer_reference) NOT LIKE 'migrált%'
        AND lower(mp.manufacturer_reference) NOT LIKE 'migralt%'
    )) AS assets_needing_maintenance_source,
  (SELECT COUNT(*)::int FROM fixed_assets WHERE source_master_equipment_id IS NOT NULL AND active=true) AS migrated_master_equipment_assets,
  (SELECT COUNT(*)::int FROM fixed_asset_depreciation_entries WHERE status='planned') AS unposted_depreciation_rows;

CREATE OR REPLACE VIEW fixed_asset_gl_export_v AS
SELECT
  e.journal_no,e.entry_date,e.period_month,e.location_id,e.source_type,e.source_id,e.description,
  l.line_no,l.account_code,a.name AS internal_account_name,
  COALESCE(l.external_account_code_snapshot,a.external_account_code) AS external_account_code,
  l.debit,l.credit,l.cost_center,l.asset_id,l.partner_id,l.memo,e.created_by,e.posted_at
FROM gl_journal_entries e
JOIN gl_journal_lines l ON l.entry_id=e.id
LEFT JOIN gl_accounts a ON a.code=l.account_code
WHERE e.status='posted';

-- Dedicated accounting feature and explicit all-location permission.
INSERT INTO role_feature_permissions(role_key,feature_key,can_use,scope_type,updated_at)
VALUES
  ('accounting','finance',true,'all_locations',now()),
  ('accounting','fixed_assets',true,'all_locations',now())
ON CONFLICT(role_key,feature_key) DO UPDATE
SET can_use=true,scope_type='all_locations',updated_at=now();

UPDATE access_roles
SET description='Könyvelői moduladmin: teljes jogosultság a Pénzügyek, NAV, bér, Beszerzés, Raktár/Készlet és Tárgyi eszközök/amortizáció modulban minden telephelyre. A tárgyi eszközök számlatükör-leképezése, számviteli/TAO politika jóváhagyása, aktiválása, értékcsökkenése és időszakzárása engedélyezett. Globális jogosultságadminisztráció nem része a szerepkörnek.',
    updated_at=now()
WHERE lower(role_key)='accounting';

INSERT INTO role_menu_permissions(
  role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,
  can_view_financial,can_manage_permissions,scope_type,updated_at
)
SELECT 'accounting',m.id,true,true,true,true,true,true,true,false,'all_locations',now()
FROM menus m
WHERE m.code='finance.fixed_assets'
ON CONFLICT(role_key,menu_id) DO UPDATE SET
  can_view=true,can_create=true,can_edit=true,can_delete=true,can_approve=true,can_export=true,
  can_view_financial=true,can_manage_permissions=false,scope_type='all_locations',updated_at=now();

INSERT INTO schema_migrations(version,description,applied_at)
VALUES(
  '20260818_FIXED_ASSET_ACCOUNTING_GOVERNANCE_V2',
  'Fixed assets: company chart mapping gate, accounting-only policy approval, legacy review migration, GL snapshot/export and accounting RBAC',
  now()
)
ON CONFLICT(version) DO UPDATE SET description=EXCLUDED.description,applied_at=now();

COMMIT;
