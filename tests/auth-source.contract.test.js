const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const exists=(p)=>fs.existsSync(path.join(process.cwd(),p));
const read=(p)=>fs.readFileSync(path.join(process.cwd(),p),'utf8');

test('the API has one canonical runtime authentication route source',()=>{
  assert.equal(exists('src/routes/auth.ts'),true,'src/routes/auth.ts must be the canonical login implementation');
  assert.equal(exists('src/routes/auth.js'),false,'stale JavaScript auth shadow source must not exist');
  assert.equal(exists('src/auth.ts'),false,'unused legacy root auth router must not exist');

  const server=read('src/server.ts');
  assert.match(server,/import authRoutes from["']\.\/routes\/auth["']/);
  assert.match(server,/app\.use\(["']\/api["'],authRoutes\)/);
});
