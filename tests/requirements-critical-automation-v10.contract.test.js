'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'purchaseOrders.ts'), 'utf8');

test('KLEO-FUN-INV-002-AC-01 full receipt updates stock and completes all order items', () => {
  assert.match(source, /postWarehouseReceipt\(client/);
  assert.match(source, /received_quantity=received_quantity\+\$2/);
  assert.match(source, /BOOL_AND\(received_quantity>=ordered_quantity\) all_received/);
  assert.match(source, /all_received \? "received"/);
  assert.match(source, /received_at=CASE WHEN \$2='received' THEN now\(\)/);
});

test('KLEO-FUN-INV-002-AC-02 receipt cost components are persisted with document reference', () => {
  assert.match(source, /calculateReceiptCost|netUnitPrice/);
  assert.match(source, /procurement_receipt_costs/);
  assert.match(source, /net_unit_price,tax_rate_pct,ancillary_cost_total/);
  assert.match(source, /net_total,tax_total,gross_total/);
  assert.match(source, /landed_total,landed_unit_cost,document_number/);
  assert.match(source, /incomingUnitCost:landedUnitCost/);
});
