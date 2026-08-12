const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const source=fs.readFileSync(path.join(process.cwd(),'src/workorders/workOrderDocument.ts'),'utf8');

test('workorder runtime defaults contain exactly the two requested recipients',()=>{
  const block=source.match(/const DEFAULT_RECIPIENTS=\[([\s\S]*?)\];/)?.[1]||'';
  assert.match(block,/birtalan\.zoltan1975@gmail\.com/);
  assert.match(block,/h\.n\.andrea@kleoszalon\.hu/);
  assert.doesNotMatch(block,/rebeka\.horvath@kleoszalon\.hu/);
});

test('legacy demo recipient is replaced inside the runtime recipient function',()=>{
  assert.match(source,/LEGACY_DEMO_RECIPIENT='demo\.ugyfel@kleoszalon\.hu'/);
  assert.match(source,/toLowerCase\(\)===LEGACY_DEMO_RECIPIENT\?DEFAULT_RECIPIENTS/);
});

test('runtime recipient list deduplicates case-insensitively',()=>{
  assert.match(source,/const seen=new Set<string>\(\)/);
  assert.match(source,/const key=x\.toLowerCase\(\)/);
});
