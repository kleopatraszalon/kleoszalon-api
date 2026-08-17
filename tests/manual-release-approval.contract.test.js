'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/manual-release-approval.yml'), 'utf8');
const validator = fs.readFileSync(path.join(root, 'scripts/validate-manual-release-evidence.mjs'), 'utf8');

test('manual release approval requires structured tester evidence before GO', () => {
  for (const token of ['release_ref', 'environment', 'tester', 'executed_at', 'approval_status', 'test_cases', 'evidence_ref']) {
    assert.ok(validator.includes(token), `missing manual evidence field contract: ${token}`);
  }
  assert.ok(validator.includes("approved evidence contains non-passed cases"));
  assert.ok(workflow.includes('Validate manual test protocol'));
  assert.ok(workflow.includes('Reject non-approved protocol'));
  assert.ok(workflow.includes('Full automated regression'));
  assert.ok(workflow.includes('Production TypeScript build'));
  assert.ok(workflow.includes("decision:'GO'"));
});

test('manual release decision is build/environment bound and retains evidence artifact', () => {
  assert.ok(workflow.includes('manual evidence release_ref does not match workflow input'));
  assert.ok(workflow.includes('manual evidence environment does not match workflow input'));
  assert.ok(workflow.includes('manual-release-evidence.json'));
  assert.ok(workflow.includes('release-decision.json'));
  assert.ok(workflow.includes('retention-days: 180'));
});
