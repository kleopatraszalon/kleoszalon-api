const assert=require('node:assert/strict');
const express=require('express');
const jwt=require('jsonwebtoken');
const {pool}=require('../dist/db');
const workOrderEditor=require('../dist/routes/workOrderEditor').default;
const cashier=require('../dist/routes/cashier').default;
const finalization=require('../dist/routes/workOrderFinalization').default;
const materials=require('../dist/routes/workOrderMaterials').default;
const centralSupply=require('../dist/routes/centralSupply').default;
const purchaseOrders=require('../dist/routes/purchaseOrders').default;
const {requireAuth}=require('../dist/middleware/auth');
const {ensureWorkOrderWorkflow}=require('../dist/workorders/ensureWorkOrderWorkflow');

const secret=process.env.JWT_SECRET||'stage10_secret';
const token=(payload)=>jwt.sign(payload,secret,{expiresIn:'1h'});
const auth=(t)=>({Authorization:`Bearer ${t}`,'Content-Type':'application/json'});
async function request(base,path,opts={}){const r=await fetch(base+path,opts);let body=null;try{body=await r.json()}catch{body=await r.text()}return{status:r.status,body};}
async function q(sql,params=[]){return pool.query(sql,params)}

async function main(){
 await ensureWorkOrderWorkflow(pool);
 const seeded=await q(`
  WITH l AS (INSERT INTO locations(name,city,address) VALUES('Stage10 Szalon','Eger','Készlet teszt 1') RETURNING id),
       e AS (INSERT INTO employees(full_name,email,location_id) SELECT 'Stage10 Munkatárs','stage10.employee@test.local',id FROM l RETURNING id,location_id),
       c AS (INSERT INTO clients(name,full_name,email,phone,location_id) SELECT 'Stage10 Vendég','Stage10 Vendég','stage10.customer@test.local','+36200000000',id FROM l RETURNING id,location_id),
       p1 AS (INSERT INTO products(name,retail_price_gross) VALUES('Stage10 központból tölthető anyag',1000) RETURNING id),
       p2 AS (INSERT INTO products(name,retail_price_gross) VALUES('Stage10 beszerzendő anyag',500) RETURNING id),
       b1 AS (INSERT INTO product_stock_balances(product_id,location_id,quantity,unit_cost,min_quantity) SELECT p1.id,l.id,6,100,5 FROM p1,l),
       b2 AS (INSERT INTO product_stock_balances(product_id,location_id,quantity,unit_cost,min_quantity) SELECT p2.id,l.id,3,60,2 FROM p2,l),
       bc1 AS (INSERT INTO product_stock_balances(product_id,location_id,quantity,unit_cost,min_quantity) SELECT p1.id,NULL,20,80,0 FROM p1),
       bc2 AS (INSERT INTO product_stock_balances(product_id,location_id,quantity,unit_cost,min_quantity) SELECT p2.id,NULL,0,55,0 FROM p2),
       sup AS (INSERT INTO suppliers(name) VALUES('Stage10 Teszt Beszállító') RETURNING id),
       term AS (INSERT INTO product_supplier_terms(product_id,supplier_id,unit_price,minimum_order_quantity,lead_time_days,preferred) SELECT p2.id,sup.id,55,5,4,true FROM p2,sup)
  SELECT l.id location_id,e.id employee_id,c.id client_id,p1.id product1_id,p2.id product2_id FROM l,e,c,p1,p2
 `);
 const d=seeded.rows[0];
 const admin=token({id:901,email:'stage10.admin@test.local',role:'admin',location_id:d.location_id});

 const app=express();app.use(express.json());
 app.use('/materials',materials);
 app.use('/editor',workOrderEditor);
 app.use('/cashier',cashier);
 app.use('/finalization',finalization);
 app.use('/supply',requireAuth,centralSupply);
 app.use('/procurement',requireAuth,purchaseOrders);
 app.use((err,_req,res,_next)=>{console.error('stage10 route error',err);res.status(500).json({message:err?.message||String(err),code:err?.code||null})});
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s))});
 const port=server.address().port,base=`http://127.0.0.1:${port}`;
 try{
  // Initialize canonical material/replenishment schema and the AFTER INSERT trigger.
  let r=await request(base,`/materials/replenishment-requests?location_id=${d.location_id}`,{headers:auth(admin)});
  assert.equal(r.status,200,`materials init: ${JSON.stringify(r.body)}`);

  // 1) Work order consumes 2 from 6. Remaining 4 <= min 5 => automatic request of 6 (target 10).
  r=await request(base,'/editor/create',{method:'POST',headers:auth(admin),body:JSON.stringify({location_id:d.location_id,employee_id:d.employee_id,client_id:d.client_id,status:'in_progress',title:'Stage10 auto replenishment #1',products:[{product_id:d.product1_id,quantity:2}]})});
  assert.equal(r.status,201,`create #1: ${JSON.stringify(r.body)}`);const w1=r.body.id;
  r=await request(base,`/cashier/workorders/${w1}/settle`,{method:'POST',headers:auth(admin),body:JSON.stringify({payments:[{payment_method:'cash',amount:2000}],close_financially:true})});assert.equal(r.status,200,`settle #1: ${JSON.stringify(r.body)}`);
  r=await request(base,`/finalization/workorders/${w1}/finalize`,{method:'POST',headers:auth(admin),body:'{}'});assert.equal(r.status,200,`finalize #1: ${JSON.stringify(r.body)}`);
  let bal=(await q(`SELECT quantity FROM product_stock_balances WHERE product_id=$1 AND location_id=$2`,[d.product1_id,d.location_id])).rows[0];assert.equal(Number(bal.quantity),4);
  let req1=(await q(`SELECT * FROM salon_stock_requests WHERE location_id=$1 AND product_id=$2`,[d.location_id,d.product1_id])).rows[0];assert.ok(req1,'automatic salon_stock_request missing');assert.equal(req1.source,'workorder_auto');assert.equal(String(req1.source_work_order_id),String(w1));assert.equal(Number(req1.requested_quantity),6);assert.equal(req1.status,'requested');

  // 2) Another consumption while request is still open must not duplicate it.
  // It also drives product2 to its minimum, creating a second canonical request whose central stock is zero.
  r=await request(base,'/editor/create',{method:'POST',headers:auth(admin),body:JSON.stringify({location_id:d.location_id,employee_id:d.employee_id,client_id:d.client_id,status:'in_progress',title:'Stage10 dedupe + procurement fallback',products:[{product_id:d.product1_id,quantity:1},{product_id:d.product2_id,quantity:1}]})});
  assert.equal(r.status,201,`create #2: ${JSON.stringify(r.body)}`);const w2=r.body.id;
  r=await request(base,`/cashier/workorders/${w2}/settle`,{method:'POST',headers:auth(admin),body:JSON.stringify({payments:[{payment_method:'card',amount:1500}],close_financially:true})});assert.equal(r.status,200,`settle #2: ${JSON.stringify(r.body)}`);
  r=await request(base,`/finalization/workorders/${w2}/finalize`,{method:'POST',headers:auth(admin),body:'{}'});assert.equal(r.status,200,`finalize #2: ${JSON.stringify(r.body)}`);
  assert.equal(Number((await q(`SELECT count(*) n FROM salon_stock_requests WHERE location_id=$1 AND product_id=$2 AND status IN('requested','approved','partially_supplied')`,[d.location_id,d.product1_id])).rows[0].n),1,'duplicate open request created');
  const req2=(await q(`SELECT * FROM salon_stock_requests WHERE location_id=$1 AND product_id=$2`,[d.location_id,d.product2_id])).rows[0];assert.ok(req2);assert.equal(req2.source,'workorder_auto');assert.equal(Number(req2.requested_quantity),2);

  // 3) Approve product1 request, allocate from central warehouse, dispatch, receive with shortage.
  r=await request(base,`/supply/requests/${req1.id}/approve`,{method:'POST',headers:auth(admin),body:JSON.stringify({approved_quantity:6})});assert.equal(r.status,200,`approve #1: ${JSON.stringify(r.body)}`);
  r=await request(base,`/supply/requests/${req1.id}/allocate`,{method:'POST',headers:auth(admin),body:'{}'});assert.equal(r.status,201,`allocate #1: ${JSON.stringify(r.body)}`);const t1=r.body.id;assert.ok(r.body.source_warehouse_id);assert.ok(r.body.destination_warehouse_id);
  r=await request(base,`/supply/transfers/${t1}/dispatch`,{method:'POST',headers:auth(admin),body:'{}'});assert.equal(r.status,200,`dispatch #1: ${JSON.stringify(r.body)}`);
  let central=(await q(`SELECT quantity FROM product_stock_balances WHERE product_id=$1 AND location_id IS NULL`,[d.product1_id])).rows[0];assert.equal(Number(central.quantity),14);
  let ledger=(await q(`SELECT warehouse_id,destination_warehouse_id,document_number,quantity FROM inventory_movements WHERE document_number=$1 AND movement_type='transfer_out'`,[`CS-${t1}`])).rows[0];assert.ok(ledger?.warehouse_id);assert.ok(ledger?.destination_warehouse_id);assert.equal(Number(ledger.quantity),-6);
  r=await request(base,`/supply/transfers/${t1}/receive`,{method:'POST',headers:auth(admin),body:JSON.stringify({received_quantity:5,note:'Stage10 shortage test'})});assert.equal(r.status,200,`receive partial #1: ${JSON.stringify(r.body)}`);assert.equal(Number(r.body.shortage),1);
  req1=(await q(`SELECT * FROM salon_stock_requests WHERE id=$1`,[req1.id])).rows[0];assert.equal(req1.status,'partially_supplied');assert.equal(Number(req1.supplied_quantity),5);
  assert.equal(Number((await q(`SELECT count(*) n FROM stock_transfer_discrepancies WHERE transfer_id=$1 AND status='open'`,[t1])).rows[0].n),1);
  ledger=(await q(`SELECT warehouse_id,document_number,quantity FROM inventory_movements WHERE document_number=$1 AND movement_type='transfer_in'`,[`CS-${t1}`])).rows[0];assert.ok(ledger?.warehouse_id);assert.equal(Number(ledger.quantity),5);

  // 4) Allocate and receive the remaining 1; request must become supplied and salon balance must be 9.
  r=await request(base,`/supply/requests/${req1.id}/allocate`,{method:'POST',headers:auth(admin),body:'{}'});assert.equal(r.status,201,`allocate remaining: ${JSON.stringify(r.body)}`);const t2=r.body.id;
  r=await request(base,`/supply/transfers/${t2}/dispatch`,{method:'POST',headers:auth(admin),body:'{}'});assert.equal(r.status,200);
  r=await request(base,`/supply/transfers/${t2}/receive`,{method:'POST',headers:auth(admin),body:JSON.stringify({received_quantity:1})});assert.equal(r.status,200);
  req1=(await q(`SELECT * FROM salon_stock_requests WHERE id=$1`,[req1.id])).rows[0];assert.equal(req1.status,'supplied');assert.equal(Number(req1.supplied_quantity),6);
  bal=(await q(`SELECT quantity FROM product_stock_balances WHERE product_id=$1 AND location_id=$2`,[d.product1_id,d.location_id])).rows[0];assert.equal(Number(bal.quantity),9);

  // 5) Product2 has no central stock. Allocation must explicitly fall back to procurement,
  // and the preferred supplier must produce a draft central purchase order.
  r=await request(base,`/supply/requests/${req2.id}/approve`,{method:'POST',headers:auth(admin),body:JSON.stringify({approved_quantity:2})});assert.equal(r.status,200);
  r=await request(base,`/supply/requests/${req2.id}/allocate`,{method:'POST',headers:auth(admin),body:'{}'});assert.equal(r.status,409);assert.equal(r.body.can_procure,true);assert.equal(Number(r.body.missing),2);
  r=await request(base,`/supply/requests/${req2.id}/procure`,{method:'POST',headers:auth(admin),body:'{}'});assert.equal(r.status,201,`procure #2: ${JSON.stringify(r.body)}`);assert.ok(r.body.purchase_order?.id);assert.equal(Number(r.body.missing_quantity),2);assert.equal(Number(r.body.ordered_quantity),5,'minimum supplier order quantity must be respected');
  const po=(await q(`SELECT po.*,poi.id item_id,poi.ordered_quantity,poi.product_id FROM purchase_orders po JOIN purchase_order_items poi ON poi.purchase_order_id=po.id WHERE po.id=$1`,[r.body.purchase_order.id])).rows[0];assert.equal(po.status,'draft');assert.equal(po.approval_status,'not_requested');assert.equal(String(po.product_id),String(d.product2_id));assert.equal(Number(po.ordered_quantity),5);
  const linked=(await q(`SELECT purchase_order_id FROM salon_stock_requests WHERE id=$1`,[req2.id])).rows[0];assert.equal(Number(linked.purchase_order_id),Number(po.id));

  // 6) Supplier receipt must enter a concrete central warehouse and keep the legacy aggregate synchronized.
  await q(`UPDATE purchase_orders SET approval_status='approved',status='ordered',ordered_at=now(),updated_at=now() WHERE id=$1`,[po.id]);
  r=await request(base,`/procurement/orders/${po.id}/receive`,{method:'POST',headers:auth(admin),body:JSON.stringify({items:[{item_id:po.item_id,received_quantity:5,unit_cost:55}]})});assert.equal(r.status,200,`PO receive: ${JSON.stringify(r.body)}`);assert.equal(r.body.status,'received');assert.ok(r.body.receipts?.[0]?.warehouse_id);
  central=(await q(`SELECT quantity FROM product_stock_balances WHERE product_id=$1 AND location_id IS NULL`,[d.product2_id])).rows[0];assert.equal(Number(central.quantity),5);
  const warehouseCentral=(await q(`SELECT COALESCE(SUM(b.quantity),0)::numeric quantity FROM inventory_warehouse_balances b JOIN inventory_warehouses w ON w.id=b.warehouse_id WHERE b.product_id=$1 AND w.location_id IS NULL`,[d.product2_id])).rows[0];assert.equal(Number(warehouseCentral.quantity),5);
  const receiptMovement=(await q(`SELECT warehouse_id,supplier_id,document_number,quantity FROM inventory_movements WHERE product_id=$1 AND movement_type='receipt' AND document_number=$2 ORDER BY id DESC LIMIT 1`,[d.product2_id,`PO-${po.id}`])).rows[0];assert.ok(receiptMovement?.warehouse_id);assert.ok(receiptMovement?.supplier_id);assert.equal(Number(receiptMovement.quantity),5);

  console.log('STAGE10 CENTRAL SUPPLY INTEGRATION: PASS');
 }finally{await new Promise(resolve=>server.close(resolve));await pool.end()}
}
main().catch(async e=>{console.error('STAGE10 CENTRAL SUPPLY INTEGRATION: FAIL',e);try{await pool.end()}catch{}process.exit(1)});
