const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

test('API build removes stale dist output before compiling',()=>{
  const pkg=JSON.parse(fs.readFileSync(path.join(process.cwd(),'package.json'),'utf8'));
  assert.match(pkg.scripts.clean,/rmSync\('dist'/);
  assert.match(pkg.scripts.build,/^npm run clean && tsc -p tsconfig\.server\.json/);
});

test('generated dist output remains ignored by git',()=>{
  const ignore=fs.readFileSync(path.join(process.cwd(),'.gitignore'),'utf8');
  assert.match(ignore,/(^|\n)dist\/(\n|$)/);
});
