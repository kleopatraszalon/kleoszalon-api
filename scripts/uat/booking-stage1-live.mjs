const API_BASE=(process.env.UAT_API_BASE||'https://kleoszalon-api-1.onrender.com').replace(/\/$/,'');
const CUSTOMER_IDENTIFIER=process.env.UAT_CUSTOMER_IDENTIFIER||'ugyfel1';
const CUSTOMER_PASSWORD=process.env.UAT_CUSTOMER_PASSWORD||'Teszt1234!';
const UAT_PREFIX=`UAT-${new Date().toISOString().replace(/[:.]/g,'-')}`;

let token='';
let created=null;
let cancellationToken='';
const report=[];

function logStep(name,status,detail=''){
  const item={name,status,detail};report.push(item);
  console.log(`${status==='PASS'?'✅':status==='WARN'?'⚠️':'❌'} ${name}${detail?` — ${detail}`:''}`);
}

async function request(path,{method='GET',body,auth=false,allow404=false}={}){
  const headers={'Accept':'application/json'};
  if(body!==undefined)headers['Content-Type']='application/json';
  if(auth&&token)headers.Authorization=`Bearer ${token}`;
  const response=await fetch(`${API_BASE}${path}`,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
  const text=await response.text();
  let data=null;try{data=text?JSON.parse(text):null}catch{data={raw:text.slice(0,800)}}
  if(!response.ok&&!(allow404&&response.status===404)){
    const error=new Error(`${method} ${path} -> ${response.status} ${JSON.stringify(data).slice(0,1000)}`);
    error.status=response.status;error.data=data;throw error;
  }
  return{status:response.status,data,headers:response.headers};
}

const dateInBudapest=(d)=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Budapest',year:'numeric',month:'2-digit',day:'2-digit'}).format(d);
const futureDate=(days)=>dateInBudapest(new Date(Date.now()+days*86400000));

async function findBookableSlot(){
  const root=(await request('/api/public/marketing/booking/catalog')).data;
  const locations=Array.isArray(root?.locations)?root.locations:[];
  if(!locations.length)throw new Error('A booking katalógus nem adott aktív telephelyet.');
  for(const location of locations.slice(0,8)){
    const catalog=(await request(`/api/public/marketing/booking/catalog?location_id=${encodeURIComponent(location.id)}`)).data;
    const services=Array.isArray(catalog?.services)?catalog.services:[];
    for(const service of services.slice(0,25)){
      for(let day=1;day<=28;day++){
        const date=futureDate(day);
        const path=`/api/public/marketing/booking/availability?location_id=${encodeURIComponent(location.id)}&date=${date}&service_ids=${encodeURIComponent(service.id)}`;
        const availability=(await request(path)).data;
        const slots=Array.isArray(availability?.slots)?availability.slots:[];
        if(slots.length>=1)return{location,service,catalog,date,availability,slot:slots[0]};
      }
    }
  }
  throw new Error('28 napon belül nem találtam egyetlen online foglalható szabad időpontot sem a katalógusban.');
}

async function findRescheduleSlot(locationId,serviceId,currentStart){
  for(let day=1;day<=28;day++){
    const date=futureDate(day);
    const path=`/api/public/marketing/booking/availability?location_id=${encodeURIComponent(locationId)}&date=${date}&service_ids=${encodeURIComponent(serviceId)}`;
    const availability=(await request(path)).data;
    const slots=(Array.isArray(availability?.slots)?availability.slots:[]).filter(x=>x.start!==currentStart);
    if(slots.length)return{date,availability,slot:slots[0]};
  }
  throw new Error('A létrehozott UAT foglaláshoz nem találtam második szabad időpontot az áthelyezés teszteléséhez.');
}

async function cleanup(){
  if(!cancellationToken)return;
  try{
    const result=await request(`/api/public/marketing/booking/cancel/${encodeURIComponent(cancellationToken)}`,{method:'POST',body:{reason:`${UAT_PREFIX} automatikus takarítás`},allow404:true});
    if(result.status===404)console.log('ℹ️ Cleanup: a foglalás már nem lemondható / már lemondott állapotban van.');
    else console.log('🧹 Cleanup: UAT foglalás lemondva.');
  }catch(error){console.error('⚠️ Cleanup hiba:',error.message);}
}

try{
  const health=(await request('/api/health')).data;
  if(!health?.ok||health?.db?.ok!==true)throw new Error(`API/DB health nem OK: ${JSON.stringify(health)}`);
  logStep('API + adatbázis health','PASS',String(health.time||''));

  const bookingHealth=(await request('/api/public/marketing/booking/health')).data;
  if(!bookingHealth?.ok)throw new Error(`Booking health nem OK: ${JSON.stringify(bookingHealth)}`);
  logStep('Foglalás 3.0 backend health','PASS',`szalon=${bookingHealth.locations}, szolgáltatás=${bookingHealth.services}, munkatárs=${bookingHealth.employees}`);

  const voiceHealth=(await request('/api/public/marketing/booking/voice/health')).data;
  if(!voiceHealth?.ok)throw new Error(`Voice health nem OK: ${JSON.stringify(voiceHealth)}`);
  logStep('Voice Booking health','PASS',`AI=${voiceHealth.ai_configured?'konfigurálva':'fallback mód'}, transcript_store=${voiceHealth.transcripts_stored}`);

  const selected=await findBookableSlot();
  const scheduleSource=String(selected.availability?.schedule_source||'n/a');
  logStep('Schedule-aware szabad időpont keresés','PASS',`${selected.location.name} · ${selected.service.name} · ${selected.date} · ${scheduleSource}`);

  const aliasPath=`/api/public/booking/availability?location_id=${encodeURIComponent(selected.location.id)}&date=${selected.date}&service_ids=${encodeURIComponent(selected.service.id)}`;
  const legacyAlias=(await request(aliasPath)).data;
  if(!legacyAlias?.schedule_source)logStep('Legacy /api/public/booking schedule guard','WARN','a válaszban nincs schedule_source; ez az alias megkerülheti a közzétett munkaidő-szabályt');
  else logStep('Legacy /api/public/booking schedule guard','PASS',String(legacyAlias.schedule_source));

  const transcript=`A ${selected.location.name} szalonba szeretnék ${selected.service.name} szolgáltatást holnap délelőtt.`;
  const voice=(await request('/api/public/marketing/booking/voice/interpret',{method:'POST',body:{transcript}})).data;
  if(voice?.requires_confirmation!==true)throw new Error(`Voice Booking nem kért kötelező megerősítést: ${JSON.stringify(voice)}`);
  logStep('Voice Booking értelmezés + kötelező megerősítés','PASS',`recognized=${Boolean(voice.recognized)}, ai=${Boolean(voice.ai_used)}`);

  const bookingBody={
    location_id:selected.location.id,
    employee_id:selected.slot.employee_id,
    service_ids:[selected.service.id],
    client_name:'DEMO Kiss Anna',
    phone:'+36 30 555 0101',
    email:'demo.ugyfel@kleoszalon.hu',
    start_time:selected.slot.start,
    booking_source:'online',
    marketing_consent:false,
    note:`${UAT_PREFIX} Booking 3.0 élő UAT`
  };
  created=(await request('/api/public/marketing/booking/book',{method:'POST',body:bookingBody})).data;
  cancellationToken=String(created?.cancellation_token||'');
  if(!created?.id||!created?.work_order_id||!cancellationToken)throw new Error(`A booking válaszból hiányzik appointment/workorder/cancellation token: ${JSON.stringify(created)}`);
  logStep('Foglalás létrehozása + munkalap bridge','PASS',`appointment=${created.id}, workorder=${created.work_order_number||created.work_order_id}`);

  const login=(await request('/api/login',{method:'POST',body:{identifier:CUSTOMER_IDENTIFIER,password:CUSTOMER_PASSWORD}})).data;
  token=String(login?.token||'');
  if(!token)throw new Error('A demo ügyfél belépése nem adott JWT tokent.');
  logStep('Ügyfélfiók belépés','PASS',String(login?.email||CUSTOMER_IDENTIFIER));

  const profile=(await request('/api/customer-portal/self-service/profile',{auth:true})).data;
  if(String(profile?.email||'').toLowerCase()!=='demo.ugyfel@kleoszalon.hu')throw new Error(`Eltérő ügyfélprofil: ${JSON.stringify(profile)}`);
  if(profile?.email_read_only!==true)throw new Error('Az ügyfélprofil e-mail mezője nem read-only jelzésű.');
  logStep('CRM self-service profil','PASS',`${profile.full_name} · preferred_contact=${profile.preferred_contact||'n/a'}`);

  const appointments=(await request('/api/customer-portal/self-service/appointments',{auth:true})).data;
  const own=Array.isArray(appointments)?appointments.find(x=>String(x.id)===String(created.id)):null;
  if(!own)throw new Error('A frissen létrehozott foglalás nem jelent meg a saját időpontok között.');
  if(!Array.isArray(own.services)||!own.services.length)throw new Error('A saját időpont szolgáltatáslistája üres.');
  logStep('Saját közelgő időpont + szolgáltatáslista','PASS',`${own.title} · ${own.employee_name||''}`);

  const next=await findRescheduleSlot(selected.location.id,selected.service.id,selected.slot.start);
  const rescheduled=(await request(`/api/customer-portal/self-service/appointments/${encodeURIComponent(created.id)}/reschedule`,{method:'PATCH',auth:true,body:{employee_id:next.slot.employee_id,start_time:next.slot.start,note:`${UAT_PREFIX} áthelyezés`}})).data;
  if(!rescheduled?.ok||String(rescheduled?.start_time)===String(selected.slot.start))throw new Error(`Az áthelyezés nem igazolható: ${JSON.stringify(rescheduled)}`);
  logStep('Ügyféloldali időpont-áthelyezés','PASS',`${next.date} · ${next.slot.employee_name||next.slot.employee_id}`);

  const cancelled=(await request(`/api/customer-portal/self-service/appointments/${encodeURIComponent(created.id)}/cancel`,{method:'POST',auth:true,body:{reason:`${UAT_PREFIX} UAT lemondás`}})).data;
  if(!cancelled?.ok||String(cancelled?.status)!=='cancelled')throw new Error(`A lemondás nem igazolható: ${JSON.stringify(cancelled)}`);
  logStep('Ügyféloldali lemondás + soft status','PASS',String(cancelled.status));

  const afterCancel=(await request('/api/customer-portal/self-service/appointments',{auth:true})).data;
  if(Array.isArray(afterCancel)&&afterCancel.some(x=>String(x.id)===String(created.id)))throw new Error('A lemondott UAT időpont továbbra is aktív közelgő időpontként jelenik meg.');
  logStep('Lemondás utáni ügyféloldali állapot','PASS','a lemondott időpont nincs az aktív listában');

  cancellationToken='';
  const warnings=report.filter(x=>x.status==='WARN');
  console.log('\n=== BOOKING STAGE 1 LIVE UAT SUMMARY ===');
  for(const item of report)console.log(`${item.status.padEnd(4)} ${item.name}${item.detail?` :: ${item.detail}`:''}`);
  if(warnings.length){
    console.error(`\nUAT funkcionális lánc lefutott, de ${warnings.length} blokkoló/keményítési figyelmeztetés maradt.`);
    process.exitCode=2;
  }else{
    console.log('\nUAT PASS: az 1A–1C fő foglalási lánc élő környezetben végigment.');
  }
}catch(error){
  console.error('\nUAT FAIL:',error?.stack||error);
  process.exitCode=1;
}finally{
  await cleanup();
}
