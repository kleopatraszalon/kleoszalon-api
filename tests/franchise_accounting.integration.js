const assert=require('node:assert/strict');
const {pool}=require('../dist/db');
const q=(sql,params=[])=>pool.query(sql,params);

async function main(){
  const tenant=(await q(`INSERT INTO tenants(name) VALUES('Franchise CI tenant') RETURNING id`)).rows[0];
  const location=(await q(`INSERT INTO locations(tenant_id,name) VALUES($1,'Franchise CI salon') RETURNING id`,[tenant.id])).rows[0];
  const network=(await q(`INSERT INTO franchise_networks(tenant_id,name) VALUES($1,'CI Network') RETURNING id`,[tenant.id])).rows[0];
  const member=(await q(`INSERT INTO franchise_members(tenant_id,franchise_network_id,location_id,member_type,active) VALUES($1,$2,$3,'franchise',true) RETURNING id`,[tenant.id,network.id,String(location.id)])).rows[0];
  const workOrderId=(await q(`SELECT gen_random_uuid() id`)).rows[0].id;

  const draft=(await q(`INSERT INTO finance_invoices(location_id,direction,invoice_no,document_kind,work_order_id,currency,net_total,vat_total,gross_total,status) VALUES($1,'outgoing','DRAFT-1','internal_draft',$2,'HUF',10000,2700,12700,'draft') RETURNING id`,[String(location.id),workOrderId])).rows[0];
  assert.equal(Number((await q(`SELECT COUNT(*)::int n FROM franchise_revenue_entries WHERE source_id=$1`,[String(draft.id)])).rows[0].n),0,'draft must not create franchise revenue');

  const issued=(await q(`INSERT INTO finance_invoices(location_id,direction,invoice_no,document_kind,issued_at,work_order_id,currency,net_total,vat_total,gross_total,status) VALUES($1,'outgoing','INV-1','tax_invoice',now(),$2,'HUF',10000,2700,12700,'issued') RETURNING id`,[String(location.id),workOrderId])).rows[0];
  const revenue=(await q(`SELECT * FROM franchise_revenue_entries WHERE source_type='workorder_invoice' AND source_id=$1`,[String(issued.id)])).rows[0];
  assert.ok(revenue,'issued work-order invoice must create franchise revenue');
  assert.equal(Number(revenue.net_revenue),10000);
  assert.equal(String(revenue.franchise_member_id),String(member.id));

  await q(`UPDATE finance_invoices SET status='issued' WHERE id=$1`,[issued.id]);
  assert.equal(Number((await q(`SELECT COUNT(*)::int n FROM franchise_revenue_entries WHERE source_type='workorder_invoice' AND source_id=$1`,[String(issued.id)])).rows[0].n),1,'invoice trigger must be idempotent');

  const franchiseDoc=(await q(`INSERT INTO finance_invoices(location_id,direction,invoice_no,document_kind,issued_at,work_order_id,currency,net_total,vat_total,gross_total,status,franchise_settlement_id) VALUES($1,'outgoing','FR-INV-1','tax_invoice',now(),$2,'HUF',5000,1350,6350,'issued',999) RETURNING id`,[String(location.id),workOrderId])).rows[0];
  assert.equal(Number((await q(`SELECT COUNT(*)::int n FROM franchise_revenue_entries WHERE source_id=$1`,[String(franchiseDoc.id)])).rows[0].n),0,'franchise billing invoice must not recursively become royalty revenue');

  const settlement=(await q(`INSERT INTO franchise_settlements(tenant_id,franchise_network_id,franchise_member_id,location_id,period_start,period_end,currency,royalty_amount,marketing_fee_amount,total_due,status) VALUES($1,$2,$3,$4,CURRENT_DATE,CURRENT_DATE,'HUF',500,100,600,'approved') RETURNING id`,[tenant.id,network.id,member.id,String(location.id)])).rows[0];
  const receivable=(await q(`INSERT INTO franchise_receivables(tenant_id,settlement_id,franchise_member_id,period_start,period_end,currency,royalty_amount,marketing_fee_amount,net_amount,due_date,status) VALUES($1,$2,$3,CURRENT_DATE,CURRENT_DATE,'HUF',500,100,600,CURRENT_DATE+7,'posted') RETURNING id`,[tenant.id,settlement.id,member.id])).rows[0];
  await q(`UPDATE franchise_settlements SET status='paid' WHERE id=$1`,[settlement.id]);
  assert.equal((await q(`SELECT status FROM franchise_receivables WHERE id=$1`,[receivable.id])).rows[0].status,'paid','paid settlement must synchronize receivable');

  console.log('FRANCHISE ACCOUNTING INTEGRATION: PASS');
  await pool.end();
}
main().catch(async error=>{console.error('FRANCHISE ACCOUNTING INTEGRATION: FAIL',error);try{await pool.end()}catch{}process.exit(1)});
