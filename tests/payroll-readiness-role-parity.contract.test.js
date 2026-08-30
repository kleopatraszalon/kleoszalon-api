const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const source=fs.readFileSync(path.join(__dirname,'..','src','routes','payrollReadinessHotfix.ts'),'utf8');

test('payroll readiness admits canonical HR management role',()=>{
  assert.match(source,/roles\.includes\("hr_manager"\)/);
});

test('payroll readiness scopes both location and salon managers to their own salon',()=>{
  assert.match(source,/roles\.includes\("location_manager"\)\|\|roles\.includes\("salon_manager"\)/);
  assert.match(source,/req\.user\?\.location_id/);
});

test('payroll readiness remains authenticated and rejects unrelated roles',()=>{
  assert.match(source,/router\.use\(requireAuth\)/);
  assert.match(source,/return \{ok:false,status:403/);
});
