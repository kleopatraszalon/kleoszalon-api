const fs=require('fs');
const assert=require('assert');

const route=fs.readFileSync('src/routes/centralMasterData.ts','utf8');
const transactions=fs.readFileSync('src/routes/transactions.ts','utf8');
const menu=fs.readFileSync('src/sql/20260813_CENTRAL_MASTERDATA_MENU_V1.sql','utf8');
const bootstrap=fs.readFileSync('src/virSpec/ensureVirSpecModules.ts','utf8');

for(const entity of [
  'salons','departments','equipment-types','equipment','suppliers','warehouses','units',
  'price-types','leave-types','movement-types','payment-methods','financial-transaction-types'
]){
  assert(route.includes(`key: "${entity}"`),`missing masterdata entity: ${entity}`);
}

for(const marker of [
  'router.get("/catalog"',
  'router.get("/:entity/export.csv"',
  'router.get("/:entity"',
  'router.post("/:entity"',
  'router.patch("/:entity/:id"',
  'router.delete("/:entity/:id"',
  'router.get("/:entity/:id/audit"'
])assert(route.includes(marker),`missing masterdata endpoint: ${marker}`);

assert(route.includes('master_data_audit'),'masterdata audit table missing');
assert(route.includes('SET ${active}=false'),'soft-deactivate implementation missing');
assert(route.includes('systemColumn')&&route.includes('rendszer által fenntartott'),'system-record protection missing');
assert(route.includes('calendar_slot_minutes'),'department calendar slot setting missing');
assert(route.includes('service_interval_days')&&route.includes('next_service_at'),'equipment service fields missing');
assert(route.includes('shelf_life_value')&&route.includes('discount_percent'),'supplier specification fields missing');
assert(route.includes('procurement_default'),'warehouse procurement default missing');
assert(route.includes("'purchase','Beszerzési ár'"),'fixed purchase price type missing');
assert(route.includes('parent_id')&&route.includes('image_url')&&route.includes('company_name'),'payment-method tree/image/company fields missing');
for(const flag of ['is_transfer','opening_shortage','closing_shortage','opening_surplus','closing_surplus'])assert(route.includes(flag),`financial transaction flag missing: ${flag}`);

assert(transactions.includes('centralMasterDataRouter'),'central masterdata router import missing');
assert(transactions.includes('router.use("/masterdata",requireManagement,centralMasterDataRouter)'),'management-protected masterdata mount missing');
assert(menu.includes("'masterdata.central','Központi törzsadatok'"),'central masterdata menu item missing');
assert(menu.includes("'masterdata.payment-methods','Fizetési módok'"),'payment methods menu item missing');
assert(menu.includes("'masterdata.transaction-types','Pénzügyi tranzakciótípusok'"),'transaction types menu item missing');
assert(bootstrap.includes('20260813_CENTRAL_MASTERDATA_MENU_V1.sql'),'central masterdata menu migration not bootstrapped');

console.log('Central masterdata contract OK');
