const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const read=(p)=>fs.readFileSync(path.join(process.cwd(),p),'utf8');

test('authentication tokens are accepted only from Authorization header or cookie',()=>{
  const src=read('src/middleware/auth.ts');
  assert.match(src,/authorization/i);
  assert.match(src,/cookies\?\.token/);
  assert.doesNotMatch(src,/req\.query\.token/);
  assert.doesNotMatch(src,/req\.body[^\n]*token/);
});

test('production JWT signing secret has no production fallback',()=>{
  const src=read('src/security/jwtSecret.ts');
  assert.match(src,/JWT_SECRET is required in production/);
  assert.match(src,/isProduction && !configuredSecret/);
});
