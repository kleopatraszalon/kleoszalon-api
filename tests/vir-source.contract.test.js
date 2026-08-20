const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const exists=(file)=>fs.existsSync(path.join(process.cwd(),file));
const read=(file)=>fs.readFileSync(path.join(process.cwd(),file),'utf8');

test('VIR API has one canonical route implementation',()=>{
  assert.equal(exists('src/routes/vir.ts'),true);
  assert.equal(exists('src/api/vir.ts'),false,'unused duplicate VIR API source must not return');
  const server=read('src/server.ts');
  assert.match(server,/import virRouter from["']\.\/routes\/vir["']/);
  assert.match(server,/app\.use\(["']\/api\/vir["'],virRouter\)/);
});
