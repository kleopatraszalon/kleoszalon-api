const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

const taxonomy=read('src/inventory/productTaxonomy.ts');
const reconcile=read('src/inventory/ensureProductTaxonomy.ts');
const products=read('src/routes/products.ts');
const productImport=read('src/routes/productsImport.ts');
const inventory=read('src/routes/inventory.ts');
const groups=read('src/routes/productGroups.ts');
const categories=read('src/routes/productCategories.ts');

test('taxonomy uses product context instead of Altegio category alone',()=>{
  assert.match(taxonomy,/input\.category, input\.name, input\.brand, input\.lineName/);
  for(const code of ['HAIR','COSMETICS','NAILS','LASH_BROW','MAKEUP','DEPILATION','CONSUMABLES','CLEANING_HYGIENE','BUFFET_GUEST','OFFICE_ADMIN','GIFT_PROMO']){
    assert.match(taxonomy,new RegExp(`"${code}"`));
  }
  assert.match(taxonomy,/HAIR_COLOR/);
  assert.match(taxonomy,/SERUM_AMPOULE/);
  assert.match(taxonomy,/GEL_POLISH/);
});

test('legacy Altegio taxonomy is reconciled non-destructively into KLEO groups',()=>{
  assert.match(reconcile,/KLEO_\$\{tx\.groupCode\}/);
  assert.match(reconcile,/COALESCE\(g\.code,''\) LIKE 'ALTG_%'/);
  assert.match(reconcile,/source_category_name/);
  assert.match(reconcile,/taxonomy_confidence/);
  assert.doesNotMatch(reconcile,/DELETE FROM public\.products/i);
});

test('product list returns hierarchy names expected by the frontend',()=>{
  assert.match(products,/g\.name AS product_group_name/);
  assert.match(products,/g\.product_type_name/);
  assert.match(products,/c\.name AS product_category_name/);
  assert.match(products,/ORDER BY COALESCE\(g\.sort_order,999\),COALESCE\(c\.sort_order,999\),p\.name/);
  assert.match(products,/\/taxonomy\/summary/);
  assert.match(products,/\/taxonomy\/rebuild/);
});

test('Altegio and CSV import both use canonical taxonomy',()=>{
  assert.match(productImport,/classifyProduct/);
  assert.match(productImport,/ensureTaxonomyNodes/);
  assert.match(productImport,/source_category_id/);
  assert.match(productImport,/source_category_name/);
  assert.doesNotMatch(productImport,/function classifyCategory/);
  assert.match(products,/Bulk import/);
  assert.match(products,/ensureTaxonomyNodes/);
});

test('inventory balances and movements expose group and category metadata',()=>{
  assert.match(inventory,/g\.name AS product_group_name/);
  assert.match(inventory,/c\.name AS product_category_name/);
  assert.match(inventory,/g\.product_type_name/);
  assert.match(inventory,/ORDER BY COALESCE\(g\.sort_order,999\),COALESCE\(c\.sort_order,999\),p\.name/);
});

test('legacy inactive groups and categories are hidden from normal selectors',()=>{
  assert.match(groups,/include_inactive/);
  assert.match(groups,/COALESCE\(is_active,true\)=true/);
  assert.match(categories,/include_inactive/);
  assert.match(categories,/COALESCE\(c\.is_active,true\)=true/);
});
