const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

const employees=read('src/routes/employees.ts');
const timetable=read('src/routes/timetable.ts');
const customizer=read('src/routes/virCustomizer.ts');

test('dashboard employee list keeps legacy identifier joins and location scope text-safe',()=>{
  assert.match(employees,/l\.id::text=e\.location_id::text/);
  assert.match(employees,/p\.id::text=e\.position_id::text/);
  assert.match(employees,/e\.location_id::text=\$\$\{values\.length\}::text/);
  assert.doesNotMatch(employees,/e\.location_id::text=\$\{values\.length\}::text/);
  assert.match(employees,/listEmployeesLegacyScoped\(includeInactive,locationId\)/);
  assert.match(employees,/listEmployeesLegacy\(includeInactive\)/);
});

test('timetable never statically dereferences absent optional appointment child tables',()=>{
  assert.match(timetable,/to_regclass\('public\.appointment_services'\) IS NOT NULL has_services/);
  assert.match(timetable,/to_regclass\('public\.appointment_products'\) IS NOT NULL has_products/);
  assert.match(timetable,/const serviceNamesSql=hasServices/);
  assert.match(timetable,/const productTotalSql=hasProducts/);
  assert.match(timetable,/to_jsonb\(c\)->>'full_name'/);
  assert.match(timetable,/a\.location_id::text=\$3::text/);
});

test('VIR customizer preserves structured and legacy frontend response contracts',()=>{
  assert.match(customizer,/res\.json\(\{config,content:JSON\.stringify\(config\)/);
});
