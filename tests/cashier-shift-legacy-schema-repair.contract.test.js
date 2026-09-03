const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sql = fs.readFileSync(
  path.join(__dirname, '..', 'src/sql/20260813_CASHIER_ALTEGIO_PARITY_V2.sql'),
  'utf8',
);

test('cashier parity bootstrap repairs legacy cash_register_shifts before shift/open is used', () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS cash_register_shifts/i);
  for (const column of [
    'location_name',
    'business_date',
    'opening_note',
    'current_cashier',
    'closed_by',
    'closed_at',
    'closing_id',
    'report_no',
    'close_note',
    'updated_at',
  ]) {
    assert.match(sql, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}\\b`, 'i'));
  }
  assert.match(sql, /SET business_date\s*=\s*COALESCE\(business_date,\s*opened_at::date,\s*CURRENT_DATE\)/i);
  assert.match(sql, /SET current_cashier\s*=\s*COALESCE\(NULLIF\(current_cashier,''\),\s*NULLIF\(opened_by,''\),\s*'legacy'\)/i);
});
