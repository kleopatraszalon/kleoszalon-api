const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const service=fs.readFileSync(path.join(__dirname,'..','src','routes','services.ts'),'utf8');
const employee=fs.readFileSync(path.join(__dirname,'..','src','routes','employees.ts'),'utf8');

test('services list supports server pagination and all UI filters',()=>{
  for(const token of ['paginated','type_id','hierarchy','min_price','max_price'])assert.match(service,new RegExp(token));
  assert.match(service,/total_pages/);
  assert.match(service,/positiveInt\(req\.query\.limit,100,200\)/);
  assert.match(service,/altegioSchemaReady/);
});

test('employees list supports server pagination, filters and full-scope summary',()=>{
  for(const token of ['paginated','position_id','location_id','employment_type','wage_band'])assert.match(employee,new RegExp(token));
  assert.match(employee,/active_count/);
  assert.match(employee,/monthly_total/);
  assert.match(employee,/location_count/);
  assert.match(employee,/total_pages/);
});

test('legacy array list modes remain in services and employees',()=>{
  assert.match(service,/if\(paginated\)/);
  assert.match(service,/res\.json\(rows\.map\(mapServiceRow\)\)/);
  assert.match(employee,/if\(!paginated\).*res\.json\(rows\)/s);
});
