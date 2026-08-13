const assert=require('node:assert/strict');
const express=require('express');
const jwt=require('jsonwebtoken');
const {pool}=require('../dist/db');
const {requireAuth}=require('../dist/middleware/auth');
const cashierShift=require('../dist/routes/cashierShift').default;

const secret=process.env.JWT_SECRET||'cashier_stage13_secret';
const token=(payload)=>jwt.sign(payload,secret,{expiresIn:'1h'});
const headers=(t)=>({Authorization:`Bearer ${t}`,'Content-Type':'application/json'});
const businessDate=new Date().toISOString().slice(0,10);

async function jsonReq(base,path,opts={}){
  const r=await fetch(base+path,opts);
  let body=null;
  try{body=await r.json()}catch{body=await r.text()}
  return{status:r.status,body,headers:r.headers};
}
async function binaryReq(base,path,opts={}){
  const r=await fetch(base+path,opts);
  const body=Buffer.from(await r.arrayBuffer());
  return{status:r.status,body,headers:r.headers};
}
async function q(sql,params=[]){return pool.query(sql,params)}
const num=(v)=>Number(v||0);

async function main(){
  const loc=(await q(`INSERT INTO locations(name,city,address) VALUES('Stage13 Teszt Szalon','Budapest','Teszt utca 13') RETURNING id`)).rows[0].id;
  const cashierA=token({id:101,email:'cashier.a@test.local',role:'receptionist',location_id:loc});
  const cashierB=token({id:102,email:'cashier.b@test.local',role:'receptionist',location_id:loc});
  const manager=token({id:103,email:'manager@test.local',role:'salon_manager',location_id:loc});

  const app=express();
  app.use(express.json());
  app.use(requireAuth);
  app.use('/cashier',cashierShift);
  app.use((err,_req,res,_next)=>{console.error('stage13 integration route error',err);res.status(500).json({message:err?.message||String(err),code:err?.code||null})});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s))});
  const port=server.address().port;
  const base=`http://127.0.0.1:${port}`;

  try{
    let r=await jsonReq(base,'/cashier/shift/open',{
      method:'POST',headers:headers(cashierA),
      body:JSON.stringify({location_id:loc,location_name:'Stage13 Teszt Szalon',business_date:businessDate,opening_cash:5000,opening_note:'Teszt nyitópénz'})
    });
    assert.equal(r.status,201,`shift open: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.status,'open');
    assert.equal(r.body.current_cashier,'cashier.a@test.local');
    assert.equal(num(r.body.opening_cash),5000);
    const shiftId=r.body.id;

    const wo=(await q(`INSERT INTO work_orders(title,status,location_id,gross_total,discount_amount,tip_amount,amount_due,amount_paid,payment_status,financial_closed_at,financial_closed_by)
      VALUES('Stage13 kasszateszt','in_progress',$1,14000,1000,500,13000,13000,'paid',$2::date + time '12:00','cashier.a@test.local') RETURNING id`,[loc,businessDate])).rows[0].id;
    await q(`INSERT INTO work_order_payments(work_order_id,payment_method,amount,paid_at,note) VALUES
      ($1,'cash',10000,$2::date + time '12:05','Stage13 készpénz'),
      ($1,'card',3000,$2::date + time '12:06','Stage13 kártya')`,[wo,businessDate]);
    await q(`INSERT INTO cash_register_movements(location_id,business_date,direction,amount,reason_code,note,created_by) VALUES
      ($1,$2::date,'in',2000,'float','Teszt kasszabevét','cashier.a@test.local'),
      ($1,$2::date,'out',500,'petty_cash','Teszt kasszakivét','cashier.a@test.local')`,[loc,businessDate]);

    r=await jsonReq(base,`/cashier/shift/current?location_id=${encodeURIComponent(loc)}&date=${businessDate}`,{headers:headers(cashierA)});
    assert.equal(r.status,200,`current shift: ${JSON.stringify(r.body)}`);
    assert.equal(num(r.body.totals.cash_sales),10000);
    assert.equal(num(r.body.totals.card_sales),3000);
    assert.equal(num(r.body.totals.cash_in),2000);
    assert.equal(num(r.body.totals.cash_out),500);
    assert.equal(num(r.body.totals.expected_cash),16500);

    r=await jsonReq(base,`/cashier/shift/${shiftId}/handover`,{
      method:'POST',headers:headers(cashierA),
      body:JSON.stringify({location_id:loc,to_cashier:'cashier.b@test.local',counted_cash:16500,note:'Műszakátadás teszt'})
    });
    assert.equal(r.status,201,`handover: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.handover.status,'pending');
    assert.equal(num(r.body.handover.difference),0);
    const handoverId=r.body.handover.id;

    r=await jsonReq(base,`/cashier/shift/${shiftId}/close`,{
      method:'POST',headers:headers(cashierA),
      body:JSON.stringify({location_id:loc,counted_cash:16500,note:'Nem zárható függő átadásnál'})
    });
    assert.equal(r.status,409,'A függő átadás alatt a zárást blokkolni kell.');

    r=await jsonReq(base,`/cashier/shift/${shiftId}/handovers/${handoverId}/accept`,{
      method:'POST',headers:headers(cashierB),
      body:JSON.stringify({location_id:loc,counted_cash:16500,note:'Átvétel rendben'})
    });
    assert.equal(r.status,200,`handover accept: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.status,'accepted');
    assert.equal(r.body.accepted_by,'cashier.b@test.local');
    assert.equal(num(r.body.accepted_difference),0);

    await q(`INSERT INTO work_order_payments(work_order_id,payment_method,amount,paid_at,note) VALUES($1,'cash',1000,$2::date + time '13:00','Átvétel utáni készpénz')`,[wo,businessDate]);

    r=await jsonReq(base,`/cashier/shift/current?location_id=${encodeURIComponent(loc)}&date=${businessDate}`,{headers:headers(cashierB)});
    assert.equal(r.status,200);
    assert.equal(r.body.shift.current_cashier,'cashier.b@test.local');
    assert.equal(r.body.shift.status,'open');
    assert.equal(num(r.body.totals.expected_cash),17500);
    assert.equal(r.body.handovers.filter(h=>h.status==='accepted').length,1);

    r=await jsonReq(base,`/cashier/shift/${shiftId}/close`,{
      method:'POST',headers:headers(cashierB),
      body:JSON.stringify({location_id:loc,counted_cash:17400,note:'Teszt zárás 100 Ft hiánnyal'})
    });
    assert.equal(r.status,201,`shift close: ${JSON.stringify(r.body)}`);
    assert.match(r.body.report.report_no,/^KZ-\d{8}-\d+$/);
    assert.equal(num(r.body.report.expected_cash),17500);
    assert.equal(num(r.body.report.counted_cash),17400);
    assert.equal(num(r.body.report.difference),-100);
    assert.equal(r.body.report.handover_count,1);
    assert.equal(r.body.handovers.filter(h=>h.status==='accepted').length,1);
    const reportId=r.body.report.id;

    r=await jsonReq(base,`/cashier/shift-reports/${reportId}?location_id=${encodeURIComponent(loc)}`,{headers:headers(cashierB)});
    assert.equal(r.status,200,`report detail: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.report.closed_by,'cashier.b@test.local');
    assert.equal(num(r.body.report.difference),-100);
    assert.equal(r.body.handovers.length,1);

    const pdf=await binaryReq(base,`/cashier/shift-reports/${reportId}/pdf?location_id=${encodeURIComponent(loc)}`,{headers:{Authorization:`Bearer ${cashierB}`}});
    assert.equal(pdf.status,200,'A zárási PDF végpontnak 200-at kell adnia.');
    assert.match(String(pdf.headers.get('content-type')||''),/application\/pdf/i);
    assert.equal(pdf.body.subarray(0,5).toString(),'%PDF-');
    assert.ok(pdf.body.length>1000,'A generált PDF nem lehet üres.');

    r=await jsonReq(base,`/cashier/shift-history?location_id=${encodeURIComponent(loc)}&from=${businessDate}&to=${businessDate}`,{headers:headers(manager)});
    assert.equal(r.status,200,`history: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.rows.length,1);
    assert.equal(r.body.summary.days,1);
    assert.equal(num(r.body.summary.difference),-100);

    const stored=(await q(`SELECT status,current_cashier,report_no FROM cash_register_shifts WHERE id=$1`,[shiftId])).rows[0];
    assert.equal(stored.status,'closed');
    assert.equal(stored.current_cashier,'cashier.b@test.local');
    assert.match(stored.report_no,/^KZ-/);
    const snap=(await q(`SELECT snapshot,handover_count,difference FROM cash_register_close_reports WHERE id=$1`,[reportId])).rows[0];
    assert.ok(snap.snapshot&&Object.keys(snap.snapshot).length>0,'A zárási snapshotnak rögzítettnek kell lennie.');
    assert.equal(Number(snap.handover_count),1);
    assert.equal(Number(snap.difference),-100);

    r=await jsonReq(base,'/cashier/shift/open',{
      method:'POST',headers:headers(cashierA),
      body:JSON.stringify({location_id:loc,location_name:'Stage13 Teszt Szalon',business_date:businessDate,opening_cash:5000})
    });
    assert.equal(r.status,409,'Lezárt üzleti napot nem szabad újranyitni.');

    console.log('CASHIER STAGE13 INTEGRATION: PASS');
  }finally{
    await new Promise(resolve=>server.close(resolve));
    await pool.end();
  }
}

main().catch(async error=>{
  console.error('CASHIER STAGE13 INTEGRATION: FAIL',error);
  try{await pool.end()}catch{}
  process.exit(1);
});
