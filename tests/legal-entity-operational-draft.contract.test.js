const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const sql=fs.readFileSync(path.join(root,'src/sql/20260826_LEGAL_ENTITIES_OPERATIONAL_DRAFT_V5.sql'),'utf8');
const ensure=fs.readFileSync(path.join(root,'src/finance/ensureFinanceNav.ts'),'utf8');

test('zero-company salon can create an operational work order without weakening financial controls',()=>{
  assert.match(sql,/IF active_count=0 THEN[\s\S]*RETURN NEW;/);
  assert.match(sql,/A munkalap pénzügyi művelete előtt válasszon kibocsátó céget/);
  assert.match(sql,/IF NEW\.work_order_id IS NOT NULL THEN[\s\S]*RAISE EXCEPTION/);
});

test('configured salons still prefer an explicit default issuer and multi-company ambiguity remains fail closed',()=>{
  assert.match(sql,/el\.is_default=true/);
  assert.match(sql,/active_count=1/);
  assert.match(sql,/active_count>1/);
  assert.match(sql,/több cég működik/);
});

test('operational draft compatibility migration is part of Finance NAV bootstrap after pending selection v4',()=>{
  const v4=ensure.indexOf('20260826_LEGAL_ENTITIES_PENDING_SELECTION_V4.sql');
  const v5=ensure.indexOf('20260826_LEGAL_ENTITIES_OPERATIONAL_DRAFT_V5.sql');
  assert.ok(v4>=0&&v5>v4,'V5 must run after V4');
});
