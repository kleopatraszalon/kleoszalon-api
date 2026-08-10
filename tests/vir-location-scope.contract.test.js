const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const read=(file)=>fs.readFileSync(path.join(process.cwd(),file),'utf8');
const withoutComments=(src)=>src
  .replace(/\/\*[\s\S]*?\*\//g,'')
  .replace(/\/\/.*$/gm,'');

test('VIR analytics never trusts requested location for non-admin fallback',()=>{
  const src=read('src/routes/vir.ts');
  assert.match(src,/router\.use\(requireAuth\)/);
  assert.match(src,/parseRoleKeys\(req\.user\?\.role\)/);
  assert.match(src,/if \(!userLocationId\)[\s\S]*status\(403\)/);
  assert.doesNotMatch(src,/userLocationId\s*\|\|\s*requestedLocationId/);
});

test('top VIR rankings are location-scoped instead of calling unscoped legacy functions',()=>{
  const src=read('src/routes/vir.ts');
  const code=withoutComments(src);
  assert.doesNotMatch(code,/vir_top_services\s*\(/);
  assert.doesNotMatch(code,/vir_top_staff\s*\(/);
  assert.match(code,/appointment_services/);
  assert.match(code,/a\.location_id=\$1::uuid/);
});

test('VIR drilldowns fail closed without an assigned salon',()=>{
  const src=read('src/routes/virDrilldown.ts');
  assert.match(src,/router\.use\(requireAuth\)/);
  assert.match(src,/if \(!own\)[\s\S]*status\(403\)/);
  assert.match(src,/nem található vagy nincs hozzá jogosultsága/);
});

test('emailed VIR rankings are constrained by both report period and salon',()=>{
  const src=read('src/services/virReportMailer.ts');
  const code=withoutComments(src);
  assert.doesNotMatch(code,/vir_top_services\s*\(/);
  assert.doesNotMatch(code,/vir_top_staff\s*\(/);
  assert.match(code,/a\.start_time >= \$1::date/);
  assert.match(code,/a\.location_id=\$3::uuid/);
});
