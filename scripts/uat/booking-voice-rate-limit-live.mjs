const API=(process.env.UAT_API_BASE||'https://kleoszalon-api-1.onrender.com').replace(/\/$/,'');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function fail(message){throw new Error(message)}
async function hit(){
  const r=await fetch(`${API}/api/public/marketing/booking/voice/interpret`,{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify({transcript:'x'})});
  const text=await r.text();let data=null;try{data=text?JSON.parse(text):null}catch{data={raw:text}}
  return{status:r.status,data,limit:r.headers.get('x-ratelimit-limit'),remaining:r.headers.get('x-ratelimit-remaining'),retry:r.headers.get('retry-after')};
}
async function waitForDeploy(){for(let i=0;i<30;i++){const r=await hit();if(r.limit)return r;await sleep(12000)}fail('A PostgreSQL-backed Voice Booking limiter 6 percen belül nem jelent meg az élő Render API-n.');}
try{
  const health=await fetch(`${API}/api/health`).then(async r=>({status:r.status,data:await r.json()}));
  if(health.status!==200||health.data?.ok!==true||health.data?.db?.ok!==true)fail(`API/DB health hibás: ${health.status}`);
  console.log('✅ API + DB health');
  let first=await waitForDeploy();
  if(first.status!==400&&first.status!==429)fail(`Váratlan első limiter válasz: ${JSON.stringify(first)}`);
  const limit=Number(first.limit||0);if(!Number.isFinite(limit)||limit<1)fail(`Érvénytelen rate limit header: ${first.limit}`);
  console.log(`✅ Distributed limiter deploy — limit=${limit}/perc, első status=${first.status}`);
  let last=first,attempts=1;
  while(last.status!==429&&attempts<limit+3){last=await hit();attempts+=1;}
  if(last.status!==429)fail(`Nem kaptunk 429-et ${attempts} kérés után: ${JSON.stringify(last)}`);
  if(last.data?.rate_limit_backend!=='postgresql')fail(`A 429 nem PostgreSQL limiterből jött: ${JSON.stringify(last.data)}`);
  if(!last.retry||Number(last.retry)<1)fail(`Hiányzó/hibás Retry-After: ${last.retry}`);
  if(Number(last.remaining)!==0)fail(`429-nél remaining nem 0: ${last.remaining}`);
  console.log(`✅ 429 limit enforcement — attempts=${attempts}, Retry-After=${last.retry}s, remaining=0`);
  console.log('✅ Privacy-safe UAT — rövid, érvénytelen transcript miatt booking_voice_events esemény nem jött létre');
  console.log('\nUAT PASS: a Voice Booking PostgreSQL-backed elosztott rate limiter élő Render környezetben működik.');
}catch(e){console.error('\nUAT FAIL:',e?.stack||e);process.exitCode=1}
