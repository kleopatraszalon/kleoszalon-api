const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');
const root=path.resolve(__dirname,'..');
const integration=fs.readFileSync(path.join(root,'tests/inventory_lot_fefo.integration.js'),'utf8');
const workflow=fs.readFileSync(path.join(root,'.github/workflows/inventory-lot-fefo.yml'),'utf8');

// KLEO-FUN-INV-004 / KLEO-FUN-INV-004-AC-01 / KLEO-FUN-INV-004-AC-02

test('KLEO-FUN-INV-004-AC-01 FEFO integration consumes nearest usable expiry first',()=>{
  assert.match(integration,/LOT-SOON/);
  assert.match(integration,/LOT-LATER/);
  assert.match(integration,/LOT-EXPIRED/);
  assert.match(integration,/lot_allocations\[0\]\.lot_code,'LOT-SOON'/);
  assert.match(integration,/byCode\.get\('LOT-EXPIRED'\),2/);
  assert.match(workflow,/node tests\/inventory_lot_fefo\.integration\.js/);
});

test('KLEO-FUN-INV-004-AC-02 expired aggregate stock cannot satisfy usable FEFO demand',()=>{
  assert.match(integration,/INVENTORY_FEFO_INSUFFICIENT_USABLE_STOCK/);
  assert.match(integration,/ROLLBACK TO SAVEPOINT expected_fefo_shortage/);
  assert.match(workflow,/postgres:16/);
});
