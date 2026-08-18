'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=p=>fs.readFileSync(path.join(process.cwd(),p),'utf8');

test('automated release gates cannot be manually overridden',()=>{
 const src=read('src/routes/releaseControl.ts');
 assert.match(src,/const AUTOMATED_KEYS = new Set/);
 for(const key of ['version.frontend','tests.backend','build.backend','tests.frontend','build.frontend','tests.integration','tests.financial','tests.saas','tests.rbac','backup.restore'])assert.match(src,new RegExp(key.replace('.','\\.')));
 assert.match(src,/editable:!AUTOMATED_KEYS\.has\(key\)/);
 assert.match(src,/kizárólag a hitelesített GitHub Actions workflow írhatja/);
 assert.match(src,/Automatikus GitHub Actions bizonyíték kézzel nem törölhető/);
 assert.doesNotMatch(src,/if\s*\(feRef\)\s*add\(\{\s*key:\s*"version\.frontend"/);
});

test('GitHub OIDC bridge is workflow allowlisted and release scoped',()=>{
 const src=read('src/routes/releaseControlOidc.ts');
 assert.match(src,/kleoszalon-release-control/);
 assert.match(src,/refs\/heads\/main/);
 assert.match(src,/render-deploy\.yml@refs\/heads\/main/);
 assert.match(src,/backup-restore-evidence\.yml@refs\/heads\/main/);
 assert.match(src,/release_ref_mismatch/);
 assert.match(src,/rule\.keys\.has\(key\)/);
 assert.match(src,/recordReleaseEvidence/);
 const auth=read('src/routes/auth.ts');
 assert.match(auth,/releaseControlOidcRouter/);
 assert.match(auth,/router\.use\("\/uat\/release-control", releaseControlOidcRouter\)/);
});

test('backend release workflow publishes only after full quality and live smoke gates',()=>{
 const yml=read('.github/workflows/render-deploy.yml');
 for(const marker of ['id-token: write','npm run test:financial-integrity','npm run test:workorders','npm run requirements:check','npm run test:saas-isolation','Publish backend evidence to Release Control Center','expected_release_ref:process.env.GITHUB_SHA'])assert.match(yml,new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
 assert.match(yml,/RENDER_API_DEPLOY_HOOK_URL secret is not configured/);
});

test('backup restore workflow publishes production restore evidence through OIDC',()=>{
 const yml=read('.github/workflows/backup-restore-evidence.yml');
 assert.match(yml,/id-token: write/);
 assert.match(yml,/Publish production restore evidence to Release Control Center/);
 assert.match(yml,/backup\.restore/);
 assert.match(yml,/github\.event_name != 'pull_request'/);
});
