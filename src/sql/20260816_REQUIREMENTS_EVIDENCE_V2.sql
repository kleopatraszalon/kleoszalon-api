BEGIN;

-- A tesztelhető specifikáció és a tényleges végrehajtási bizonyíték szétválasztása.
-- A katalógus KLEO-* azonosítóihoz, az elfogadási kritériumokhoz és tesztesetekhez
-- build- és környezet-specifikus bizonyíték tárolható.
CREATE TABLE IF NOT EXISTS requirement_test_evidence(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requirement_id text NOT NULL,
  acceptance_criteria_id text NOT NULL,
  test_case_id text NOT NULL,
  execution_type text NOT NULL CHECK(execution_type IN ('unit','contract','integration','e2e','security','performance','resilience','inspection','manual','uat')),
  result text NOT NULL CHECK(result IN ('passed','failed','blocked','not_tested')),
  build_ref text NOT NULL,
  environment text NOT NULL,
  executed_by text NOT NULL,
  executed_at timestamptz NOT NULL DEFAULT now(),
  evidence_ref text,
  evidence_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_run_id uuid,
  source_result_id uuid,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_requirement_evidence_requirement_id CHECK(requirement_id ~ '^KLEO-(GEN|FUN|NFR)-[A-Z0-9]+-[0-9]{3}$'),
  CONSTRAINT chk_requirement_evidence_acceptance_id CHECK(acceptance_criteria_id = requirement_id || '-AC-' || right(acceptance_criteria_id,2)),
  CONSTRAINT chk_requirement_evidence_test_case_id CHECK(test_case_id = 'TC-' || acceptance_criteria_id),
  CONSTRAINT chk_requirement_evidence_build_ref CHECK(length(trim(build_ref)) >= 7),
  CONSTRAINT chk_requirement_evidence_environment CHECK(length(trim(environment)) >= 2),
  CONSTRAINT chk_requirement_evidence_executor CHECK(length(trim(executed_by)) >= 3),
  CONSTRAINT chk_requirement_evidence_reference CHECK(result <> 'passed' OR evidence_ref IS NOT NULL OR evidence_payload <> '{}'::jsonb)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_requirement_test_evidence_idempotency
  ON requirement_test_evidence(test_case_id,build_ref,environment,executed_at,coalesce(source_result_id,'00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX IF NOT EXISTS ix_requirement_test_evidence_requirement
  ON requirement_test_evidence(requirement_id,acceptance_criteria_id,executed_at DESC);
CREATE INDEX IF NOT EXISTS ix_requirement_test_evidence_release
  ON requirement_test_evidence(build_ref,environment,result,executed_at DESC);

CREATE TABLE IF NOT EXISTS requirement_release_gate_runs(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  release_ref text NOT NULL,
  build_ref text NOT NULL,
  environment text NOT NULL,
  baseline_id text NOT NULL DEFAULT 'KLEO-SRS-V2-TESTABLE-BASELINE',
  total_requirements integer NOT NULL CHECK(total_requirements >= 0),
  total_acceptance_criteria integer NOT NULL CHECK(total_acceptance_criteria >= 0),
  passed_criteria integer NOT NULL CHECK(passed_criteria >= 0),
  failed_criteria integer NOT NULL CHECK(failed_criteria >= 0),
  blocked_criteria integer NOT NULL CHECK(blocked_criteria >= 0),
  missing_evidence_criteria integer NOT NULL CHECK(missing_evidence_criteria >= 0),
  critical_open integer NOT NULL CHECK(critical_open >= 0),
  traceability_score numeric(4,1) NOT NULL CHECK(traceability_score BETWEEN 0 AND 10),
  decision text NOT NULL CHECK(decision IN ('GO','CONDITIONAL_GO','NO_GO')),
  generated_by text NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE(release_ref,build_ref,environment)
);

-- A meglévő UAT tesztesetek készen állnak arra, hogy a hivatalos KLEO baseline-hoz
-- legyenek kötve. A legacy REQ-* azonosító érintetlen marad, amíg nincs jóváhagyott mapping.
ALTER TABLE uat_test_cases ADD COLUMN IF NOT EXISTS catalog_requirement_id text;
ALTER TABLE uat_test_cases ADD COLUMN IF NOT EXISTS acceptance_criteria_id text;
ALTER TABLE uat_test_cases ADD COLUMN IF NOT EXISTS external_test_case_id text;
ALTER TABLE uat_test_cases ADD COLUMN IF NOT EXISTS evidence_required boolean NOT NULL DEFAULT true;
ALTER TABLE uat_test_cases ADD COLUMN IF NOT EXISTS requirement_lifecycle_status text;

ALTER TABLE uat_test_results ADD COLUMN IF NOT EXISTS build_ref text;
ALTER TABLE uat_test_results ADD COLUMN IF NOT EXISTS environment text;
ALTER TABLE uat_test_results ADD COLUMN IF NOT EXISTS evidence_ref text;
ALTER TABLE uat_test_results ADD COLUMN IF NOT EXISTS evidence_verified boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS ix_uat_test_cases_catalog_requirement
  ON uat_test_cases(catalog_requirement_id) WHERE catalog_requirement_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_uat_test_results_evidence
  ON uat_test_results(run_id,status,evidence_verified,updated_at DESC);

-- Csak szabályos baseline-link fogadható el. NULL megengedett a még nem felmappelt legacy UAT esetek miatt.
ALTER TABLE uat_test_cases DROP CONSTRAINT IF EXISTS chk_uat_catalog_requirement_id;
ALTER TABLE uat_test_cases ADD CONSTRAINT chk_uat_catalog_requirement_id
  CHECK(catalog_requirement_id IS NULL OR catalog_requirement_id ~ '^KLEO-(GEN|FUN|NFR)-[A-Z0-9]+-[0-9]{3}$');
ALTER TABLE uat_test_cases DROP CONSTRAINT IF EXISTS chk_uat_acceptance_criteria_id;
ALTER TABLE uat_test_cases ADD CONSTRAINT chk_uat_acceptance_criteria_id
  CHECK(acceptance_criteria_id IS NULL OR (catalog_requirement_id IS NOT NULL AND acceptance_criteria_id LIKE catalog_requirement_id || '-AC-__'));
ALTER TABLE uat_test_cases DROP CONSTRAINT IF EXISTS chk_uat_external_test_case_id;
ALTER TABLE uat_test_cases ADD CONSTRAINT chk_uat_external_test_case_id
  CHECK(external_test_case_id IS NULL OR (acceptance_criteria_id IS NOT NULL AND external_test_case_id='TC-'||acceptance_criteria_id));

CREATE OR REPLACE VIEW requirement_latest_evidence AS
SELECT DISTINCT ON (requirement_id,acceptance_criteria_id,test_case_id,environment)
  id,requirement_id,acceptance_criteria_id,test_case_id,execution_type,result,
  build_ref,environment,executed_by,executed_at,evidence_ref,evidence_payload,
  source_run_id,source_result_id,notes
FROM requirement_test_evidence
ORDER BY requirement_id,acceptance_criteria_id,test_case_id,environment,executed_at DESC,created_at DESC;

CREATE OR REPLACE VIEW uat_requirement_evidence_status AS
SELECT
  c.id AS uat_case_id,
  c.code AS uat_code,
  c.catalog_requirement_id,
  c.acceptance_criteria_id,
  c.external_test_case_id,
  c.evidence_required,
  r.id AS uat_result_id,
  r.run_id,
  r.status,
  r.tester,
  r.tested_at,
  r.build_ref,
  r.environment,
  r.evidence_ref,
  r.evidence_verified,
  r.evidence,
  CASE
    WHEN c.catalog_requirement_id IS NULL THEN 'unmapped'
    WHEN r.id IS NULL OR r.status='not_tested' THEN 'missing_execution'
    WHEN r.status='passed' AND c.evidence_required AND NOT r.evidence_verified THEN 'missing_verified_evidence'
    WHEN r.status='passed' THEN 'verified_pass'
    ELSE r.status
  END AS evidence_status
FROM uat_test_cases c
LEFT JOIN uat_test_results r ON r.test_case_id=c.id
WHERE c.active=true;

COMMIT;
