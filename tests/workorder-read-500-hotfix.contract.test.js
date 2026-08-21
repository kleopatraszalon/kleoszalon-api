const fs = require('fs');
const path = require('path');

describe('work-order read 500 hotfix wiring', () => {
  test('client hotfix handles segments and UUID client detail defensively', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'clientRead500Hotfix.ts'), 'utf8');
    expect(src).toContain('router.get("/segments"');
    expect(src).toContain('router.get("/:id"');
    expect(src).toContain('safeRows');
    expect(src).toContain('return res.json([])');
  });

  test('retail hotfix uses JSON-safe stock and product reads', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'retailProducts500Hotfix.ts'), 'utf8');
    expect(src).toContain('router.get("/retail/products"');
    expect(src).toContain("to_jsonb(p)");
    expect(src).toContain("to_jsonb(s)");
    expect(src).toContain('return res.json([])');
  });

  test('aggregators place recovery routers before legacy handlers', () => {
    const clients = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'clients.ts'), 'utf8');
    const transactions = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'transactions.ts'), 'utf8');
    expect(clients.indexOf('clientRead500HotfixRouter')).toBeGreaterThanOrEqual(0);
    expect(clients.indexOf('router.use(clientRead500HotfixRouter)')).toBeLessThan(clients.indexOf('router.use(clientDetailRecoveryRouter)'));
    expect(transactions.indexOf('retailProducts500HotfixRouter')).toBeGreaterThanOrEqual(0);
    expect(transactions.indexOf('retailProducts500HotfixRouter')).toBeLessThan(transactions.lastIndexOf('workOrderCashierFastRouter'));
  });
});
