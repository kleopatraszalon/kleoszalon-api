BEGIN;

-- A CI-ben ténylegesen futó contract/security automatizálás jelölése a runtime UAT központban.
UPDATE uat_test_cases
SET verification_method='AUTOMATED+UAT', updated_at=now()
WHERE acceptance_criteria_id IN (
  'KLEO-FUN-WO-003-AC-02',
  'KLEO-FUN-FIN-003-AC-02',
  'KLEO-FUN-FIN-004-AC-01',
  'KLEO-FUN-FIN-004-AC-02',
  'KLEO-FUN-PROC-001-AC-01',
  'KLEO-FUN-PAY-002-AC-01',
  'KLEO-FUN-ACC-001-AC-01',
  'KLEO-FUN-ACC-001-AC-02',
  'KLEO-NFR-SEC-004-AC-01',
  'KLEO-NFR-SEC-004-AC-02',
  'KLEO-NFR-OPS-001-AC-01',
  'KLEO-NFR-IDEM-001-AC-01',
  'KLEO-NFR-REL-001-AC-01'
);

COMMIT;
