const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const read=(file)=>fs.readFileSync(path.join(process.cwd(),file),'utf8');

const guardedFiles=[
  'src/routes/products.ts',
  'src/routes/services.ts',
  'src/routes/productGroups.ts',
  'src/routes/productCategories.ts',
  'src/routes/serviceTypes.ts',
];

for(const file of guardedFiles){
  test(`${file} requires authentication before exposing master data routes`,()=>{
    const src=read(file);
    assert.match(src,/requireAuth/);
    const guard=src.indexOf('router.use(requireAuth)');
    const firstGet=src.search(/router\.get\s*\(/);
    const firstPost=src.search(/router\.post\s*\(/);
    const firstPatch=src.search(/router\.patch\s*\(/);
    const routeIndexes=[firstGet,firstPost,firstPatch].filter(x=>x>=0);
    assert.ok(guard>=0,'missing router.use(requireAuth)');
    assert.ok(routeIndexes.every(index=>guard<index),'authentication must be registered before routes');
  });
}

test('product and service import subrouters are also behind authentication',()=>{
  const products=read('src/routes/products.ts');
  const services=read('src/routes/services.ts');
  assert.ok(products.indexOf('router.use(requireAuth)')<products.indexOf('router.use(productsImportRouter)'));
  assert.ok(services.indexOf('router.use(requireAuth)')<services.indexOf('router.use(servicesImportRouter)'));
});
