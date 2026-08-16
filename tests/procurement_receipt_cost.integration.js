'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { calculateReceiptCost } = require('../dist/procurement/receiptCost.js');

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query(`
      CREATE EXTENSION IF NOT EXISTS pgcrypto;
      CREATE TABLE products(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL);
      CREATE TABLE purchase_orders(id bigserial PRIMARY KEY, supplier_name text NOT NULL DEFAULT 'Supplier');
      CREATE TABLE purchase_order_items(
        id bigserial PRIMARY KEY,
        purchase_order_id bigint NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
        product_id uuid NOT NULL REFERENCES products(id),
        ordered_quantity numeric(14,3) NOT NULL,
        received_quantity numeric(14,3) NOT NULL DEFAULT 0,
        unit_cost numeric(14,2) NOT NULL DEFAULT 0,
        actual_unit_cost numeric(14,2),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    const migration = fs.readFileSync(path.join(__dirname, '..', 'src', 'sql', '20260816_PROCUREMENT_RECEIPT_COST_INTEGRITY_V1.sql'), 'utf8');
    await client.query(migration);

    const product = await client.query(`INSERT INTO products(name) VALUES('Evidence product') RETURNING id`);
    const order = await client.query(`INSERT INTO purchase_orders(supplier_name) VALUES('Evidence supplier') RETURNING id`);
    const item = await client.query(`INSERT INTO purchase_order_items(purchase_order_id,product_id,ordered_quantity,unit_cost) VALUES($1,$2,7,10.01) RETURNING id`, [order.rows[0].id, product.rows[0].id]);

    const c = calculateReceiptCost({ quantity: 7, netUnitPrice: 10.01, taxRatePct: 27, ancillaryCostTotal: 1.00 });
    assert.equal(c.netTotal, 70.07);
    assert.equal(c.taxTotal, 18.92);
    assert.equal(c.grossTotal, 88.99);
    assert.equal(c.landedTotal, 89.99);
    assert.equal(c.landedUnitCost, 12.8557);

    const inserted = await client.query(`
      INSERT INTO procurement_receipt_costs(
        purchase_order_id,purchase_order_item_id,product_id,received_quantity,
        net_unit_price,tax_rate_pct,ancillary_cost_total,net_total,tax_total,gross_total,
        landed_total,landed_unit_cost,document_number,received_by,cost_components
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)
      RETURNING *`, [
        order.rows[0].id,item.rows[0].id,product.rows[0].id,c.quantity,c.netUnitPrice,c.taxRatePct,
        c.ancillaryCostTotal,c.netTotal,c.taxTotal,c.grossTotal,c.landedTotal,c.landedUnitCost,
        'INV-EVIDENCE-001','ci',JSON.stringify({net_unit_price:c.netUnitPrice,tax_rate_pct:c.taxRatePct,ancillary_cost_total:c.ancillaryCostTotal})
      ]);

    const row = inserted.rows[0];
    const reconstructedGross = Number(row.net_total) + Number(row.tax_total);
    const reconstructedLanded = reconstructedGross + Number(row.ancillary_cost_total);
    const reconstructedUnit = reconstructedLanded / Number(row.received_quantity);
    assert.ok(Math.abs(Number(row.gross_total) - reconstructedGross) <= 0.01);
    assert.ok(Math.abs(Number(row.landed_total) - reconstructedLanded) <= 0.01);
    assert.ok(Math.abs(Number(row.landed_unit_cost) - reconstructedUnit) <= 0.01);
    assert.equal(row.document_number, 'INV-EVIDENCE-001');
    assert.deepEqual(row.cost_components, { net_unit_price: 10.01, tax_rate_pct: 27, ancillary_cost_total: 1 });

    assert.throws(() => calculateReceiptCost({ quantity: 1, netUnitPrice: 10, taxRatePct: 101 }), /adókulcs/);
    assert.throws(() => calculateReceiptCost({ quantity: 1, netUnitPrice: 10, ancillaryCostTotal: -1 }), /járulékos/);

    console.log('PROCUREMENT_RECEIPT_COST_EVIDENCE_OK');
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
