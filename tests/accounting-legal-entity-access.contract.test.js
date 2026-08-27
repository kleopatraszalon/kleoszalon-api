const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

test('accounting role receives scoped legal-entity admin access only on receipt-compliance legal-entity routes',()=>{
  const source=read('src/middleware/requireRoles.ts');
  assert.match(source,/ACCOUNTING_ROLE_KEYS/);
  assert.match(source,/accounting/);
  assert.match(source,/bookkeeper/);
  assert.match(source,/vir\\\/receipt-compliance\\\/legal-entities/);
  assert.match(source,/allowed\.length !== 1/);
});
