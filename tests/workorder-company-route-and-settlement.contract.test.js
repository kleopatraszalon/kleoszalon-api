const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

const receipt=fs.readFileSync('src/routes/receiptCompliance.ts','utf8');
const payment=fs.readFileSync('src/finance/workOrderPaymentIntegrity.ts','utf8');
const importRouter=fs.readFileSync('src/routes/legalEntitiesImport.ts','utf8');

test('workorder legal-entity router is not shadowed by admin-only import router',()=>{
  const workorderMount=receipt.indexOf('router.use("/legal-entities",workOrderLegalEntityRouter)');
  const normalMount=receipt.indexOf('router.use("/legal-entities",legalEntitiesRouter)');
  const importMount=receipt.indexOf('router.use("/legal-entities",legalEntitiesImportRouter)');
  assert.ok(workorderMount>=0&&normalMount>=0&&importMount>=0);
  assert.ok(workorderMount<importMount,'workorder company routes must run before admin-only import routes');
  assert.ok(normalMount<importMount,'normal company routes must run before admin-only import routes');
  assert.match(importRouter,/router\.use\(requireRoles\('admin'\)\)/);
});

test('protected settlement resolves a safe workorder issuer before payment insertion',()=>{
  assert.match(payment,/async function ensureWorkOrderLegalEntity/);
  assert.match(payment,/legal_entity_locations/);
  assert.match(payment,/el\.is_default/);
  assert.match(payment,/rows\.length===1/);
  assert.match(payment,/publicCode:'LEGAL_ENTITY_REQUIRED'/);
  assert.match(payment,/publicCode:'LEGAL_ENTITY_NOT_CONFIGURED'/);
  const resolveAt=payment.indexOf('await ensureWorkOrderLegalEntity(client,input.workOrder)');
  const paymentInsertAt=payment.indexOf('INSERT INTO work_order_payments');
  assert.ok(resolveAt>=0&&paymentInsertAt>=0&&resolveAt<paymentInsertAt,'issuer must be resolved before payment insert/DB guard');
});
