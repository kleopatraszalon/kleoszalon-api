const assert=require('node:assert/strict');
const express=require('express');
const jwt=require('jsonwebtoken');
const {pool}=require('../dist/db');
const advanced=require('../dist/routes/bookingAdvanced').default;
const secret=process.env.JWT_SECRET||'booking_stage15_secret';
const token=(payload)=>jwt.sign(payload,secret,{expiresIn:'1h'});
const auth=(t)=>({Authorization:`Bearer ${t}`,'Content-Type':'application/json'});
async function q(sql,params=[]){return pool.query(sql,params)}
async function req(base,path,opts={}){const r=await fetch(base+path,opts);let body;try{body=await r.json()}catch{body=await r.text()}return{status:r.status,body}}
const post=(t,body,method='POST')=>({method,headers:auth(t),body:JSON.stringify(body)});

async function main(){
 await q(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS name text;ALTER TABLE employees ADD COLUMN IF NOT EXISTS first_name text;ALTER TABLE employees ADD COLUMN IF NOT EXISTS last_name text;`);
 await q(`ALTER TABLE appointment_services ADD COLUMN IF NOT EXISTS discount_percent numeric(5,2) NOT NULL DEFAULT 0;`);
 await q(`CREATE TABLE IF NOT EXISTS appointment_technical_breaks(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,start_time timestamptz NOT NULL,end_time timestamptz NOT NULL,title text NOT NULL DEFAULT 'Technikai szünet',note text,created_by text,created_at timestamptz NOT NULL DEFAULT now(),CHECK(end_time>start_time));`);
 const seed=(await q(`
  WITH l AS (INSERT INTO locations(name,city,address) VALUES('Stage15 Szalon','Budapest','4Hands utca 15') RETURNING id),
       e1 AS (INSERT INTO employees(full_name,email,location_id,active) SELECT 'Anna Kozmetikus','anna15@test.local',id,true FROM l RETURNING id),
       e2 AS (INSERT INTO employees(full_name,email,location_id,active) SELECT 'Bea Kozmetikus','bea15@test.local',id,true FROM l RETURNING id),
       c AS (INSERT INTO clients(name,full_name,email,phone,location_id) SELECT 'Stage15 Vendég','Stage15 Vendég','guest15@test.local','+36151515',id FROM l RETURNING id),
       s1 AS (INSERT INTO services(name,base_price,list_price,duration_minutes,is_active) VALUES('4Hands Arcápolás',12000,12000,60,true) RETURNING id),
       s2 AS (INSERT INTO services(name,base_price,list_price,duration_minutes,is_active) VALUES('4Hands Kézápolás',8000,8000,30,true) RETURNING id)
  SELECT l.id location_id,e1.id employee1,e2.id employee2,c.id client_id,s1.id service1,s2.id service2 FROM l,e1,e2,c,s1,s2
 `)).rows[0];
 const loc=String(seed.location_id),e1=String(seed.employee1),e2=String(seed.employee2),c=String(seed.client_id),s1=String(seed.service1),s2=String(seed.service2);
 const admin=token({id:'stage15-admin',email:'stage15-admin@test.local',role:'admin',location_id:loc});
 const app=express();app.use(express.json());app.use('/advanced',advanced);app.use((err,_req,res,_next)=>{console.error('stage15 integration route error',err);res.status(500).json({message:err?.message||String(err),code:err?.code||null})});
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s))});const base=`http://127.0.0.1:${server.address().port}`;
 try{
  let r=await req(base,'/advanced/resources',post(admin,{location_id:loc,name:'Kezelő 1',resource_group:'kezelo',resource_type:'room'}));assert.equal(r.status,201,`resource1: ${JSON.stringify(r.body)}`);const resource1=r.body.id;
  r=await req(base,`/advanced/service-resources/${s1}`,post(admin,{requirements:[{resource_group:'kezelo',quantity:1}]},'PUT'));assert.equal(r.status,200);
  r=await req(base,`/advanced/service-resources/${s2}`,post(admin,{requirements:[{resource_group:'kezelo',quantity:1}]},'PUT'));assert.equal(r.status,200);
  const start=new Date(Date.now()+48*3600_000);start.setUTCMinutes(0,0,0);const payload={location_id:loc,client_id:c,start_time:start.toISOString(),services:[{service_id:s1,employee_id:e1},{service_id:s2,employee_id:e2}]};

  r=await req(base,'/advanced/availability',post(admin,{...payload,booking_mode:'parallel'}));assert.equal(r.status,409,`parallel should need two resources: ${JSON.stringify(r.body)}`);assert.ok(r.body.conflicts.some(x=>x.type==='resource'));
  r=await req(base,'/advanced/availability',post(admin,{...payload,booking_mode:'sequential'}));assert.equal(r.status,200,`sequential may reuse resource: ${JSON.stringify(r.body)}`);assert.equal(r.body.duration_minutes,90);assert.equal(r.body.resource_allocations.length,2);assert.equal(String(r.body.resource_allocations[0].resource_id),String(resource1));assert.equal(String(r.body.resource_allocations[1].resource_id),String(resource1));

  r=await req(base,'/advanced/resources',post(admin,{location_id:loc,name:'Kezelő 2',resource_group:'kezelo',resource_type:'room'}));assert.equal(r.status,201);const resource2=r.body.id;
  r=await req(base,'/advanced/availability',post(admin,{...payload,booking_mode:'parallel'}));assert.equal(r.status,200,`parallel with two rooms: ${JSON.stringify(r.body)}`);assert.equal(r.body.duration_minutes,60);assert.equal(r.body.services.length,2);assert.equal(r.body.resource_allocations.length,2);assert.equal(new Set(r.body.resource_allocations.map(x=>String(x.resource_id))).size,2);

  r=await req(base,'/advanced/appointments',post(admin,{...payload,booking_mode:'parallel',notes:'Stage15 4Hands integráció'}));assert.equal(r.status,201,`advanced create: ${JSON.stringify(r.body)}`);assert.ok(r.body.appointment_id);assert.ok(r.body.work_order_id);assert.ok(r.body.work_order_number);assert.equal(r.body.duration_minutes,60);const appointmentId=r.body.appointment_id;
  assert.equal(Number((await q(`SELECT count(*) n FROM appointment_staff_assignments WHERE appointment_id=$1::uuid`,[appointmentId])).rows[0].n),2);
  assert.equal(Number((await q(`SELECT count(*) n FROM appointment_resource_allocations WHERE appointment_id=$1::uuid`,[appointmentId])).rows[0].n),2);
  const ap=(await q(`SELECT employee_id::text,start_time,end_time,booking_source,work_order_id::text FROM appointments WHERE id=$1::uuid`,[appointmentId])).rows[0];assert.equal(ap.employee_id,e1);assert.equal(ap.booking_source,'internal_advanced');assert.ok(ap.work_order_id);
  const snapshot=(await q(`SELECT source_snapshot FROM work_orders WHERE id=$1::uuid`,[r.body.work_order_id])).rows[0].source_snapshot;assert.equal(snapshot.booking_mode,'parallel');assert.equal(snapshot.staff_assignments.length,2);assert.equal(snapshot.resource_allocations.length,2);

  r=await req(base,`/advanced/appointments/${appointmentId}/allocations`,{headers:auth(admin)});assert.equal(r.status,200);assert.equal(r.body.staff.length,2);assert.equal(r.body.resources.length,2);
  r=await req(base,'/advanced/availability',post(admin,{...payload,booking_mode:'parallel'}));assert.equal(r.status,409,'same staff/time must be blocked');assert.ok(r.body.conflicts.some(x=>x.type==='staff'));

  console.log('BOOKING STAGE15 INTEGRATION: PASS');
 }finally{await new Promise(resolve=>server.close(resolve));await pool.end()}
}
main().catch(async e=>{console.error('BOOKING STAGE15 INTEGRATION: FAIL',e);try{await pool.end()}catch{}process.exit(1)});
