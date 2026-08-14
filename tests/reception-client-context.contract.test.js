const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const clients=read('src/routes/clients.ts');
const reception=read('src/routes/clientReceptionContext.ts');

test('receptionist client context route runs before the strict core client lookup',()=>{
  assert.match(clients,/clientReceptionContextRouter/);
  assert.ok(clients.indexOf('router.use(clientReceptionContextRouter)')<clients.indexOf('router.use(clientsCoreRouter)'));
});

test('receptionist may read a guest only through own-salon direct or operational relationship',()=>{
  assert.match(reception,/RECEPTION=new Set\(\['receptionist','reception','recepciós','recepcios'\]\)/);
  assert.match(reception,/a\.client_id::text=c\.id::text AND a\.location_id::text=\$2::text/);
  assert.match(reception,/w\.client_id::text=c\.id::text AND w\.location_id::text=\$2::text/);
  assert.match(reception,/\(to_jsonb\(c\)->>'location_id'\)=\$2::text/);
});

test('receptionist guest history is limited to the receptionist own salon',()=>{
  assert.match(reception,/WHERE a\.client_id::text=\$1 AND a\.location_id::text=\$2::text/);
  assert.match(reception,/scope:\{location_id:locationId,receptionist:true\}/);
});
