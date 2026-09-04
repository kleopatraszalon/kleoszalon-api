const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const sql=fs.readFileSync(path.resolve(__dirname,'../src/sql/20260826_LEGAL_ENTITIES_MULTI_COMPANY_V1.sql'),'utf8');

test('record loop variable cannot shadow SQL alias r used by retail and receipt backfills',()=>{
  assert.match(sql,/DECLARE[\s\S]*check_row record;/);
  assert.match(sql,/FOR check_row IN[\s\S]*check_row\.conname/);
  assert.doesNotMatch(sql,/DECLARE[\s\S]*\br record;/);
  assert.match(sql,/UPDATE retail_sales r SET legal_entity_id=COALESCE\(r\.legal_entity_id/);
  assert.match(sql,/UPDATE vir_receipts r SET legal_entity_id=COALESCE\(r\.legal_entity_id/);
});