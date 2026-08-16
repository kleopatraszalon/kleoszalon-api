const assert=require('node:assert/strict');
const {pool}=require('../dist/db');

const REQ='KLEO-GEN-OPS-001';
const AC_BLOCK='KLEO-GEN-OPS-001-AC-01';
const AC_CLOSE='KLEO-GEN-OPS-001-AC-02';

async function q(sql,params=[]){return pool.query(sql,params)}

async function main(){
  console.log(`${REQ} ${AC_BLOCK} ${AC_CLOSE}`);
  const seeded=await q(`WITH l AS (
    INSERT INTO locations(name,city,address) VALUES('Napzárás teszt szalon','Budapest','Teszt utca 1') RETURNING id
  ), c AS (
    INSERT INTO clients(name,full_name) VALUES('Teszt Vendég','Teszt Vendég') RETURNING id
  ), e AS (
    INSERT INTO employees(full_name,active) VALUES('Teszt Kolléga',true) RETURNING id
  ) SELECT l.id location_id,c.id client_id,e.id employee_id FROM l,c,e`);
  const d=seeded.rows[0];
  const businessDate=(await q(`SELECT CURRENT_DATE::text business_date`)).rows[0].business_date;
  const appt=(await q(`INSERT INTO appointments(location_id,employee_id,client_id,title,start_time,end_time,status)
    VALUES($1,$2,$3,'Napzárás teszt',CURRENT_DATE+interval '10 hour',CURRENT_DATE+interval '11 hour','booked') RETURNING id`,[d.location_id,d.employee_id,d.client_id])).rows[0];
  const wo=(await q(`INSERT INTO work_orders(title,status,employee_id,client_id,client_name,location_id,appointment_id,work_order_number,created_by)
    VALUES('Napzárás blokkoló munkalap','in_progress',$1,$2,'Teszt Vendég',$3,$4,'WO-DAY-CLOSE-001','ci') RETURNING id`,[d.employee_id,d.client_id,d.location_id,appt.id])).rows[0];

  let blocked=null;
  try{
    await q(`INSERT INTO cash_register_closings(location_id,business_date,opening_cash,closed_by)
      VALUES($1,$2::date,0,'ci')`,[String(d.location_id),businessDate]);
  }catch(error){blocked=error}
  assert.ok(blocked,'day close must be blocked when an open work order exists');
  assert.equal(blocked.code,'P0001');
  assert.match(String(blocked.message),/KLEO_DAY_CLOSE_BLOCKED/);
  assert.match(String(blocked.detail),new RegExp(String(wo.id)));
  assert.equal(Number((await q(`SELECT COUNT(*)::int n FROM cash_register_closings WHERE location_id=$1 AND business_date=$2::date`,[String(d.location_id),businessDate])).rows[0].n),0);

  await q(`UPDATE work_orders SET financial_closed_at=now(),financial_closed_by='ci',status='completed',completed_at=now() WHERE id=$1`,[wo.id]);
  const closing=(await q(`INSERT INTO cash_register_closings(location_id,business_date,opening_cash,closed_by,note)
    VALUES($1,$2::date,0,'ci','KLEO day close integration') RETURNING id,closed_by,closed_at`,[String(d.location_id),businessDate])).rows[0];
  assert.ok(closing.id);
  assert.equal(closing.closed_by,'ci');
  assert.ok(closing.closed_at);

  let duplicate=null;
  try{
    await q(`INSERT INTO cash_register_closings(location_id,business_date,opening_cash,closed_by)
      VALUES($1,$2::date,0,'ci-duplicate')`,[String(d.location_id),businessDate]);
  }catch(error){duplicate=error}
  assert.ok(duplicate,'a second close record for the same business day must fail');
  assert.equal(duplicate.code,'23505');
  assert.equal(Number((await q(`SELECT COUNT(*)::int n FROM cash_register_closings WHERE location_id=$1 AND business_date=$2::date`,[String(d.location_id),businessDate])).rows[0].n),1);

  console.log('DAY CLOSE GUARD INTEGRATION: PASS');
  await pool.end();
}

main().catch(async error=>{console.error('DAY CLOSE GUARD INTEGRATION: FAIL',error);try{await pool.end()}catch{}process.exit(1)});
