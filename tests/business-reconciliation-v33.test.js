'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=p=>fs.readFileSync(path.join(process.cwd(),p),'utf8');

test('financial reconciliation covers the complete business chain',()=>{
 const src=read('src/services/businessReconciliation.ts');
 for(const marker of ['work_orders','work_order_settlements','work_order_payments','financial_movement_id','cashier_shift_id','finance_invoices','nav_invoice_queue','accounting_journal_entries','accounting_journal_lines'])assert.match(src,new RegExp(marker));
 for(const issue of ['settlement_missing','payment_amount_mismatch','financial_ledger_missing','cashier_link_missing','invoice_not_issued','nav_not_completed','accounting_not_reconciled'])assert.match(src,new RegExp(issue));
 assert.match(src,/discrepancy_count/);
 assert.match(src,/financial_reconciliation_items/);
});

test('stock reconciliation recomputes opening plus movements to closing stock',()=>{
 const src=read('src/services/businessReconciliation.ts');
 for(const marker of ['inventory_warehouse_balances','inventory_movements','opening','receipts','usage_qty','sales','scrap','transfer_in','transfer_out','adjustments','expected_closing','observed_closing','difference'])assert.match(src,new RegExp(marker));
 assert.match(src,/opening\+n\(r\.net_change\)/);
 assert.match(src,/Math\.abs\(n\(x\.difference\)\)>EPS/);
 assert.match(src,/stock_reconciliation_items/);
});

test('daily reconciliation is scheduled in Budapest and alerts are deduplicated globally',()=>{
 const scheduler=read('src/services/businessReconciliationScheduler.ts');
 assert.match(scheduler,/20 2 \* \* \*/);
 assert.match(scheduler,/Europe\/Budapest/);
 assert.match(scheduler,/notify:true/);
 assert.match(scheduler,/notify:false/);
 const alert=read('src/services/businessControlAlertDelivery.ts');
 assert.match(alert,/VIR üzleti kontroll/);
 assert.match(alert,/getApmAdminRecipients/);
 assert.match(alert,/business_control_alert_deliveries/);
});

test('reconciliation management API is mounted behind management access',()=>{
 const notifications=read('src/routes/notifications.ts');
 const route=read('src/routes/businessReconciliation.ts');
 assert.match(notifications,/router\.use\("\/reconciliation",requireManagement,businessReconciliationRouter\)/);
 for(const endpoint of ['/finance','/stock','/run','/history','/alerts/deliveries'])assert.ok(route.includes(`"${endpoint}"`));
});
