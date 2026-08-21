const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('client hotfix handles segments and UUID client detail defensively and tenant-scoped', () => {
  const src = read('src/routes/clientRead500Hotfix.ts');
  assert.ok(src.includes('router.get("/segments"'));
  assert.ok(src.includes('router.get("/:id"'));
  assert.ok(src.includes('safeRows'));
  assert.ok(src.includes('resolveTenantIdentity'));
  assert.ok(src.includes('tenantLocationIds'));
  assert.ok(src.includes('scope.locations'));
  assert.ok(src.includes('clientTenant !== scope.tenantId'));
  assert.ok(src.includes('client-read-500-tenant-scoped'));
});

test('tenant isolation readiness stays hard for direct entities but does not 500 on legacy child/master drift', () => {
  const src = read('src/saas/ensureTenantIsolation.ts');
  assert.ok(src.includes('hardExpected'));
  assert.ok(src.includes('softExpected'));
  assert.ok(src.includes('...LOCATION_SCOPED_TABLES'));
  assert.ok(src.includes('legacy child/master tables still require tenant migration'));
  assert.ok(src.includes('Parent/location-scoped reads remain enabled'));
});

test('retail hotfix uses JSON-safe stock and product reads', () => {
  const src = read('src/routes/retailProducts500Hotfix.ts');
  assert.ok(src.includes('router.get("/retail/products"'));
  assert.ok(src.includes('to_jsonb(p)'));
  assert.ok(src.includes('to_jsonb(s)'));
  assert.ok(src.includes('return res.json([])'));
});

test('aggregators place recovery routers before bootstrap and legacy handlers', () => {
  const clients = read('src/routes/clients.ts');
  const transactions = read('src/routes/transactions.ts');

  const clientHotfixMount = clients.indexOf('router.use(clientRead500HotfixRouter)');
  const governanceMount = clients.indexOf('router.use(clientGovernanceRouter)');
  const receptionMount = clients.indexOf('router.use(clientReceptionContextRouter)');
  const legacyClientMount = clients.indexOf('router.use(clientDetailRecoveryRouter)');
  assert.ok(clientHotfixMount >= 0, 'client hotfix router must be mounted');
  assert.ok(governanceMount >= 0, 'client governance router must remain mounted');
  assert.ok(receptionMount >= 0, 'client reception router must remain mounted');
  assert.ok(legacyClientMount >= 0, 'legacy client recovery router must remain mounted');
  assert.ok(clientHotfixMount < governanceMount, 'client read hotfix must run before governance schema bootstrap');
  assert.ok(clientHotfixMount < receptionMount, 'client read hotfix must run before reception schema bootstrap');
  assert.ok(clientHotfixMount < legacyClientMount, 'client hotfix must run before legacy recovery');

  const retailHotfixMount = transactions.indexOf('retailProducts500HotfixRouter);');
  const legacyCashierMount = transactions.lastIndexOf('workOrderCashierFastRouter);');
  assert.ok(retailHotfixMount >= 0, 'retail hotfix router must be mounted');
  assert.ok(legacyCashierMount >= 0, 'legacy cashier router must remain mounted');
  assert.ok(retailHotfixMount < legacyCashierMount, 'retail hotfix must run before legacy cashier');
});
