const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const pkg=require('../package.json');
const runner=fs.readFileSync(path.join(process.cwd(),'src/dbMigrations.ts'),'utf8');

test('production startup still attempts checksum migrations before API boot',()=>{
  assert.equal(pkg.scripts?.migrate,'node dist/dbMigrations.js');
  assert.ok(typeof pkg.scripts?.start==='string');
  assert.match(pkg.scripts.start,/^npm run migrate && /);
  assert.ok(pkg.scripts.start.includes('dist/server.js'),'production start must boot the compiled API after migration preflight');
});

test('production recovery defers only non-integrity migration failures to fail-closed runtime readiness',()=>{
  assert.ok(runner.includes('MIGRATION_FAILURE_MODE'));
  assert.ok(runner.includes('NODE_ENV === "production" ? "readiness" : "strict"'));
  assert.ok(runner.includes('isMigrationIntegrityFailure'));
  assert.ok(runner.includes('Migration checksum mismatch'));
  assert.ok(runner.includes('recorded without a checksum'));
  assert.ok(runner.includes('process.exitCode = 0'));
  assert.ok(runner.includes('fail-closed readiness mode'));
  assert.ok(typeof pkg.scripts?.['start:strict-migrations']==='string');
  assert.ok(pkg.scripts['start:strict-migrations'].includes('MIGRATION_FAILURE_MODE=strict'));
  assert.ok(pkg.scripts['start:strict-migrations'].includes('npm run migrate'));
});
