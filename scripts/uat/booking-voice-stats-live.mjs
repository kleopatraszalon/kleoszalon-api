const API_BASE=(process.env.UAT_API_BASE||'https://kleoszalon-api-1.onrender.com').replace(/\/$/,'');
const FE_BASE=(process.env.UAT_FRONTEND_BASE||'https://kleoszalon-frontend.onrender.com').replace(/\/$/,'');
const ADMIN_IDENTIFIER=process.env.UAT_ADMIN_IDENTIFIER||'admin1';
const ADMIN_PASSWORD=process.env.UAT_ADMIN_PASSWORD||'Teszt1234!';
let token='';
const report=[];

function pass(name,detail=''){report.push({name,status:'PASS',detail});console.log(`✅ ${name}${detail?` — ${detail}`:''}`)}
function warn(name,detail=''){report.push({name,status:'WARN',detail});console.log(`⚠️ ${name}${detail?` — ${detail}`:''}`)}
function fail(message){throw new Error(message)}

async function raw(url,{method='GET',body,headers={}}={}){
  const h={Accept:'application/json',...headers};
  if(body!==undefined)h['Content-Type']='application/json';
  const r=await fetch(url,{method,headers:h,body:body===undefined?undefined:JSON.stringify(body),redirect:'follow'});
  const text=await r.text();
  let data=null;try{data=text?JSON.parse(text):null}catch{data={raw:text}}
  return{status:r.status,ok:r.ok,data,text,headers:r.headers,url:r.url};
}
async function api(path,opts={}){
  const headers={...(opts.headers||{})};if(opts.auth&&token)headers.Authorization=`Bearer ${token}`;
  return raw(`${API_BASE}${path}`,{...opts,headers});
}
function rolesOf(v){if(Array.isArray(v))return v.map(String).map(x=>x.toLowerCase());const s=String(v??'').trim();if(!s)return[];try{const p=JSON.parse(s);if(Array.isArray(p))return p.map(String).map(x=>x.toLowerCase());return[String(p).toLowerCase()]}catch{return s.split(',').map(x=>x.replace(/[\[\]"]/g,'').trim().toLowerCase()).filter(Boolean)}}
function findMenu(items,code){for(const item of Array.isArray(items)?items:[]){if(item?.code===code)return item;const hit=findMenu(item?.submenus||item?.children||[],code);if(hit)return hit}return null}

try{
  const health=await api('/api/health');
  if(health.status!==200||health.data?.ok!==true||health.data?.db?.ok!==true)fail(`API/DB health: ${health.status} ${JSON.stringify(health.data).slice(0,800)}`);
  pass('API + adatbázis health',String(health.data?.time||''));

  const voiceHealth=await api('/api/public/marketing/booking/voice/health');
  if(voiceHealth.status!==200||voiceHealth.data?.ok!==true)fail(`Voice health: ${voiceHealth.status} ${JSON.stringify(voiceHealth.data).slice(0,800)}`);
  pass('Voice Booking health',`AI=${voiceHealth.data?.ai_configured?'konfigurálva':'fallback'}, transcript_store=${Boolean(voiceHealth.data?.transcripts_stored)}`);

  const noAuth=await api('/api/transactions/booking-voice-stats?days=30');
  if(noAuth.status!==401)fail(`A stats API autentikáció nélkül nem 401-et adott, hanem ${noAuth.status}: ${JSON.stringify(noAuth.data).slice(0,500)}`);
  pass('Voice statisztika auth guard','401 hitelesítés nélkül');

  const login=await api('/api/login',{method:'POST',body:{identifier:ADMIN_IDENTIFIER,password:ADMIN_PASSWORD}});
  if(login.status!==200||!login.data?.token)fail(`DEMO admin belépés: ${login.status} ${JSON.stringify(login.data).slice(0,800)}`);
  token=String(login.data.token);
  const roles=rolesOf(login.data?.role??login.data?.user?.role);
  if(!roles.includes('admin'))fail(`A DEMO fiók nem admin szerepkörű: ${JSON.stringify(roles)}`);
  pass('DEMO admin belépés',`${ADMIN_IDENTIFIER} · admin`);

  const stats=await api('/api/transactions/booking-voice-stats?days=30',{auth:true});
  if(stats.status!==200)fail(`Voice stats API: ${stats.status} ${JSON.stringify(stats.data).slice(0,1200)}`);
  const s=stats.data;
  if(!s?.summary||!Array.isArray(s?.daily)||!Array.isArray(s?.locations)||!Array.isArray(s?.recent))fail(`Hiányos statisztikai payload: ${JSON.stringify(s).slice(0,1200)}`);
  if(s?.range?.days!==30)fail(`Hibás időszak: ${JSON.stringify(s?.range)}`);
  if(s?.privacy?.recent_transcripts_exposed!==false)fail(`Privacy guard hibás: ${JSON.stringify(s?.privacy)}`);
  for(const key of ['voice_requests','recognized','recognition_rate','ai_used','voice_bookings','online_bookings','conversion_rate'])if(!Number.isFinite(Number(s.summary[key])))fail(`Nem numerikus KPI: ${key}=${s.summary[key]}`);
  pass('Voice statisztika API 30 nap',`voice_requests=${s.summary.voice_requests}, recognized=${s.summary.recognized}, voice_bookings=${s.summary.voice_bookings}, online=${s.summary.online_bookings}`);
  pass('Voice privacy guard','transcript nincs a recent eseménylistában');

  const stats7=await api('/api/transactions/booking-voice-stats?days=7',{auth:true});
  if(stats7.status!==200||stats7.data?.range?.days!==7||!Array.isArray(stats7.data?.daily))fail(`7 napos szűrés hibás: ${stats7.status} ${JSON.stringify(stats7.data).slice(0,800)}`);
  pass('Időszak szűrés','7 nap');

  const firstLocation=(Array.isArray(s.locations)?s.locations:[]).find(x=>x?.location_id);
  if(firstLocation){
    const loc=await api(`/api/transactions/booking-voice-stats?days=30&location_id=${encodeURIComponent(firstLocation.location_id)}`,{auth:true});
    if(loc.status!==200||String(loc.data?.range?.location_id)!==String(firstLocation.location_id))fail(`Telephelyszűrés hibás: ${loc.status} ${JSON.stringify(loc.data?.range)}`);
    pass('Telephely szerinti szűrés',String(firstLocation.name||firstLocation.location_id));
  }else warn('Telephely szerinti szűrés','nincs aktív telephely a statisztikai payloadban');

  let menuResponse=null;
  for(const p of ['/api/menus','/api/menu']){const r=await api(p,{auth:true});if(r.status===200&&Array.isArray(r.data)){menuResponse=r;break}}
  if(!menuResponse)fail('Az admin menü API egyik ismert útvonala sem adott listát.');
  const voiceMenu=findMenu(menuResponse.data,'appointments.voice_stats');
  if(!voiceMenu)fail('Az appointments.voice_stats menüpont nem jelent meg az admin menüben.');
  if(String(voiceMenu.route)!=='/appointments/voice-booking-stats')fail(`A Voice stat menü route hibás: ${voiceMenu.route}`);
  pass('VIR menüpont + RBAC bootstrap',`${voiceMenu.name} → ${voiceMenu.route}`);

  const page=await raw(`${FE_BASE}/appointments/voice-booking-stats`,{headers:{Accept:'text/html'}});
  if(page.status!==200||!/<div[^>]+id=["']root["']/.test(page.text))fail(`Frontend route nem SPA oldalt adott: ${page.status}`);
  pass('Frontend management route','HTTP 200 SPA shell');

  const srcs=[...page.text.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map(m=>m[1]);
  let deployedRoute=false;
  for(const src of srcs){
    const js=await raw(new URL(src,FE_BASE).toString(),{headers:{Accept:'*/*'}});
    if(js.status===200&&(js.text.includes('/appointments/voice-booking-stats')||js.text.includes('Voice Booking statisztika'))){deployedRoute=true;break}
  }
  if(!deployedRoute)fail(`A deployolt JS bundle nem tartalmazza az 1E Voice Booking statisztika útvonalát. Vizsgált bundle-ok: ${srcs.length}`);
  pass('Frontend 1E deploy igazolás','a deployolt JS bundle tartalmazza a Voice Booking statisztika route-ot');

  console.log('\n=== VOICE BOOKING 1E LIVE UAT SUMMARY ===');
  for(const x of report)console.log(`${x.status.padEnd(4)} ${x.name}${x.detail?` :: ${x.detail}`:''}`);
  const warnings=report.filter(x=>x.status==='WARN');
  if(warnings.length){console.error(`\nUAT WARN: ${warnings.length} figyelmeztetés.`);process.exitCode=2}else console.log('\nUAT PASS: az 1E Voice Booking statisztika élő Render környezetben végigment.');
}catch(error){
  console.error('\nUAT FAIL:',error?.stack||error);
  process.exitCode=1;
}
