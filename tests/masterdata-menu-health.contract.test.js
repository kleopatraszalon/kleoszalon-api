const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=(file)=>fs.readFileSync(path.join(process.cwd(),file),'utf8');

test('masterdata health contains every live menu route',()=>{
  const src=read('src/menu/ensureMasterDataMenuHealth.ts');
  const markers=[
    '/masterdata','/admin/access-control','/employees',
    '/masterdata/services?view=categories','/masterdata/services','/masterdata/services?view=staff',
    '/masterdata/products/taxonomy-review','/masterdata/products?view=groups','/masterdata/products?view=categories','/masterdata/products',
    '/masterdata/equipment-types','/masterdata/assets','/hr/positions','/masterdata/departments','/masterdata/leave-types',
    '/spec/discounts','/masterdata/payment-methods','/spec/vat-types','/masterdata/salons','/masterdata/price-types',
    '/masterdata/warehouses','/masterdata/units','/spec/guest-accounts','/loyalty','/spec/guest-account-transaction-types',
    '/spec/user-fields','/masterdata/suppliers','/masterdata/movement-types','/masterdata/financial-transaction-types'
  ];
  for(const marker of markers) assert.ok(src.includes(marker),`missing masterdata route: ${marker}`);
});

test('manager receives missing masterdata permissions but not admin-only user groups',()=>{
  const src=read('src/menu/ensureMasterDataMenuHealth.ts');
  assert.match(src,/SELECT 'manager',m\.id,true,true,true,false,true,true,true,false/);
  assert.match(src,/m\.code<>'masterdata\.user-groups'/);
  assert.match(src,/WHERE m\.code='masterdata\.user-groups'[\s\S]*can_view=false/);
});

test('VIR bootstrap keeps running after an individual migration failure',()=>{
  const src=read('src/virSpec/ensureVirSpecModules.ts');
  assert.ok(src.includes('ensureMasterDataMenuHealth'));
  assert.ok(src.includes('for (const fileName of migrationFiles)'));
  assert.ok(src.includes('await pool.connect()'));
  assert.ok(src.includes('ROLLBACK'));
  assert.ok(src.includes('failures.push'));
});
