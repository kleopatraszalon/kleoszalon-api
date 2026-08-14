const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('PostgreSQL sessions use Budapest business time for cashier day boundaries', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src/db.ts'), 'utf8');
  assert.match(source, /PG_TIMEZONE/);
  assert.match(source, /Europe\/Budapest/);
  assert.match(source, /set_config\('TimeZone', \$1, false\)/);
});

test('cashier totals are date-based and therefore covered by the pinned DB timezone', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src/routes/cashierShift.ts'), 'utf8');
  assert.match(source, /wp\.paid_at::date=\$1::date/);
  assert.match(source, /financial_closed_at::date=\$1::date/);
  assert.match(source, /business_date/);
});
