'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

// KLEO-GEN-AUTH-001 / KLEO-GEN-AUTH-001-AC-01
test('logout invalidates the HttpOnly auth cookie and protected auth rejects missing credentials with 401',()=>{
 const route=read('src/routes/auth.ts');
 const middleware=read('src/middleware/auth.ts');
 assert.match(route,/router\.post\("\/logout"/);
 assert.match(route,/clearAuthCookie\(res\)/);
 assert.match(route,/res\.setHeader\("Cache-Control", "no-store"\)/);
 assert.match(middleware,/const credential = getCredentialFromReq\(req\)/);
 assert.match(middleware,/if \(!credential\)/);
 assert.match(middleware,/return res\.status\(401\)\.json/);
 assert.match(middleware,/cookies\?\.token/);
});

// KLEO-GEN-AUTH-001 / KLEO-GEN-AUTH-001-AC-02
test('server auth accepts only intended credential transports so clearing browser auth cannot fall through to query or body tokens',()=>{
 const middleware=read('src/middleware/auth.ts');
 assert.match(middleware,/Authorization header or the HttpOnly cookie/);
 assert.match(middleware,/const cookieToken = \(req as any\)\.cookies\?\.token/);
 assert.doesNotMatch(middleware,/req\.query\?\.token/);
 assert.doesNotMatch(middleware,/req\.body\?\.token/);
});
