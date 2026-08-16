const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const sql = fs.readFileSync(path.join(root, 'src/sql/20260816_REQUIREMENTS_EVIDENCE_V2.sql'), 'utf8');

test('KLEO-NFR-QLT-001 execution evidence is release-auditable', () => {
  for (const required of [
    'requirement_test_evidence',
    'requirement_release_gate_runs',
    'requirement_latest_evidence',
    'uat_requirement_evidence_status',
    'catalog_requirement_id',
    'acceptance_criteria_id',
    'external_test_case_id',
    'evidence_verified',
    "decision IN ('GO','CONDITIONAL_GO','NO_GO')",
  ]) assert.ok(sql.includes(required), `missing schema contract: ${required}`);
});

test('passed execution cannot be accepted without evidence', () => {
  assert.ok(sql.includes("result <> 'passed' OR evidence_ref IS NOT NULL OR evidence_payload <> '{}'::jsonb"));
  assert.ok(sql.includes('missing_verified_evidence'));
});

test('catalog linkage is fail-closed on malformed identifiers', () => {
  assert.ok(sql.includes("catalog_requirement_id ~ '^KLEO-(GEN|FUN|NFR)-[A-Z0-9]+-[0-9]{3}$'"));
  assert.ok(sql.includes("external_test_case_id='TC-'||acceptance_criteria_id"));
});
