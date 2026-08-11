const API=process.env.UAT_API_BASE||'https://kleoszalon-api-1.onrender.com';
const FRONTEND=process.env.UAT_FRONTEND_BASE||'https://kleoszalon-frontend.onrender.com';
const ADMIN_ID=process.env.UAT_ADMIN_IDENTIFIER||'admin1';
const ADMIN_PASSWORD=process.env.UAT_ADMIN_PASSWORD||'Teszt1234!';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const assert=(ok,msg)=>{if(!ok)throw new Error(msg)};
const headersJson={'content-type':'application/json'};

async function request(url,options={}){
  const res=await fetch(url,options);
  let body=null;try{body=await res.json()}catch{}
  return{res,body};
}
function localDate(offsetDays){
  const d=new Date(Date.now()+offsetDays*86400000);
  return new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Budapest',year:'numeric',month:'2-digit',day:'2-digit'}).format(d);
}
async function login(){
  const r=await request(`${API}/api/login`,{method:'POST',headers:headersJson,body:JSON.stringify({identifier:ADMIN_ID,password:ADMIN_PASSWORD})});
  assert(r.res.ok&&r.body?.token,`DEMO admin login sikertelen: ${r.res.status}`);
  return r.body.token;
}
async function waitForExactStats(token){
  const deadline=Date.now()+8*60_000;let last=null;
  while(Date.now()<deadline){
    const r=await request(`${API}/api/transactions/booking-voice-stats?days=30`,{headers:{authorization:`Bearer ${token}`}});
    last={status:r.res.status,body:r.body};
    if(r.res.ok&&r.body?.tracking?.mode==='exact_voice_event_id')return r.body;
    await sleep(10000);
  }
  throw new Error(`Exact Voice stats deploy marker nem jelent meg: ${JSON.stringify(last)}`);
}
async function waitForFrontendMarker(){
  const deadline=Date.now()+8*60_000;let last='';
  while(Date.now()<deadline){
    const res=await fetch(`${FRONTEND}/booking`,{redirect:'follow'});
    const html=await res.text();
    if(res.ok){
      const scripts=[...html.matchAll(/<script[^>]+src=["']([^"']+\.js[^"']*)["']/g)].map(m=>m[1]);
      for(const src of scripts){
        const url=new URL(src,`${FRONTEND}/`).toString();
        const jsRes=await fetch(url);if(!jsRes.ok)continue;
        const js=await jsRes.text();last=js.slice(0,200);
        if(js.includes('kleo_public_voice_origin_v1')&&js.includes('exact voice_event_id'))return true;
      }
    }
    await sleep(10000);
  }
  throw new Error(`Frontend exact-correlation bundle marker nem jelent meg. ${last}`);
}
async function findSlot(){
  const root=await request(`${API}/api/public/marketing/booking/catalog`);
  assert(root.res.ok&&Array.isArray(root.body?.locations)&&root.body.locations.length,'Nincs publikus helyszínkatalógus');
  const locations=[...root.body.locations].sort((a,b)=>String(a.name).includes('DEMO')?-1:String(b.name).includes('DEMO')?1:0);
  for(const loc of locations.slice(0,5)){
    const cat=await request(`${API}/api/public/marketing/booking/catalog?location_id=${encodeURIComponent(loc.id)}`);
    if(!cat.res.ok||!cat.body?.services?.length)continue;
    const services=[...cat.body.services].sort((a,b)=>String(a.name).toLowerCase().includes('alkalmi konty')?-1:String(b.name).toLowerCase().includes('alkalmi konty')?1:0).slice(0,8);
    for(const service of services){
      for(let day=2;day<=21;day++){
        const date=localDate(day);
        const qs=new URLSearchParams({location_id:String(loc.id),date,service_ids:String(service.id)});
        const av=await request(`${API}/api/public/marketing/booking/availability?${qs}`);
        const slot=av.body?.slots?.[0];
        if(av.res.ok&&slot)return{location:loc,service,date,slot,schedule_source:av.body?.schedule_source||null};
      }
    }
  }
  throw new Error('Nem találtam biztonságosan használható élő foglalási slotot 21 napon belül.');
}

let cancellationToken='';let voiceEventId='';
try{
  const health=await request(`${API}/api/health`);
  assert(health.res.ok&&health.body?.db?.ok===true,'API/DB health nem PASS');
  console.log('✅ API + DB health');

  const token=await login();
  console.log('✅ DEMO admin belépés');
  const before=await waitForExactStats(token);
  console.log(`✅ Exact stats deploy — mode=${before.tracking.mode}`);
  await waitForFrontendMarker();
  console.log('✅ Frontend deploy — voice origin + exact stats bundle marker él');

  const choice=await findSlot();
  console.log(`✅ UAT slot — ${choice.location.name} · ${choice.service.name} · ${choice.date} · ${choice.schedule_source||'n/a'}`);

  const transcript=`Szeretnék a ${choice.location.name} szalonba ${choice.service.name} szolgáltatást ${choice.date} napra.`;
  const voice=await request(`${API}/api/public/marketing/booking/voice/interpret`,{
    method:'POST',headers:{...headersJson,'x-forwarded-for':'203.0.113.91'},body:JSON.stringify({transcript})
  });
  assert(voice.res.ok&&voice.body?.voice_event_id,`Voice interpret nem adott event id-t: ${voice.res.status} ${JSON.stringify(voice.body)}`);
  assert(voice.body?.intent?.intent==='book','A deterministic Voice intent nem book');
  voiceEventId=String(voice.body.voice_event_id);
  console.log(`✅ Voice event id — ${voiceEventId}`);

  const booking=await request(`${API}/api/public/marketing/booking/book`,{
    method:'POST',headers:headersJson,body:JSON.stringify({
      location_id:String(choice.location.id),employee_id:String(choice.slot.employee_id),service_ids:[String(choice.service.id)],
      client_name:'UAT Voice Correlation',email:'uat.voice.correlation@kleopatra.invalid',phone:'',marketing_consent:false,
      start_time:String(choice.slot.start),booking_source:'voice',voice_event_id:voiceEventId
    })
  });
  assert(booking.res.status===201,`Voice booking sikertelen: ${booking.res.status} ${JSON.stringify(booking.body)}`);
  assert(String(booking.body?.voice_event_id||'')===voiceEventId,'A booking response nem ugyanazt a voice_event_id-t adta vissza');
  assert(booking.body?.cancellation_token,'Nincs cancellation token');
  cancellationToken=String(booking.body.cancellation_token);
  const appointmentId=String(booking.body.id);
  console.log(`✅ Exact-correlated booking — appointment=${appointmentId}`);

  const stats=await request(`${API}/api/transactions/booking-voice-stats?days=30`,{headers:{authorization:`Bearer ${token}`}});
  assert(stats.res.ok,'Voice stats utómérés sikertelen');
  assert(stats.body?.tracking?.mode==='exact_voice_event_id','A stats tracking mode nem exact');
  const recent=(stats.body?.recent||[]).find(x=>String(x.id)===voiceEventId);
  assert(recent,'A friss Voice event nincs a recent listában');
  assert(recent.converted_to_booking===true,'A Voice event nincs booking konverzióként megjelölve');
  assert(String(recent.appointment_id||'')===appointmentId,'A recent Voice event rossz appointmenthez kapcsolódik');
  assert(Number(stats.body?.summary?.voice_booking_conversions||0)>=1,'Exact conversion KPI nem nőtt');
  console.log(`✅ Exact statisztika — conversion=${stats.body.summary.conversion_rate}% · coverage=${stats.body.summary.conversion_tracking_coverage}%`);

  const reuse=await request(`${API}/api/public/marketing/booking/waitlist`,{
    method:'POST',headers:headersJson,body:JSON.stringify({location_id:String(choice.location.id),client_name:'UAT Voice Correlation',email:'uat.voice.correlation@kleopatra.invalid',service_ids:[String(choice.service.id)],booking_source:'voice',voice_event_id:voiceEventId})
  });
  assert(reuse.res.status===409,`Az egyszer használható voice_event_id újrafelhasználása nem 409: ${reuse.res.status}`);
  console.log('✅ One-shot guard — ugyanaz a Voice event nem használható újra');

  const cancel=await request(`${API}/api/public/marketing/booking/cancel/${encodeURIComponent(cancellationToken)}`,{method:'POST',headers:headersJson,body:JSON.stringify({reason:'UAT exact Voice correlation cleanup'})});
  assert(cancel.res.ok,'UAT foglalás lemondása sikertelen');
  cancellationToken='';
  console.log('✅ UAT booking cleanup — cancelled');

  const afterCancel=await request(`${API}/api/transactions/booking-voice-stats?days=30`,{headers:{authorization:`Bearer ${token}`}});
  const recentCancelled=(afterCancel.body?.recent||[]).find(x=>String(x.id)===voiceEventId);
  assert(afterCancel.res.ok&&recentCancelled?.converted_to_booking===true,'Lemondás után elveszett a történeti exact konverzió');
  assert(['cancelled','canceled'].includes(String(recentCancelled?.booking_status||'').toLowerCase()),`Lemondott booking státusz nem látható: ${recentCancelled?.booking_status}`);
  console.log('✅ Történeti korreláció — lemondás után is megmarad');

  console.log('\nUAT PASS: exact Voice event → booking korreláció backend + frontend élő Render környezetben működik.');
}catch(error){
  if(cancellationToken){
    try{await request(`${API}/api/public/marketing/booking/cancel/${encodeURIComponent(cancellationToken)}`,{method:'POST',headers:headersJson,body:JSON.stringify({reason:'UAT cleanup hiba után'})});console.log('⚠️ UAT cleanup hibaágon lefutott');}catch{}
  }
  throw error;
}
