const assert=require('node:assert/strict');
const express=require('express');
const {pool}=require('../dist/db');
const ensureOnlineBooking=require('../dist/booking/ensureOnlineBooking').default;
const {ensureBookingWorkOrderSchema}=require('../dist/services/bookingWorkOrder');
const onlineBooking=require('../dist/routes/onlineBooking').default;
async function q(sql,params=[]){return pool.query(sql,params)}
async function req(base,path,opts={}){const r=await fetch(base+path,opts);let body;try{body=await r.json()}catch{body=await r.text()}return{status:r.status,body}}
const post=body=>({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
async function main(){
 await q(`ALTER TABLE services ADD COLUMN IF NOT EXISTS online_bookable boolean NOT NULL DEFAULT true;ALTER TABLE employees ADD COLUMN IF NOT EXISTS first_name text;ALTER TABLE employees ADD COLUMN IF NOT EXISTS last_name text;ALTER TABLE employees ADD COLUMN IF NOT EXISTS photo_url text;ALTER TABLE clients ADD COLUMN IF NOT EXISTS marketing_consent boolean NOT NULL DEFAULT false;ALTER TABLE clients ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';ALTER TABLE clients ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();ALTER TABLE clients ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();`);
 await ensureBookingWorkOrderSchema(pool);await ensureOnlineBooking();
 const seed=(await q(`WITH l AS(INSERT INTO locations(name,city,address)VALUES('Public Resource Szalon','Budapest','Online 15/1')RETURNING id),e1 AS(INSERT INTO employees(full_name,email,location_id,active)SELECT 'Online Anna','online-anna@test.local',id,true FROM l RETURNING id),e2 AS(INSERT INTO employees(full_name,email,location_id,active)SELECT 'Online Bea','online-bea@test.local',id,true FROM l RETURNING id),s AS(INSERT INTO services(name,base_price,list_price,duration_minutes,is_active,online_bookable)VALUES('Online Masszázs',10000,10000,60,true,true)RETURNING id),s2 AS(INSERT INTO services(name,base_price,list_price,duration_minutes,is_active,online_bookable)VALUES('Online Konzultáció',5000,5000,60,true,true)RETURNING id)SELECT l.id location_id,e1.id employee1,e2.id employee2,s.id service_id,s2.id service2_id FROM l,e1,e2,s,s2`)).rows[0];
 const loc=String(seed.location_id),e1=String(seed.employee1),e2=String(seed.employee2),sid=String(seed.service_id),sid2=String(seed.service2_id);
 await q(`INSERT INTO service_locations(service_id,location_id)VALUES($1::uuid,$2::uuid),($3::uuid,$2::uuid)`,[sid,loc,sid2]);
 const date=new Date(Date.now()+7*86400000).toISOString().slice(0,10),start=`${date}T09:00:00.000Z`,end=`${date}T10:00:00.000Z`;
 await q(`INSERT INTO online_booking_settings(location_id,enabled,online_discount_percent,slot_interval_minutes,opening_minute,closing_minute,booking_horizon_days,minimum_notice_minutes,require_staff_confirmation) VALUES($1::uuid,true,5,60,540,600,365,0,false) ON CONFLICT(location_id) DO UPDATE SET enabled=true,slot_interval_minutes=60,opening_minute=540,closing_minute=600,booking_horizon_days=365,minimum_notice_minutes=0,require_staff_confirmation=false`,[loc]);
 const app=express();app.use(express.json());app.use('/booking',onlineBooking);app.use((err,_req,res,_next)=>{console.error('public resource integration route error',err);res.status(500).json({message:err?.message||String(err),code:err?.code||null})});const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s))});const base=`http://127.0.0.1:${server.address().port}`;
 try{
  let r=await req(base,`/booking/availability?location_id=${loc}&date=${date}&service_ids=${sid2}&employee_id=${e1}`);assert.equal(r.status,200,`legacy availability: ${JSON.stringify(r.body)}`);assert.equal(r.body.resource_aware,undefined,'service without resource requirement must fall through to legacy core');
  // Bootstrap resource tables through resource-aware middleware, then configure one room.
  r=await req(base,`/booking/availability?location_id=${loc}&date=${date}&service_ids=${sid}&employee_id=${e1}`);assert.equal(r.status,200);
  const room=(await q(`INSERT INTO booking_resources(location_id,name,resource_group,resource_type)VALUES($1::uuid,'Masszázs szoba 1','masszazs-szoba','room')RETURNING id`,[loc])).rows[0];
  await q(`INSERT INTO service_resource_requirements(service_id,resource_group,quantity)VALUES($1::uuid,'masszazs-szoba',1)`,[sid]);
  r=await req(base,`/booking/availability?location_id=${loc}&date=${date}&service_ids=${sid}&employee_id=${e1}`);assert.equal(r.status,200,`resource availability: ${JSON.stringify(r.body)}`);assert.equal(r.body.resource_aware,true);assert.equal(r.body.slots.length,1);assert.equal(r.body.slots[0].start,start);

  const blocking=(await q(`INSERT INTO appointments(location_id,employee_id,title,start_time,end_time,status)VALUES($1::uuid,$2::uuid,'Másik vendég',$3::timestamptz,$4::timestamptz,'confirmed')RETURNING id`,[loc,e2,start,end])).rows[0];
  await q(`INSERT INTO appointment_resource_allocations(appointment_id,service_id,resource_id,start_time,end_time)VALUES($1::uuid,$2::uuid,$3::uuid,$4::timestamptz,$5::timestamptz)`,[blocking.id,sid,room.id,start,end]);
  r=await req(base,`/booking/availability?location_id=${loc}&date=${date}&service_ids=${sid}&employee_id=${e1}`);assert.equal(r.status,200);assert.equal(r.body.resource_aware,true);assert.equal(r.body.slots.length,0,'free staff must not be offered when the required room is occupied');
  await q(`UPDATE appointments SET status='cancelled' WHERE id=$1::uuid`,[blocking.id]);
  r=await req(base,`/booking/availability?location_id=${loc}&date=${date}&service_ids=${sid}&employee_id=${e1}`);assert.equal(r.status,200);assert.equal(r.body.slots.length,1);

  r=await req(base,'/booking/book',post({location_id:loc,employee_id:e1,service_ids:[sid],client_name:'Erőforrás Vendég',phone:'+3615550001',email:'resource-guest@test.local',start_time:start,marketing_consent:true}));assert.equal(r.status,201,`public resource booking: ${JSON.stringify(r.body)}`);assert.ok(r.body.id);const appointmentId=String(r.body.id);
  const alloc=(await q(`SELECT ara.resource_id::text,ara.start_time,ara.end_time,h.consumed_at FROM appointment_resource_allocations ara LEFT JOIN online_booking_resource_holds h ON h.resource_id=ara.resource_id AND h.service_id=ara.service_id AND h.start_time=ara.start_time AND h.end_time=ara.end_time WHERE ara.appointment_id=$1::uuid`,[appointmentId])).rows[0];assert.equal(String(alloc.resource_id),String(room.id));assert.ok(alloc.consumed_at,'resource hold must be consumed by appointment service trigger');
  assert.equal(Number((await q(`SELECT count(*) n FROM work_orders WHERE appointment_id=$1::uuid`,[appointmentId])).rows[0].n),1,'public booking must still create its work order');

  r=await req(base,'/booking/book',post({location_id:loc,employee_id:e2,service_ids:[sid],client_name:'Másik online vendég',phone:'+3615550002',start_time:start}));assert.equal(r.status,409,`second booking must be blocked by resource: ${JSON.stringify(r.body)}`);assert.equal(r.body.resource_conflict,true);
  assert.equal(Number((await q(`SELECT count(*) n FROM appointments WHERE location_id=$1::uuid AND start_time=$2::timestamptz AND status NOT IN('cancelled','canceled','no_show')`,[loc,start])).rows[0].n),1);
  console.log('PUBLIC BOOKING RESOURCES STAGE15.1 INTEGRATION: PASS');
 }finally{await new Promise(resolve=>server.close(resolve));await pool.end()}
}
main().catch(async e=>{console.error('PUBLIC BOOKING RESOURCES STAGE15.1 INTEGRATION: FAIL',e);try{await pool.end()}catch{}process.exit(1)});
