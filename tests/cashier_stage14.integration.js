const assert=require('node:assert/strict');
const express=require('express');
const {pool}=require('../dist/db');
const cashierShift=require('../dist/routes/cashierShift').default;
const parity=require('../dist/routes/cashierAltegioParity').default;

async function q(sql,params=[]){return pool.query(sql,params)}
async function req(base,path,opts={}){const r=await fetch(base+path,opts);let body;try{body=await r.json()}catch{body=await r.text()}return{status:r.status,body}}
let requestNumber=0;
const json=(body)=>({method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':`stage14-${++requestNumber}`},body:JSON.stringify(body)});

async function main(){
 const seeded=await q(`
  WITH l AS (INSERT INTO locations(name,city,address) VALUES('Stage14 Szalon','Budapest','Teszt utca 14') RETURNING id),
       wo AS (INSERT INTO work_orders(title,status,location_id,gross_total,discount_amount,tip_amount,amount_due,amount_paid,payment_status,fully_paid,created_at,updated_at)
              SELECT 'Stage14 pénztár teszt','in_progress',id,3500,0,0,3500,0,'unpaid',false,now(),now() FROM l RETURNING id,location_id),
       ca AS (INSERT INTO financial_accounts(location_id,name,account_type,currency,opening_balance,active,note)
              SELECT id,'Stage14 Készpénz','cash','HUF',0,true,'integration' FROM l RETURNING id,location_id),
       ba AS (INSERT INTO financial_accounts(location_id,name,account_type,currency,opening_balance,active,note)
              SELECT id,'Stage14 Bank','bank','HUF',0,true,'integration' FROM l RETURNING id,location_id)
  SELECT l.id location_id,wo.id work_order_id,ca.id cash_account_id,ba.id bank_account_id FROM l,wo,ca,ba
 `);
 const d=seeded.rows[0],loc=String(d.location_id),wid=String(d.work_order_id),cash=String(d.cash_account_id),bank=String(d.bank_account_id);
 await q(`INSERT INTO finance_payment_methods(location_id,code,name,method_type,account_id,fee_percent,sort_order) VALUES($1,'vipcard','VIP bankkártya','card',$2::uuid,1.5,15) ON CONFLICT DO NOTHING`,[loc,bank]);
 await q(`INSERT INTO finance_document_types(location_id,code,name,direction,group_key,system,active) VALUES($1,'cash_in','Kasszabevét','income','cash',true,true),($1,'cash_out','Kasszakivét','expense','cash',true,true)`,[loc]);
 await q(`INSERT INTO finance_partners(location_id,partner_type,name,active) VALUES($1,'company','Stage14 Partner',true)`,[loc]);
 const partner=String((await q(`SELECT id FROM finance_partners WHERE location_id=$1 ORDER BY id DESC LIMIT 1`,[loc])).rows[0].id);

 const app=express();app.use(express.json());
 app.use((r,_s,n)=>{r.user={id:'stage14-admin',email:'stage14@test.local',role:'admin',location_id:loc};n()});
 app.use('/cashier',cashierShift);
 app.use('/cashier',parity);
 app.post('/cashier/workorders/:id/settle',async(r,s,n)=>{try{for(const p of r.body.payments||[])await q(`INSERT INTO work_order_payments(work_order_id,payment_method,amount,note) VALUES($1::uuid,$2,$3,$4)`,[r.params.id,p.payment_method,p.amount,p.note||null]);const paid=Number((await q(`SELECT COALESCE(SUM(amount-refunded_amount),0) paid FROM work_order_payments WHERE work_order_id=$1::uuid`,[r.params.id])).rows[0].paid);await q(`UPDATE work_orders SET amount_paid=$2,payment_status=CASE WHEN $2>=amount_due THEN 'paid' WHEN $2>0 THEN 'partial' ELSE 'unpaid' END WHERE id=$1::uuid`,[r.params.id,paid]);s.json({ok:true,amount_paid:paid})}catch(e){n(e)}});
 app.use((e,_r,s,_n)=>{console.error('stage14 integration route error',e);s.status(500).json({message:e?.message||String(e),code:e?.code||null})});
 const server=await new Promise(resolve=>{const x=app.listen(0,'127.0.0.1',()=>resolve(x))});
 const base=`http://127.0.0.1:${server.address().port}`;
 try{
  const day=new Date().toISOString().slice(0,10);
  let r=await req(base,'/cashier/shift/open',json({location_id:loc,location_name:'Stage14 Szalon',business_date:day,opening_cash:10000,opening_note:'Stage14 integration'}));
  assert.equal(r.status,201,`open: ${JSON.stringify(r.body)}`);const shiftId=r.body.id;assert.ok(shiftId);

  r=await req(base,`/cashier/shift/${shiftId}/count`,json({location_id:loc,count_type:'opening',denominations:{5000:2},note:'Nyitó címletszámolás'}));
  assert.equal(r.status,201,`opening count: ${JSON.stringify(r.body)}`);assert.equal(Number(r.body.counted_cash),10000);assert.equal(Number(r.body.expected_cash),10000);assert.equal(Number(r.body.difference),0);

  r=await req(base,'/cashier/manual-operation',json({location_id:loc,account_id:cash,direction:'income',amount:1000,document_type_code:'cash_in',partner_id:partner,employee_id:'EMP-14',reference_no:'BE-14',note:'Stage14 kasszabevét'}));
  assert.equal(r.status,201,`manual income: ${JSON.stringify(r.body)}`);
  r=await req(base,'/cashier/account-transfer',json({location_id:loc,source_account_id:cash,destination_account_id:bank,amount:500,reference_no:'ATV-14',note:'Kasszából bankba'}));
  assert.equal(r.status,201,`transfer: ${JSON.stringify(r.body)}`);

  r=await req(base,`/cashier/workorders/${wid}/settle`,json({location_id:loc,payments:[{payment_method:'vipcard',payment_method_code:'vipcard',amount:2000,card_brand:'VISA'},{payment_method:'cash',payment_method_code:'cash',amount:1500,finance_account_id:cash}]}));
  assert.equal(r.status,200,`settle: ${JSON.stringify(r.body)}`);
  const pays=(await q(`SELECT * FROM work_order_payments WHERE work_order_id=$1::uuid ORDER BY amount DESC`,[wid])).rows;
  assert.equal(pays.length,2);const card=pays.find(x=>x.payment_method==='card'),cashPayment=pays.find(x=>x.payment_method==='cash');assert.ok(card);assert.ok(cashPayment);
  assert.equal(card.payment_method_code,'vipcard');assert.equal(String(card.finance_account_id),bank);assert.equal(card.card_brand,'VISA');assert.equal(Number(card.fee_amount),30);assert.equal(Number(card.cashier_shift_id),Number(shiftId));
  assert.equal(cashPayment.payment_method_code,'cash');assert.equal(String(cashPayment.finance_account_id),cash);assert.equal(Number(cashPayment.cashier_shift_id),Number(shiftId));

  r=await req(base,`/cashier/shift/${shiftId}/count`,json({location_id:loc,count_type:'check',denominations:{10000:1,2000:1},note:'Fizetés utáni ellenőrzés'}));
  assert.equal(r.status,201,`pre-refund count: ${JSON.stringify(r.body)}`);assert.equal(Number(r.body.expected_cash),12000);assert.equal(Number(r.body.difference),0);

  r=await req(base,`/cashier/payments/${cashPayment.id}/refund`,json({location_id:loc,amount:500,reason:'Stage14 részleges készpénz refund',finance_account_id:cash}));
  assert.equal(r.status,201,`refund: ${JSON.stringify(r.body)}`);assert.equal(Number(r.body.amount_paid),3000);assert.equal(r.body.payment_status,'partial');
  const refunded=(await q(`SELECT COALESCE(SUM(amount),0) refunded_amount FROM work_order_payment_refunds WHERE payment_id=$1`,[cashPayment.id])).rows[0];assert.equal(Number(refunded.refunded_amount),500);
  assert.equal(Number((await q(`SELECT COALESCE(SUM(amount),0) n FROM cash_register_movements WHERE cashier_shift_id=$1 AND reason_code='refund' AND direction='out' AND voided_at IS NULL`,[shiftId])).rows[0].n),500);

  r=await req(base,`/cashier/shift/${shiftId}/count`,json({location_id:loc,count_type:'check',denominations:{10000:1,1000:1,500:1},note:'Refund utáni ellenőrzés'}));
  assert.equal(r.status,201,`post-refund count: ${JSON.stringify(r.body)}`);assert.equal(Number(r.body.expected_cash),11500,'cash refund must reduce drawer exactly once');assert.equal(Number(r.body.counted_cash),11500);assert.equal(Number(r.body.difference),0);

  r=await req(base,`/cashier/workorders/${wid}/payments`);assert.equal(r.status,200);assert.equal(r.body.length,2);const cashHistory=r.body.find(x=>x.payment_method==='cash');assert.equal(Number(cashHistory.effective_refunded_amount),500);assert.equal(cashHistory.refunds.length,1);

  r=await req(base,`/cashier/shift/${shiftId}/close`,json({location_id:loc,counted_cash:11500,note:'Stage14 integrációs zárás'}));
  assert.equal(r.status,201,`close: ${JSON.stringify(r.body)}`);assert.equal(Number(r.body.report.expected_cash),11500);assert.equal(Number(r.body.report.difference),0);assert.ok(r.body.report.report_no);
  console.log('CASHIER STAGE14 INTEGRATION: PASS');
 }finally{await new Promise(resolve=>server.close(resolve));await pool.end()}
}
main().catch(async e=>{console.error('CASHIER STAGE14 INTEGRATION: FAIL',e);try{await pool.end()}catch{}process.exit(1)});
