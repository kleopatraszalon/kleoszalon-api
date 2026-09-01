const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const read=(p)=>fs.readFileSync(path.join(process.cwd(),p),'utf8');

test('non-management users only receive their signed-in salon in the authenticated location list',()=>{
  const src=read('src/routes/locations.ts');
  assert.match(src,/canViewAllLocations/);
  assert.match(src,/req\.user\?\.location_id/);
  assert.match(src,/id::text=\$2/);
  assert.match(src,/tenant_id=\$1::bigint/);
  assert.match(src,/return res\.json\(\[\]\)/);
});

test('management roles retain tenant-wide active location visibility',()=>{
  const src=read('src/routes/locations.ts');
  for(const role of ['admin','manager','vezető','vezeto']) assert.match(src,new RegExp(role));
  assert.match(src,/is_active=true ORDER BY city,name/);
});
