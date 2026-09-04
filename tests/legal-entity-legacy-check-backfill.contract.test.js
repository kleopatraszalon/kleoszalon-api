const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const sql=fs.readFileSync(path.join(root,'src/sql/20260826_LEGAL_ENTITIES_MULTI_COMPANY_V1.sql'),'utf8');

test('legal entity backfill temporarily suspends only legacy NOT VALID workorder checks',()=>{
  assert.match(sql,/c\.conrelid='work_orders'::regclass/);
  assert.match(sql,/c\.contype='c'/);
  assert.match(sql,/AND NOT c\.convalidated/);
  assert.match(sql,/pg_get_constraintdef\(c\.oid,true\)/);
  assert.match(sql,/ALTER TABLE work_orders DROP CONSTRAINT %I/);
  assert.match(sql,/ALTER TABLE work_orders ADD CONSTRAINT %I %s NOT VALID/);
});

test('legacy check suspension surrounds the orthogonal company backfill',()=>{
  const drop=sql.indexOf("ALTER TABLE work_orders DROP CONSTRAINT %I");
  const update=sql.indexOf('UPDATE work_orders w SET legal_entity_id=COALESCE');
  const restore=sql.indexOf('ALTER TABLE work_orders ADD CONSTRAINT %I %s NOT VALID');
  assert.ok(drop>=0 && update>drop && restore>update,'legacy checks must be suspended only around the company backfill');
});

test('archived workorders remain immutable during the compatibility backfill',()=>{
  assert.match(sql,/w\.locked_at IS NULL/);
  assert.match(sql,/w\.archived_at IS NULL/);
});

test('PLpgSQL loop record does not shadow retail or receipt table alias r',()=>{
  assert.match(sql,/check_row record/);
  assert.match(sql,/FOR check_row IN/);
  assert.match(sql,/check_row\.conname/);
  assert.match(sql,/check_row\.constraint_def/);
  assert.doesNotMatch(sql,/\br record;/);
});