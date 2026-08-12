const API=(process.env.UAT_API_BASE||'https://kleoszalon-api-1.onrender.com').replace(/\/$/,'');
const ADMIN=process.env.UAT_ADMIN_IDENTIFIER||'admin1';
const PASSWORD=process.env.UAT_ADMIN_PASSWORD||'Teszt1234!';
const WORK_ORDER_ID=process.env.UAT_WORK_ORDER_ID||'5d1e1544-cfc8-4d8c-a469-18424483afd1';
const EXPECTED=['birtalan.zoltan1975@gmail.com','h.n.andrea@kleoszalon.hu'];
let token='';

async function request(path,{method='GET',body,auth=true}={}){
  const headers={Accept:'application/json'};
  if(body!==undefined)headers['Content-Type']='application/json';
  if(auth&&token)headers.Authorization=`Bearer ${token}`;
  const r=await fetch(`${API}${path}`,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
  const text=await r.text();let data=null;
  try{data=text?JSON.parse(text):null}catch{data={raw:text.slice(0,1600)}}
  if(!r.ok)throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(data).slice(0,1600)}`);
  return data;
}

function normalized(list){return [...new Set((Array.isArray(list)?list:[]).map(x=>String(x).trim().toLowerCase()).filter(Boolean))].sort()}

const health=await request('/api/health',{auth:false});
if(!health?.ok||health?.db?.ok!==true)throw new Error(`API/DB health nem OK: ${JSON.stringify(health)}`);
console.log('✅ API + DB health');

const login=await request('/api/login',{method:'POST',body:{identifier:ADMIN,password:PASSWORD},auth:false});
if(!login?.token)throw new Error(`Admin login nem adott tokent: ${JSON.stringify(login)}`);
token=login.token;
console.log(`✅ Admin belépés — ${ADMIN}`);

const result=await request(`/api/transactions/workorder-finalization/workorders/${encodeURIComponent(WORK_ORDER_ID)}/email`,{method:'POST',body:{}});
const mail=result?.mail||result?.delivery?.mail||{};
const actual=normalized(mail.recipients);
const expected=normalized(EXPECTED);
if(JSON.stringify(actual)!==JSON.stringify(expected)){
  throw new Error(`Címzett eltérés. expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)} response=${JSON.stringify(result).slice(0,1800)}`);
}
if(!(mail.sent||mail.logged||mail.already_sent)){
  throw new Error(`Az e-mail állapot nem pozitív: ${JSON.stringify(mail)}`);
}
console.log(`✅ Munkalap e-mail címzettek — ${actual.join(', ')}`);
console.log(`✅ Kézbesítési állapot — ${mail.sent?'sent':mail.logged?'logged':'already_sent'}`);
console.log(`\nUAT PASS: a régi demo cím helyett kizárólag a két kért címzett aktív. work_order=${WORK_ORDER_ID}`);
