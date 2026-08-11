const API=process.env.UAT_API_BASE||'https://kleoszalon-api-1.onrender.com';
const adminId=process.env.UAT_ADMIN_IDENTIFIER||'admin1';
const adminPassword=process.env.UAT_ADMIN_PASSWORD||'Teszt1234!';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const assert=(cond,msg)=>{if(!cond)throw new Error(msg)};

async function json(url,options={}){
  const res=await fetch(url,options);
  let body=null;try{body=await res.json()}catch{body=null}
  return{res,body};
}

async function waitForPricing(){
  const deadline=Date.now()+8*60_000;
  let last=null;
  while(Date.now()<deadline){
    const r=await json(`${API}/api/public/marketing/booking/voice/health`);
    last={status:r.res.status,body:r.body};
    if(r.res.ok&&r.body?.ai_cost_estimation?.resolved)return r.body;
    await sleep(10_000);
  }
  throw new Error(`AI cost deploy marker nem jelent meg időben: ${JSON.stringify(last)}`);
}

const health=await json(`${API}/api/health`);
assert(health.res.ok&&health.body?.db?.ok===true,'API/DB health nem PASS');
console.log('✅ API + DB health');

const voiceHealth=await waitForPricing();
assert(voiceHealth.ai_configured===true,'Voice AI nincs konfigurálva az élő környezetben');
assert(voiceHealth.ai_cost_estimation?.resolved===true,'Az aktív modell árazása nincs feloldva');
assert(Number(voiceHealth.ai_cost_estimation.input_usd_per_1m)>=0,'Input ár hiányzik');
assert(Number(voiceHealth.ai_cost_estimation.output_usd_per_1m)>=0,'Output ár hiányzik');
console.log(`✅ AI cost deploy — ${voiceHealth.model} · source=${voiceHealth.ai_cost_estimation.source}`);

const login=await json(`${API}/api/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({identifier:adminId,password:adminPassword})});
assert(login.res.ok&&login.body?.token,'DEMO admin belépés sikertelen');
const token=login.body.token;
const auth={authorization:`Bearer ${token}`};
console.log('✅ DEMO admin belépés');

const before=await json(`${API}/api/transactions/booking-voice-stats?days=30`,{headers:auth});
assert(before.res.ok,'Voice statisztika előmérés sikertelen');
const beforeCalls=Number(before.body?.ai?.calls||0);
const beforeCost=Number(before.body?.ai?.estimated_cost_usd||0);

const transcript='UAT költségmérés: jövő pénteken délután szeretnék időpontot, a szalon és a szolgáltatás még mindegy.';
const interpreted=await json(`${API}/api/public/marketing/booking/voice/interpret`,{
  method:'POST',
  headers:{'content-type':'application/json','x-forwarded-for':'203.0.113.84'},
  body:JSON.stringify({transcript})
});
assert(interpreted.res.ok,`Voice interpret sikertelen: HTTP ${interpreted.res.status} ${JSON.stringify(interpreted.body)}`);
console.log(`✅ Kontrollált Voice AI kérés — ai_used=${Boolean(interpreted.body?.ai_used)}`);

const after=await json(`${API}/api/transactions/booking-voice-stats?days=30`,{headers:auth});
assert(after.res.ok,'Voice statisztika utómérés sikertelen');
const afterCalls=Number(after.body?.ai?.calls||0);
const afterCost=Number(after.body?.ai?.estimated_cost_usd||0);
const deltaCalls=afterCalls-beforeCalls;
const deltaCost=afterCost-beforeCost;
assert(deltaCalls>=1,`AI usage log nem nőtt: before=${beforeCalls}, after=${afterCalls}`);
assert(deltaCost>0,`AI estimated_cost_usd nem nőtt: before=${beforeCost}, after=${afterCost}`);
console.log(`✅ AI usage/cost log — calls +${deltaCalls}, cost +$${deltaCost.toFixed(6)}`);

assert(voiceHealth.transcripts_stored===false,'Az élő Voice transcript tárolás váratlanul engedélyezett');
console.log('✅ Privacy — transcript_store=false');
console.log('\nUAT PASS: Voice Booking AI költségmérés élő Render környezetben működik.');
