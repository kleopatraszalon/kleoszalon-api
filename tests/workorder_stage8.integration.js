const assert=require('node:assert/strict');
const express=require('express');
const jwt=require('jsonwebtoken');
const {pool}=require('../dist/db');
const workOrderEditor=require('../dist/routes/workOrderEditor').default;
const cashier=require('../dist/routes/cashier').default;
const finalization=require('../dist/routes/workOrderFinalization').default;
const workorders=require('../dist/routes/workordersScoped').default;
const {ensureWorkOrderWorkflow}=require('../dist/workorders/ensureWorkOrderWorkflow');

const secret=process.env.JWT_SECRET||'stage8_secret';
const token=(payload)=>jwt.sign(payload,secret,{expiresIn:'1h'});
const auth=(t)=>({Authorization:`Bearer ${t}`,'Content-Type':'application/json'});

async function req(base,path,opts={}){
 const r=await fetch(base+path,opts);let body=null;try{body=await r.json()}catch{body=await r.text()}
 return{status:r.status,body};
}
async function q(sql,params=[]){return pool.query(sql,params)}

async function main(){
 await ensureWorkOrderWorkflow(pool);
 const seeded=await q(`
  WITH l1 AS (INSERT INTO locations(name,city,address) VALUES('Teszt Szalon A','Eger','Teszt utca 1') RETURNING id),
       l2 AS (INSERT INTO locations(name,city,address) VALUES('Teszt Szalon B','Gyöngyös','Teszt utca 2') RETURNING id),
       e AS (INSERT INTO employees(full_name,email,location_id) SELECT 'Teszt Munkatárs','employee@test.local',id FROM l1 RETURNING id,location_id),
       c AS (INSERT INTO clients(name,full_name,email,phone,location_id) SELECT 'Teszt Vendég','Teszt Vendég','customer@test.local','+361111111',id FROM l1 RETURNING id,location_id),
       s AS (INSERT INTO services(name,base_price,list_price,duration_minutes) VALUES('Teszt szolgáltatás',10000,10000,45) RETURNING id),
       p AS (INSERT INTO products(name,retail_price_gross) VALUES('Teszt anyag',1000) RETURNING id),
       sl AS (INSERT INTO service_locations(service_id,location_id) SELECT s.id,l1.id FROM s,l1),
       eo AS (INSERT INTO employee_service_overrides(employee_id,service_id,custom_price,custom_duration_minutes) SELECT e.id,s.id,10000,45 FROM e,s),
       ps AS (INSERT INTO product_stock_balances(product_id,location_id,quantity) SELECT p.id,l1.id,10 FROM p,l1),
       a AS (INSERT INTO appointments(location_id,employee_id,client_id,title,start_time,end_time,status) SELECT l1.id,e.id,c.id,'Integrációs időpont',now(),now()+interval '45 min','booked' FROM l1,e,c RETURNING id)
  SELECT l1.id loc1,l2.id loc2,e.id employee,c.id customer,s.id service,p.id product,a.id appointment FROM l1,l2,e,c,s,p,a
 `);
 const d=seeded.rows[0];
 const admin=token({id:1,email:'admin@test.local',role:'admin',location_id:d.loc1});
 const receptionA=token({id:2,email:'reception.a@test.local',role:'receptionist',location_id:d.loc1});
 const receptionB=token({id:3,email:'reception.b@test.local',role:'receptionist',location_id:d.loc2});
 const employee=token({id:4,email:'employee@test.local',role:'employee',location_id:d.loc1});
 const customer=token({id:5,email:'customer@test.local',role:'customer',location_id:d.loc1});

 const app=express();app.use(express.json());
 app.use('/editor',workOrderEditor);app.use('/cashier',cashier);app.use('/finalization',finalization);app.use('/workorders',workorders);
 app.use((err,_req,res,_next)=>{console.error('integration route error',err);res.status(500).json({message:err?.message||String(err),code:err?.code||null})});
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s))});
 const port=server.address().port,base=`http://127.0.0.1:${port}`;
 try{
  let r=await req(base,'/editor/create',{method:'POST',headers:auth(admin),body:JSON.stringify({location_id:d.loc1,appointment_id:d.appointment,employee_id:d.employee,client_id:d.customer,status:'in_progress',title:'Stage 8 integráció',services:[{service_id:d.service,quantity:1}],products:[{product_id:d.product,quantity:2}]})});
  assert.equal(r.status,201,`work order create: ${JSON.stringify(r.body)}`);const wid=r.body.id;assert.ok(wid);assert.match(r.body.work_order_number,/^KLEO-ML-/);

  // Legacy live-DB regresszió: régi document_status érték + eltérő CHECK korábban
  // 23514 hibával megakasztotta a Finance/NAV bootstrapot. Az ensure-nek ezt
  // önjavító módon normalizálnia és a kanonikus CHECK-et visszaépítenie kell.
  await q(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='trg_work_orders_document_status_guard' AND tgrelid='work_orders'::regclass AND NOT tgisinternal) THEN ALTER TABLE work_orders DISABLE TRIGGER trg_work_orders_document_status_guard; END IF; END $$`);
  await q(`ALTER TABLE work_orders DROP CONSTRAINT IF EXISTS work_orders_document_status_chk`);
  await q(`UPDATE work_orders SET document_status='legacy_closed' WHERE id=$1`,[wid]);
  await q(`ALTER TABLE work_orders ADD CONSTRAINT legacy_work_orders_document_status_chk CHECK(document_status IN('legacy_closed','draft')) NOT VALID`);
  await q(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='trg_work_orders_document_status_guard' AND tgrelid='work_orders'::regclass AND NOT tgisinternal) THEN ALTER TABLE work_orders ENABLE TRIGGER trg_work_orders_document_status_guard; END IF; END $$`);
  await ensureWorkOrderWorkflow(pool);
  const repaired=(await q(`SELECT document_status FROM work_orders WHERE id=$1`,[wid])).rows[0];
  assert.equal(repaired.document_status,'open');
  const canonical=(await q(`SELECT convalidated FROM pg_constraint WHERE conname='work_orders_document_status_chk' AND conrelid='work_orders'::regclass`)).rows[0];
  assert.equal(canonical?.convalidated,true);
  assert.equal(Number((await q(`SELECT count(*) n FROM pg_constraint WHERE conname='legacy_work_orders_document_status_chk' AND conrelid='work_orders'::regclass`)).rows[0].n),0);

  r=await req(base,`/editor/create`,{method:'POST',headers:auth(admin),body:JSON.stringify({location_id:d.loc1,appointment_id:d.appointment,employee_id:d.employee,client_id:d.customer,status:'in_progress',title:'Duplikáció próba'})});
  assert.equal(r.status,200);assert.equal(r.body.existing,true);assert.equal(r.body.id,wid);

  r=await req(base,`/cashier/workorders/${wid}/settle`,{method:'POST',headers:auth(admin),body:JSON.stringify({payments:[{payment_method:'cash',amount:5000,note:'Stage8 cash'},{payment_method:'card',amount:7000,note:'Stage8 card'}],close_financially:true})});
  assert.equal(r.status,200,`cashier settle: ${JSON.stringify(r.body)}`);assert.equal(r.body.payment_status,'paid');assert.ok(r.body.financial_closed_at);assert.equal(Number(r.body.amount_paid),12000);

  r=await req(base,`/finalization/workorders/${wid}/finalize`,{method:'POST',headers:auth(admin),body:'{}'});
  assert.equal(r.status,200,`finalize: ${JSON.stringify(r.body)}`);assert.equal(r.body.finalized,true);assert.equal(r.body.appointment_completed,true);assert.ok(r.body.archive?.snapshot_hash);assert.ok(r.body.invoice?.id);

  const state=(await q(`SELECT status,document_status,locked_at,closed_at,closed_by,payment_status,financial_closed_at FROM work_orders WHERE id=$1`,[wid])).rows[0];
  assert.equal(state.status,'completed');assert.equal(state.document_status,'completed');assert.ok(state.locked_at);assert.ok(state.closed_at);assert.equal(state.closed_by,'admin@test.local');assert.equal(state.payment_status,'paid');assert.ok(state.financial_closed_at);
  const ap=(await q(`SELECT status,work_order_id::text FROM appointments WHERE id=$1`,[d.appointment])).rows[0];assert.equal(ap.status,'completed');assert.equal(ap.work_order_id,wid);
  const stock=(await q(`SELECT quantity FROM product_stock_balances WHERE product_id=$1 AND location_id=$2`,[d.product,d.loc1])).rows[0];assert.equal(Number(stock.quantity),8);
  assert.equal(Number((await q(`SELECT count(*) n FROM inventory_movements WHERE work_order_id=$1 AND movement_type='work_order_consumption'`,[wid])).rows[0].n),1);
  assert.equal(Number((await q(`SELECT count(*) n FROM financial_movements WHERE reference_type='work_order_payment'`,[])).rows[0].n),2);
  assert.equal(Number((await q(`SELECT count(*) n FROM work_order_commission_events WHERE work_order_id=$1`,[wid])).rows[0].n),1);
  assert.equal(Number((await q(`SELECT count(*) n FROM finance_invoices WHERE work_order_id=$1`,[wid])).rows[0].n),1);
  assert.equal(Number((await q(`SELECT count(*) n FROM work_order_archive WHERE work_order_id=$1`,[wid])).rows[0].n),1);
  assert.equal(Number((await q(`SELECT count(*) n FROM work_order_status_history WHERE work_order_id=$1 AND status_kind='document' AND to_status='completed'`,[wid])).rows[0].n),1);

  r=await req(base,`/workorders/${wid}/archive`,{headers:auth(admin)});assert.equal(r.status,200);assert.equal(r.body.terminal_status,'completed');assert.ok(r.body.snapshot_hash);
  r=await req(base,`/workorders/${wid}/lifecycle`,{method:'PATCH',headers:auth(admin),body:JSON.stringify({status:'in_progress'})});assert.equal(r.status,409);

  r=await req(base,'/workorders',{headers:auth(receptionA)});assert.equal(r.status,200);assert.equal(r.body.length,1);
  r=await req(base,'/workorders',{headers:auth(receptionB)});assert.equal(r.status,200);assert.equal(r.body.length,0);
  r=await req(base,`/workorders/${wid}`,{headers:auth(receptionB)});assert.equal(r.status,404);
  r=await req(base,`/workorders/${wid}`,{headers:auth(employee)});assert.equal(r.status,200);assert.equal(r.body.can_edit,false);
  r=await req(base,`/workorders/${wid}`,{headers:auth(customer)});assert.equal(r.status,200);assert.equal(r.body.can_edit,false);
  r=await req(base,`/workorders/not-a-uuid`,{headers:auth(admin)});assert.equal(r.status,400);

  console.log('STAGE8 INTEGRATION: PASS');
 }finally{await new Promise(resolve=>server.close(resolve));await pool.end()}
}
main().catch(async e=>{console.error('STAGE8 INTEGRATION: FAIL',e);try{await pool.end()}catch{}process.exit(1)});