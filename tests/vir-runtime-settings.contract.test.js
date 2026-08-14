const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

test('VIR runtime secrets are encrypted and never returned as plaintext',()=>{
 const src=read('src/services/virRuntimeSettings.ts');
 assert.match(src,/aes-256-gcm/);
 assert.match(src,/value_encrypted/);
 assert.match(src,/secretKeys/);
 assert.match(src,/value: isSecret \? ""/);
 assert.match(src,/hydrateRuntimeSettings/);
});

test('VIR can configure GitHub required reviewer release environments',()=>{
 const src=read('src/services/virInfrastructureControl.ts');
 assert.match(src,/production-manual-approval/);
 assert.match(src,/reviewers: \[\{ type: "User", id:/);
 assert.match(src,/method: "PUT"/);
 assert.match(src,/api\.github\.com\/repos/);
});

test('VIR Render HA control scales API and enables Postgres HA',()=>{
 const src=read('src/services/virInfrastructureControl.ts');
 assert.match(src,/\/scale`/);
 assert.match(src,/numInstances: targetInstances/);
 assert.match(src,/enableHighAvailability: true/);
 assert.match(src,/highAvailabilityEnabled/);
 assert.match(src,/ready_for_single_instance_failure/);
});

test('runtime infrastructure endpoints are admin-only',()=>{
 const src=read('src/routes/wallboardPublic.ts');
 for(const route of ['/runtime-settings','/runtime-settings/github/apply','/runtime-settings/render/verify','/runtime-settings/render/apply']) assert.ok(src.includes(route),`missing ${route}`);
 assert.match(src,/router\.get\("\/runtime-settings", requireAdmin/);
 assert.match(src,/router\.put\("\/runtime-settings", requireAdmin/);
});
