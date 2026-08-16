const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

// KLEO-NFR-QLT-001: a specifikáció nyomonkövetési kapuja kiadás előtt automatikusan fut.
test('KLEO-NFR-QLT-001 requirements baseline remains fully testable', () => {
  const root = path.resolve(__dirname, '..');
  const output = execFileSync(process.execPath, ['scripts/validate-requirements.mjs'], {
    cwd: root,
    encoding: 'utf8',
  });

  assert.match(output, /Tesztelhetőségi pontszám: 10\.0\/10\.0/);
  assert.match(output, /Követelmények: 31; elfogadási kritériumok: 62/);
});
