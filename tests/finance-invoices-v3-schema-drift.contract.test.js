const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sql = fs.readFileSync(
  path.join(__dirname, '..', 'src/sql/20260807_FINANCE_INVOICES_V3.sql'),
  'utf8'
);

test('finance invoice V3 repairs legacy columns before indexes use them', () => {
  const alterIndex = sql.indexOf('ALTER TABLE finance_invoices');
  const purchaseColumnIndex = sql.indexOf('ADD COLUMN IF NOT EXISTS purchase_order_id text', alterIndex);
  const purchaseIndexIndex = sql.indexOf('CREATE INDEX IF NOT EXISTS finance_invoices_purchase_order_idx');

  assert.ok(alterIndex >= 0, 'legacy finance_invoices repair block must exist');
  assert.ok(purchaseColumnIndex > alterIndex, 'purchase_order_id must be added in the repair block');
  assert.ok(purchaseIndexIndex > purchaseColumnIndex, 'purchase_order index must be created after column repair');
});

test('finance invoice V3 repairs all fields required by the canonical V3 shape', () => {
  for (const column of [
    'partner_tax_no text',
    'purchase_order_id text',
    'payment_account_id uuid',
    'payment_movement_id uuid',
    'journal_entry_id uuid',
    'approved_at timestamptz',
    'approved_by text',
    'paid_at timestamptz',
    'posted_at timestamptz',
    'cancelled_at timestamptz',
    'cancel_reason text',
    'updated_at timestamptz NOT NULL DEFAULT now()'
  ]) {
    assert.ok(sql.includes(`ADD COLUMN IF NOT EXISTS ${column}`), `missing legacy repair for ${column}`);
  }
});
