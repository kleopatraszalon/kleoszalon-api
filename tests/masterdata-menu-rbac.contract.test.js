const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const read=(file)=>fs.readFileSync(path.join(process.cwd(),file),'utf8');

const guardedRoutes=[
  ['src/routes/products.ts','masterdata.products'],
  ['src/routes/services.ts','masterdata.services'],
  ['src/routes/productGroups.ts','masterdata.product-groups'],
  ['src/routes/productCategories.ts','masterdata.product-categories'],
  ['src/routes/serviceTypes.ts','masterdata.service-types'],
];

for(const [file,menuCode] of guardedRoutes){
  test(`${file} is protected by its configured menu permission`,()=>{
    const src=read(file);
    const auth=src.indexOf('router.use(requireAuth)');
    const menu=src.indexOf(`requireMenuPermissionByMethod(${JSON.stringify(menuCode)})`);
    const firstRouteIndexes=[
      src.search(/router\.get\s*\(/),
      src.search(/router\.post\s*\(/),
      src.search(/router\.patch\s*\(/),
      src.search(/router\.put\s*\(/),
      src.search(/router\.delete\s*\(/),
    ].filter(x=>x>=0);

    assert.ok(auth>=0,'missing authentication guard');
    assert.ok(menu>=0,`missing menu RBAC guard for ${menuCode}`);
    assert.ok(auth<menu,'authentication must run before menu RBAC');
    assert.ok(firstRouteIndexes.every(index=>menu<index),'menu RBAC must run before route handlers');
  });
}

test('product and service import subrouters cannot bypass menu RBAC',()=>{
  const products=read('src/routes/products.ts');
  const services=read('src/routes/services.ts');

  assert.ok(
    products.indexOf("requireMenuPermissionByMethod('masterdata.products')")<products.indexOf('router.use(productsImportRouter)'),
    'product import router must be mounted after product menu guard'
  );
  assert.ok(
    services.indexOf('requireMenuPermissionByMethod("masterdata.services")')<services.indexOf('router.use(servicesImportRouter)'),
    'service import router must be mounted after service menu guard'
  );
});

test('method based RBAC maps writes to create/edit/delete capabilities',()=>{
  const middleware=read('src/middleware/menuPermission.ts');
  assert.match(middleware,/case\s+"POST"\s*:\s*action\s*=\s*"can_create"/);
  assert.match(middleware,/case\s+"PUT"[\s\S]*case\s+"PATCH"\s*:\s*action\s*=\s*"can_edit"/);
  assert.match(middleware,/case\s+"DELETE"\s*:\s*action\s*=\s*"can_delete"/);
  assert.match(middleware,/default\s*:\s*action\s*=\s*"can_view"/);
});
