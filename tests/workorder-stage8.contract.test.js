const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const scoped = read('src/routes/workordersScoped.ts');
const financeScope = read('src/middleware/workOrderFinanceScope.ts');
const finalization = read('src/routes/workOrderFinalization.ts');
const loyaltyCashier = read('src/routes/loyaltyCashier.ts');
const cashier = read('src/routes/cashier.ts');
const editor = read('src/routes/workOrderEditor.ts');

test('RBAC: admin, recepciós és üzletvezető szerkeszthet', () => {
  assert.match(scoped, /ADMIN=.*admin/i);
  assert.match(scoped, /RECEPTION=.*receptionist/i);
  assert.match(scoped, /BUSINESS_MANAGER=.*location_manager/i);
  assert.match(scoped, /canEdit:true/);
});

test('RBAC: szalonvezető, munkatárs és ügyfél read-only', () => {
  assert.match(scoped, /SALON_MANAGER/);
  assert.match(scoped, /STAFF/);
  assert.match(scoped, /CUSTOMER/);
  assert.match(scoped, /roleLabel:'salon_manager'/);
  assert.match(scoped, /roleLabel:'employee'/);
  assert.match(scoped, /roleLabel:'customer'/);
});

test('Pénzügyi scope csak admin/recepciós/üzletvezető', () => {
  assert.match(financeScope, /Pénzügyi munkalapműveletet csak adminisztrátor, recepciós vagy üzletvezető/);
  assert.match(financeScope, /location_id/);
});

test('Telephely-scope másik szalon munkalapját elrejti', () => {
  assert.match(financeScope, /A munkalap nem ehhez a szalonhoz tartozik/);
  assert.match(scoped, /location_id=\$1::uuid/);
});

test('Érvénytelen munkalap UUID 400-ra fordul', () => {
  assert.match(scoped, /22P02/);
  assert.match(scoped, /status\(400\)/);
});

test('Lezárt/archivált munkalap nem szerkeszthető', () => {
  assert.match(scoped, /locked_at\|\|row\.archived_at/);
  assert.match(scoped, /error:'locked'/);
});

test('Véglegesítés csak in_progress és teljesen kifizetett munkalapon', () => {
  assert.match(finalization, /status\|\|''\)!=='in_progress'/);
  assert.match(finalization, /payment_status\|\|''\)!=='paid'/);
  assert.match(finalization, /financial_closed_at/);
});

test('Véglegesítés készletet fogyaszt és készletmozgást rögzít', () => {
  assert.match(finalization, /consumeStock/);
  assert.match(finalization, /inventory_movements/);
  assert.match(finalization, /work_order_consumption/);
});

test('Véglegesítés jutalékalapot és számlatervezetet készít', () => {
  assert.match(finalization, /work_order_commission_events/);
  assert.match(finalization, /ensureInvoiceDraft/);
  assert.match(finalization, /finance_invoices/);
});

test('Véglegesítés completed dokumentumállapotot és időpontállapotot állít', () => {
  assert.match(finalization, /document_status='completed'/);
  assert.match(finalization, /closed_at/);
  assert.match(finalization, /appointments/);
  assert.match(finalization, /status='completed'/);
});

test('Loyalty cashier kezeli a kevert loyalty + normál fizetést', () => {
  assert.match(loyaltyCashier, /coupon_code/);
  assert.match(loyaltyCashier, /wallet_amount/);
  assert.match(loyaltyCashier, /voucher_code/);
  assert.match(loyaltyCashier, /pass_usages/);
  assert.match(loyaltyCashier, /normalPayments/);
});

test('Pénztár és editor több fizetési sort kezel', () => {
  assert.match(cashier, /payments/);
  assert.match(editor, /payments/);
  assert.match(editor, /work_order_payments/);
});
