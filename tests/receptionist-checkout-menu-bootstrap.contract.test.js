const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const menu=fs.readFileSync(path.join(root,'src/finance/ensureFinanceV5Menu.ts'),'utf8');

test('finance menu bootstrap grants receptionist checkout view/create/edit at own location',()=>{
  assert.match(menu,/FROM \(VALUES\('salon_manager'\),\('receptionist'\)\)/);
  assert.match(menu,/m\.code IN\('finance\.checkout','finance\.transactions','finance\.partners','finance\.documents'\) THEN true ELSE false END/);
  assert.match(menu,/false,'own_location',now\(\)/);
});