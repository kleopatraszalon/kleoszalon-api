BEGIN;

UPDATE uat_test_cases
SET verification_method='AUTOMATED+UAT', updated_at=now()
WHERE acceptance_criteria_id IN ('KLEO-FUN-INV-004-AC-01','KLEO-FUN-INV-004-AC-02')
   OR code='UAT-INV-FEFO-001';

COMMIT;
