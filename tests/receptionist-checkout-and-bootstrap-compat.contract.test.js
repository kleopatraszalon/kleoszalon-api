const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

const sql=fs.readFileSync('src/sql/20260826_LEGAL_ENTITIES_MULTI_COMPANY_V1.sql','utf8');
const menu=fs.readFileSync('src/middleware/menuPermission.ts','utf8');

test('legal entity bootstrap avoids PL/pgSQL record-variable alias collisions',()=>{
  assert.doesNotMatch(sql,/UPDATE retail_sales r SET legal_entity_id=COALESCE\(r\.legal_entity_id/);
  assert.doesNotMatch(sql,/UPDATE vir_receipts r SET legal_entity_id=COALESCE\(r\.legal_entity_id/);
  assert.match(sql,/UPDATE retail_sales rs SET legal_entity_id=COALESCE\(rs\.legal_entity_id/);
  assert.match(sql,/UPDATE vir_receipts vr SET legal_entity_id=COALESCE\(vr\.legal_entity_id/);
});

test('receptionist can always create and edit checkout operations in own location',()=>{
  assert.match(menu,/menuCode === "finance\.checkout"/);
  assert.match(menu,/roles\.includes\("receptionist"\)/);
  assert.match(menu,/\["can_view", "can_create", "can_edit"\]\.includes\(action\)/);
  assert.match(menu,/req\.accessScope = "own_location"/);
});
