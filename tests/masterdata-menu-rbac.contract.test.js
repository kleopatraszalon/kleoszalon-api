const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const read=(file)=>fs.readFileSync(path.join(process.cwd(),file),'utf8');
const escapeRe=(value)=>String(value).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const menuGuardRe=(menuCode)=>new RegExp(`requireMenuPermissionByMethod\\(\\s*['\"]${escapeRe(menuCode)}['\"]\\s*\\)`);

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
    const menu=src.search(menuGuardRe(menuCode));
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
    products.search(menuGuardRe('masterdata.products'))<products.indexOf('router.use(productsImportRouter)'),
    'product import router must be mounted after product menu guard'
  );
  assert.ok(
    services.search(menuGuardRe('masterdata.services'))<services.indexOf('router.use(servicesImportRouter)'),
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

test('startup creates all stage-1 masterdata menus before seeding permissions',()=>{
  const ensure=read('src/virSpec/ensureVirSpecModules.ts');
  const productMenus=ensure.indexOf('20260807_PRODUCT_MASTERDATA_MENU.sql');
  const serviceMenus=ensure.indexOf('20260807_MASTERDATA_SERVICES_MENU.sql');
  const rbacSeed=ensure.indexOf('20260810_MASTERDATA_RBAC_STAGE1.sql');

  assert.ok(productMenus>=0,'product masterdata menu migration must run at startup');
  assert.ok(serviceMenus>=0,'service masterdata menu migration must run at startup');
  assert.ok(rbacSeed>productMenus&&rbacSeed>serviceMenus,'RBAC seed must run after masterdata menus exist');
});

test('stage-1 RBAC seed covers every protected masterdata menu without overwriting custom permissions',()=>{
  const seed=read('src/sql/20260810_MASTERDATA_RBAC_STAGE1.sql');
  for(const [,menuCode] of guardedRoutes) assert.match(seed,new RegExp(`['\"]${escapeRe(menuCode)}['\"]`));
  assert.match(seed,/SELECT\s+'admin'[\s\S]*all_locations/);
  assert.match(seed,/SELECT\s+'manager'[\s\S]*true,true,true,false/);
  assert.match(seed,/ON CONFLICT\(role_key,menu_id\) DO NOTHING/g);
});
