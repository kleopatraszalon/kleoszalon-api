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

test('production start preloads recipient normalization before the API server',()=>{
  const pkg=JSON.parse(fs.readFileSync(path.join(process.cwd(),'package.json'),'utf8'));
  assert.equal(pkg.scripts.start,'node -r ./scripts/workorder-recipient-env.cjs dist/server.js');
});
