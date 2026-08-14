const fs=require('fs');const path=require('path');const test=require('node:test');const assert=require('node:assert/strict');
const read=p=>fs.readFileSync(path.join(process.cwd(),p),'utf8');
const menu=[read('src/menu/ensureMenuHealth.ts'),read('src/menu/ensureMenuHealthLegacy.ts')].join('\n');
test('taxonomy review menu is seeded under inventory',()=>{assert.match(menu,/inventory\.taxonomy_review/);assert.match(menu,/Besorolás ellenőrzése/);assert.match(menu,/\/masterdata\/products\/taxonomy-review/);assert.match(menu,/code='inventory'/)});
test('taxonomy review menu is management-only',()=>{assert.match(menu,/\('admin'\),\('manager'\)/);assert.match(menu,/\('location_manager'\),\('salon_manager'\),\('receptionist'\),\('employee'\),\('customer'\)/);assert.match(menu,/can_approve=true/)});
