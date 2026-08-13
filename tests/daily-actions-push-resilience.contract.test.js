const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const source=fs.readFileSync('src/routes/dailyActions.ts','utf8');

test('temporary push errors do not permanently disable a phone',()=>{
  assert.match(source,/\[404,410\]\.includes/);
  assert.match(source,/transient failure/);
  assert.match(source,/push_failures:pushFailures/);
  assert.match(source,/active_devices:activeDevices/);
  assert.match(source,/push_configured:Boolean/);
});
