const test=require('node:test');
const assert=require('node:assert/strict');
const pkg=require('../package.json');

test('Render default start boots the API without running schema mutation first',()=>{
  assert.ok(typeof pkg.scripts?.start==='string');
  assert.ok(!pkg.scripts.start.includes('npm run migrate'),'default production start must not block API boot on schema migration');
  assert.ok(pkg.scripts.start.includes('dist/server.js'),'default production start must boot the compiled API');
});

test('controlled migration startup remains available explicitly',()=>{
  assert.ok(typeof pkg.scripts?.migrate==='string');
  assert.ok(typeof pkg.scripts?.['start:with-migrations']==='string');
  assert.ok(pkg.scripts['start:with-migrations'].includes('npm run migrate'));
  assert.ok(pkg.scripts['start:with-migrations'].includes('dist/server.js'));
});
