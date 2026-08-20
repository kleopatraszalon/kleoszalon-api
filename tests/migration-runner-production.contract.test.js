const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const source=fs.readFileSync(path.join(process.cwd(),'src/dbMigrations.ts'),'utf8');

test('startup migrations override the normal request-path statement timeout',()=>{
  assert.ok(source.includes('PG_MIGRATION_STATEMENT_TIMEOUT_MS'));
  assert.ok(source.includes('PG_MIGRATION_LOCK_TIMEOUT_MS'));
  assert.ok(source.includes("set_config('statement_timeout'"));
  assert.ok(source.includes("set_config('lock_timeout'"));
  const configure=source.indexOf('await configureMigrationSession(client)');
  const lock=source.indexOf('SELECT pg_advisory_lock');
  assert.ok(configure>=0&&lock>=0&&configure<lock,'migration session must be configured before acquiring the advisory lock');
});

test('migration runner retains immutable checksum and rollback safety',()=>{
  assert.ok(source.includes('Migration checksum mismatch'));
  assert.ok(source.includes('Refusing to assume equivalence'));
  assert.ok(source.includes('await client.query("ROLLBACK")'));
  assert.ok(source.includes('[migration] failed:'));
});
