import crypto from 'node:crypto';

const API=(process.env.UAT_API_BASE||'https://kleoszalon-api-1.onrender.com').replace(/\/$/,'');
const ADMIN=process.env.UAT_ADMIN_IDENTIFIER||'admin1';
const ADMIN_PASSWORD=process.env.UAT_ADMIN_PASSWORD||'Teszt1234!';
const stamp=new Date().toISOString().replace(/\D/g,'').slice(0,14);
const tag=`UAT-TRANSACTION-CORE-${stamp}`;
const report=[];
let token='';
let booking=null;
let chosen=null;
let workOrderId='';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const money=v=>Math.round(Number(v||0)*100)/100;
const log=(name,status='PASS',detail='')=>{report.push({name,status,detail});console.log(`${status==='PASS'?'✅':status==='BLOCKED'?'⛔':'❌'} ${name}${detail?` — ${detail}`:''}`)};
const fail=msg=>{throw new Error(msg)};
function compact(v,n=1800){try{return JSON.stringify(v).slice(0,n)}catch{return String(v).slice(0,n)}}

async function request(path,{method='GET',body,auth=true,allow=[]}={}){
  const headers={Accept:'application/json'};
  if(body!==undefined)headers['Content-Type']='application/json';
  if(auth&&token)headers.Authorization=`Bearer ${token}`;
  const started=performance.now();
  const r=await fetch(`${API}${path}`,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
  const elapsed=Math.round(performance.now()-started);
  const text=await r.text();let data=null;
  try{data=text?JSON.parse(text):null}catch{data={raw:text.slice(0,1800)}}
  if(!r.ok&&!allow.includes(r.status))throw new Error(`${method} ${path} -> ${r.status} ${compact(data)} [${elapsed} ms]`);
  return{status:r.status,data,text,headers:r.headers,elapsed};
}

async function binary(path){
  const headers={Accept:'application/pdf'};if(token)headers.Authorization=`Bearer ${token}`;
  const started=performance.now();const r=await fetch(`${API}${path}`,{headers});const elapsed=Math.round(performance.now()-started);
  const buf=Buffer.from(await r.arrayBuffer());
  if(!r.ok){let detail='';try{detail=buf.toString('utf8').slice(0,1800)}catch{}throw new Error(`GET ${path} -> ${r.status} ${detail} [${elapsed} ms]`)}
  return{status:r.status,buf,elapsed,headers:r.headers};
}

function localDatePlus(days){
  const d=new Date(Date.now()+days*86400000);
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Budapest',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(d);
  const get=t=>parts.find(x=>x.type===t)?.value;
  return`${get('year')}-${get('month')}-${get('day')}`;
}

async function login(){
  const r=await request('/api/login',{method:'POST',body:{identifier:ADMIN,password:ADMIN_PASSWORD},auth:false});
  if(!r.data?.token)fail(`Admin login nem adott tokent: ${compact(r.data)}`);
  token=r.data.token;log('Admin belépés','PASS',`${ADMIN} · role=${JSON.stringify(r.data.role)} · ${r.elapsed} ms`);
}

async function chooseBookableSlot(){
  const root=await request('/api/public/booking/catalog',{auth:false});
  const locations=Array.isArray(root.data?.locations)?root.data.locations:[];
  if(!locations.length)fail('Nincs aktív telephely a publikus foglalási katalógusban.');
  const ordered=[...locations].sort((a,b)=>{
    const ta=/uat|test|demo|teszt/i.test(String(a.name||''))?0:1;
    const tb=/uat|test|demo|teszt/i.test(String(b.name||''))?0:1;
    return ta-tb||String(a.name||'').localeCompare(String(b.name||''),'hu');
  });
  const candidates=[];
  for(const loc of ordered.slice(0,12)){
    const cat=await request(`/api/public/booking/catalog?location_id=${encodeURIComponent(loc.id)}`,{auth:false});
    const services=(Array.isArray(cat.data?.services)?cat.data.services:[]).filter(s=>Number(s.price)>0).sort((a,b)=>Number(a.price)-Number(b.price));
    if(services.length)candidates.push({location:loc,services:services.slice(0,8),settings:cat.data?.settings||{}});
  }
  if(!candidates.length)fail('Nincs pozitív árú, online foglalható szolgáltatás az aktív telephelyeken.');

  // A legkisebb adat/üzleti hatás érdekében előnyben részesítjük a teszt/demo telephelyet,
  // majd a legolcsóbb szolgáltatást. A 7–45 napos ablakból az első ténylegesen szabad slotot használjuk.
  for(const c of candidates){
    for(const service of c.services){
      for(let day=7;day<=45;day++){
        const date=localDatePlus(day);
        const q=`/api/public/booking/availability?location_id=${encodeURIComponent(c.location.id)}&date=${date}&service_ids=${encodeURIComponent(service.id)}`;
        const av=await request(q,{auth:false});
        const slots=Array.isArray(av.data?.slots)?av.data.slots:[];
        if(slots.length){
          // A nap legutolsó szabad időpontját választjuk, hogy minimális legyen a nappali kapacitásra gyakorolt hatás.
          const slot=slots[slots.length-1];
          chosen={location:c.location,service,slot,date,schedule_source:av.data?.schedule_source||'unknown',settings:c.settings};
          log('Foglalható UAT slot kiválasztása','PASS',`${c.location.name} · ${service.name} · ${slot.start} · ${av.data?.schedule_source||'?'}`);
          return;
        }
      }
    }
  }
  fail('45 napon belül nem található szabad publikus foglalási slot a vizsgált szolgáltatásokhoz.');
}

async function createBooking(){
  const body={
    location_id:chosen.location.id,
    employee_id:chosen.slot.employee_id,
    service_ids:[chosen.service.id],
    client_name:`${tag} Teszt Vendég`,
    phone:'+3610000000',
    start_time:chosen.slot.start,
    booking_source:'online'
  };
  const r=await request('/api/public/booking/book',{method:'POST',body,auth:false});
  if(!r.data?.id||!r.data?.work_order_id)fail(`A publikus foglalás nem adott appointment/work_order azonosítót: ${compact(r.data)}`);
  booking=r.data;workOrderId=String(r.data.work_order_id);
  log('Publikus foglalás → automatikus munkalap','PASS',`appointment=${r.data.id} · workorder=${workOrderId} · ${r.elapsed} ms`);
}

async function arrive(){
  const r=await request(`/api/transactions/booking-workorder/appointments/${encodeURIComponent(booking.id)}/arrive`,{method:'POST',body:{}});
  if(!r.data?.ok||String(r.data?.work_order_id)!==workOrderId)fail(`Érkeztetés/munkalap kapcsolat eltérés: ${compact(r.data)}`);
  log('Vendég érkeztetés + munkalap kapcsolat','PASS',`${r.data.appointment_status} · ${r.elapsed} ms`);
}

function expectedDue(){
  const price=money(chosen.service.price);
  const pct=Math.max(0,Math.min(100,Number(booking?.online_discount_percent||0)));
  const discountAmount=Math.round(price*pct)/100;
  return money(Math.max(0,price-discountAmount));
}

async function settle(){
  const due=expectedDue();if(!(due>0))fail(`A kiválasztott szolgáltatás számított fizetendő összege nem pozitív: ${due}`);
  const r=await request(`/api/transactions/cashier/workorders/${encodeURIComponent(workOrderId)}/settle`,{method:'POST',body:{payments:[{payment_method:'cash',amount:due,note:`${tag} automatikus UAT fizetés`}],discount_amount:0,tip_amount:0,invoice_status:'not_requested',close_financially:true}});
  if(String(r.data?.payment_status)!=='paid'||!r.data?.financial_closed_at)fail(`A pénzügyi lezárás nem lett paid/closed: ${compact(r.data)}`);
  if(Math.abs(Number(r.data?.amount_paid||due)-due)>0.02)fail(`Fizetett összeg eltérés: expected=${due}, actual=${r.data?.amount_paid}`);
  log('Fizetés + pénzügyi lezárás','PASS',`${due.toLocaleString('hu-HU')} Ft · payment_status=paid · ${r.elapsed} ms`);
}

async function finalize(){
  const r=await request(`/api/transactions/workorder-finalization/workorders/${encodeURIComponent(workOrderId)}/finalize`,{method:'POST',body:{}});
  if(!r.data?.finalized||!r.data?.archive?.snapshot_hash)fail(`A véglegesítés/archiválás hiányos: ${compact(r.data)}`);
  if(r.data?.delivery_queued!==true)fail(`A deployolt backend nem a gyors aszinkron dokumentumkézbesítést használja: ${compact(r.data)}`);
  if(String(r.data?.work_order?.status)!=='completed')fail(`A munkalap nem completed: ${compact(r.data?.work_order)}`);
  log('Munkalap végleges lezárás + immutable archívum','PASS',`${r.data.archive.work_order_number||workOrderId} · queued delivery · ${r.elapsed} ms`);
}

async function pdfTwice(){
  const path=`/api/transactions/workorder-finalization/workorders/${encodeURIComponent(workOrderId)}/pdf`;
  let first=null;let lastError=null;
  for(let i=0;i<8;i++){
    try{first=await binary(path);break}catch(e){lastError=e;console.log(`   ↳ PDF readiness #${i+1}: ${e.message}`);await sleep(1500)}
  }
  if(!first)throw lastError||new Error('PDF nem vált elérhetővé.');
  if(!String(first.headers.get('content-type')||'').toLowerCase().includes('application/pdf'))fail(`Első PDF content-type hibás: ${first.headers.get('content-type')}`);
  if(first.buf.length<1200||first.buf.subarray(0,5).toString()!=='%PDF-')fail(`Első PDF tartalma hibás vagy túl rövid: ${first.buf.length} byte`);
  const hash1=crypto.createHash('sha256').update(first.buf).digest('hex');
  const second=await binary(path);
  const hash2=crypto.createHash('sha256').update(second.buf).digest('hex');
  if(second.buf.length!==first.buf.length||hash2!==hash1)fail(`Az ismételt PDF nem determinisztikus: ${first.buf.length}/${second.buf.length} byte, hash eltér.`);
  log('PDF első letöltés','PASS',`${first.buf.length} byte · SHA256 ${hash1.slice(0,12)}… · ${first.elapsed} ms`);
  log('PDF ismételt letöltés/cache','PASS',`azonos hash · ${second.elapsed} ms (első: ${first.elapsed} ms)`);
}

async function email(){
  // A finalize aszinkron kézbesítést is sorba állít. Az explicit email endpointot azért hívjuk,
  // hogy az SMTP/logging visszaigazolást HTTP-szinten is ellenőrizzük. Ez UAT környezetben újraküldést jelenthet.
  const r=await request(`/api/transactions/workorder-finalization/workorders/${encodeURIComponent(workOrderId)}/email`,{method:'POST',body:{}});
  const mail=r.data?.mail||r.data?.delivery?.mail||{};
  if(!(mail.sent||mail.logged||mail.already_sent))fail(`Az e-mail kézbesítés nem kapott pozitív visszaigazolást: ${compact(r.data)}`);
  log('Lezárt munkalap e-mail kézbesítés','PASS',`${mail.sent?'sent':mail.logged?'logged':'already_sent'} · ${r.elapsed} ms`);
}

try{
  const health=await request('/api/health',{auth:false});if(!health.data?.ok||health.data?.db?.ok!==true)fail(`API/DB health nem OK: ${compact(health.data)}`);log('API + DB health','PASS',`${health.elapsed} ms`);
  const bookingHealth=await request('/api/public/booking/health',{auth:false});if(!bookingHealth.data?.ok)fail(`Booking health nem OK: ${compact(bookingHealth.data)}`);log('Foglalás 3.0 health','PASS',`${bookingHealth.data.locations||0} telephely · ${bookingHealth.data.services||0} szolgáltatás`);
  await chooseBookableSlot();
  await createBooking();
  await login();
  await arrive();
  await settle();
  await finalize();
  await sleep(1800);
  await pdfTwice();
  await email();
  console.log('\n=== TRANZAKCIÓS MAG LIVE UAT ===');
  for(const x of report)console.log(`${x.status.padEnd(7)} ${x.name}${x.detail?` :: ${x.detail}`:''}`);
  console.log(`\nUAT PASS: foglalás → munkalap → fizetés → lezárás → PDF → ismételt PDF → e-mail.\nEVIDENCE appointment=${booking.id} work_order=${workOrderId} tag=${tag}`);
}catch(e){
  console.error('\nUAT FAIL:',e?.stack||e);
  console.error(`EVIDENCE PARTIAL appointment=${booking?.id||'-'} work_order=${workOrderId||'-'} tag=${tag}`);
  process.exitCode=1;
}
