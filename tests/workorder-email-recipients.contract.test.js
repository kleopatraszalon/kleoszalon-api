const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const original=process.env.WORKORDER_CLOSE_EMAILS;
const recipientEnv=require('../scripts/workorder-recipient-env.cjs');

function restore(){
  if(original===undefined)delete process.env.WORKORDER_CLOSE_EMAILS;
  else process.env.WORKORDER_CLOSE_EMAILS=original;
}

process.on('exit',restore);

test('legacy demo recipient is replaced by the two requested addresses',()=>{
  assert.deepEqual(
    recipientEnv.normalizeWorkOrderCloseEmails('demo.ugyfel@kleoszalon.hu'),
    ['birtalan.zoltan1975@gmail.com','h.n.andrea@kleoszalon.hu']
  );
});

test('empty configuration defaults to the two requested addresses',()=>{
  assert.deepEqual(
    recipientEnv.normalizeWorkOrderCloseEmails(''),
    ['birtalan.zoltan1975@gmail.com','h.n.andrea@kleoszalon.hu']
  );
});

test('replacement is case-insensitive and removes duplicates',()=>{
  assert.deepEqual(
    recipientEnv.normalizeWorkOrderCloseEmails('DEMO.UGYFEL@KLEOSZALON.HU;BIRTALAN.ZOLTAN1975@GMAIL.COM'),
    ['birtalan.zoltan1975@gmail.com','h.n.andrea@kleoszalon.hu']
  );
});

test('production start migrates first and still preloads recipient normalization before the API server',()=>{
  const pkg=JSON.parse(fs.readFileSync(path.join(process.cwd(),'package.json'),'utf8'));
  const start=String(pkg.scripts.start||'');
  const migrate='npm run migrate';
  const api='node -r ./scripts/workorder-recipient-env.cjs dist/server.js';
  assert.ok(start.startsWith(`${migrate} && `),'production startup must apply versioned migrations first');
  assert.ok(start.includes(api),'recipient normalization preload must remain attached to the API process');
  assert.ok(start.indexOf(migrate)<start.indexOf(api),'migration must run before the recipient-preloaded API process');
});
