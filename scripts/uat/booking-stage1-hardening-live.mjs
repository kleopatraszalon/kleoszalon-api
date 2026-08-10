const API=(process.env.UAT_API_BASE||'https://kleoszalon-api-1.onrender.com').replace(/\/$/,'');
const FE=(process.env.UAT_FRONTEND_BASE||'https://kleoszalon-frontend.onrender.com').replace(/\/$/,'');
const ADMIN=process.env.UAT_ADMIN_IDENTIFIER||'admin1';
const ADMIN_PASSWORD=process.env.UAT_ADMIN_PASSWORD||'Teszt1234!';
const CUSTOMER=process.env.UAT_CUSTOMER_IDENTIFIER||'ugyfel1';
const CUSTOMER_PASSWORD=process.env.UAT_CUSTOMER_PASSWORD||'Teszt1234!';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const pad=n=>String(n).padStart(2,'0');
const budapestDate=d=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Budapest',year:'numeric',month:'2-digit',day:'2-digit'}).format(d);
const futureDate=n=>budapestDate(new Date(Date.now()+n*86400000));
const report=[];
let adminToken='',customerToken='',booking=null,cancelToken='',shiftId='',originalCommSettings=null,commSettingsChanged=false;
function log(name,status='PASS',detail=''){report.push({name,status,detail});console.log(`${status==='PASS'?'✅':status==='WARN'?'⚠️':'❌'} ${name}${detail?` — ${detail}`:''}`)}
function fail(msg){throw new Error(msg)}
async function request(path,{method='GET',body,token,allow404=false}={}){const h={Accept:'application/json'};if(body!==undefined)h['Content-Type']='application/json';if(token)h.Authorization=`Bearer ${token}`;const r=await fetch(`${API}${path}`,{method,headers:h,body:body===undefined?undefined:JSON.stringify(body)});const text=await r.text();let data=null;try{data=text?JSON.parse(text):null}catch{data={raw:text.slice(0,1000)}}if(!r.ok&&!(allow404&&r.status===404)){const e=new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(data).slice(0,1200)}`);e.status=r.status;e.data=data;throw e}return{status:r.status,data,text}}
async function login(identifier,password){const r=await request('/api/login',{method:'POST',body:{identifier,password}});if(!r.data?.token)fail(`Belépés nem adott tokent: ${identifier}`);return r.data}
async function catalog(locationId=''){return(await request(`/api/public/marketing/booking/catalog${locationId?`?location_id=${encodeURIComponent(locationId)}`:''}`)).data}
async function availability(locationId,date,serviceId,employeeId='',exclude=''){const p=new URLSearchParams({location_id:locationId,date,service_ids:serviceId});if(employeeId)p.set('employee_id',employeeId);if(exclude)p.set('exclude_appointment_id',exclude);return(await request(`/api/public/marketing/booking/availability?${p}`)).data}
async function findSlot(){const root=await catalog();const all=Array.isArray(root?.locations)?root.locations:[];const locations=[...all].sort((a,b)=>(/^DEMO/i.test(b.name)?1:0)-(/^DEMO/i.test(a.name)?1:0));for(const location of locations.slice(0,10)){const c=await catalog(location.id);for(const service of (c.services||[]).slice(0,30)){for(let d=2;d<=24;d++){const date=futureDate(d);const a=await availability(location.id,date,service.id);if(a?.slots?.length)return{location,service,date,slot:a.slots[0],catalog:c,availability:a};}}}throw new Error('Nem található UAT-hoz foglalható slot 24 napon belül.');}
async function waitForDeploy(selected){const marker='00000000-0000-4000-8000-000000000001';for(let i=0;i<30;i++){try{const a=await availability(selected.location.id,selected.date,selected.service.id,selected.slot.employee_id,marker);const proc=await request('/api/transactions/booking-communications/process',{method:'POST',token:adminToken});if(a?.excludes_current_appointment===true&&Object.prototype.hasOwnProperty.call(proc.data||{},'suppressed')&&Object.prototype.hasOwnProperty.call(proc.data||{},'retry_scheduled'))return;}catch{}await sleep(12000)}fail('A frissen merge-elt hardening backend nem jelent meg Renderen 6 percen belül.');}
async function waitForFrontend(){for(let i=0;i<25;i++){try{const page=await fetch(`${FE}/customer/booking`,{headers:{Accept:'text/html'}});const html=await page.text();const srcs=[...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map(m=>m[1]);for(const src of srcs){const js=await fetch(new URL(src,FE));const text=await js.text();if(text.includes('exclude_appointment_id'))return true}}catch{}await sleep(12000)}return false}
async function cleanup(){if(shiftId){try{await request(`/api/timetable/shifts/${encodeURIComponent(shiftId)}`,{method:'DELETE',token:adminToken});console.log('🧹 UAT műszak visszavonva.')}catch(e){console.warn('⚠️ shift cleanup:',e.message)}}if(commSettingsChanged&&originalCommSettings){try{await request('/api/transactions/booking-communications/settings',{method:'PUT',token:adminToken,body:{...originalCommSettings,location_id:originalCommSettings.location_id}});console.log('🧹 Kommunikációs beállítások visszaállítva.')}catch(e){console.warn('⚠️ communication settings cleanup:',e.message)}}if(cancelToken){try{await request(`/api/public/marketing/booking/cancel/${encodeURIComponent(cancelToken)}`,{method:'POST',body:{reason:'Automatikus Stage1 hardening UAT cleanup'},allow404:true});console.log('🧹 UAT foglalás lemondva.')}catch(e){console.warn('⚠️ booking cleanup:',e.message)}}}
try{
 const health=await request('/api/health');if(!health.data?.ok||health.data?.db?.ok!==true)fail('API/DB health nem OK');log('API + DB health');
 const aLogin=await login(ADMIN,ADMIN_PASSWORD);adminToken=aLogin.token;log('Admin belépés', 'PASS', ADMIN);
 const cLogin=await login(CUSTOMER,CUSTOMER_PASSWORD);customerToken=cLogin.token;log('Ügyfél belépés','PASS',CUSTOMER);
 const selected=await findSlot();log('UAT alap-slot', 'PASS', `${selected.location.name} · ${selected.service.name} · ${selected.date}`);
 await waitForDeploy(selected);log('Hardening backend deploy','PASS','exclude marker + új queue summary aktív');
 const feOk=await waitForFrontend();if(feOk)log('Hardening frontend deploy','PASS','exclude_appointment_id benne van a deployolt bundle-ben');else log('Hardening frontend deploy','WARN','6 percen belül nem találtam az új bundle markert');

 booking=(await request('/api/public/marketing/booking/book',{method:'POST',body:{location_id:selected.location.id,employee_id:selected.slot.employee_id,service_ids:[selected.service.id],client_name:'DEMO Kiss Anna',phone:'+36 30 555 0101',email:'demo.ugyfel@kleoszalon.hu',start_time:selected.slot.start,booking_source:'online',marketing_consent:false,note:'Stage1 hardening élő UAT'}})).data;cancelToken=String(booking?.cancellation_token||'');if(!booking?.id||!cancelToken)fail(`UAT booking hiányos: ${JSON.stringify(booking)}`);log('UAT foglalás létrehozása','PASS',String(booking.id));
 const without=await availability(selected.location.id,selected.date,selected.service.id,selected.slot.employee_id);
 const withEx=await availability(selected.location.id,selected.date,selected.service.id,selected.slot.employee_id,String(booking.id));
 const exact=x=>Array.isArray(x?.slots)&&x.slots.some(s=>String(s.start)===String(selected.slot.start)&&String(s.employee_id)===String(selected.slot.employee_id));
 if(exact(without))fail('A saját foglalás exclusion nélkül nem blokkolta az eredeti slotot.');
 if(!exact(withEx)||withEx?.excludes_current_appointment!==true)fail('Az exclude_appointment_id nem tette újra láthatóvá az áthelyezett foglalás saját slotját.');
 log('Ügyfél-áthelyezés availability exclusion','PASS','saját slot csak exclusion mellett látható');

 let shiftDate='';
 for(let d=10;d<=35;d++){const date=futureDate(d);const day=new Date(`${date}T12:00:00Z`).getUTCDay();if(day===0||day===6)continue;const sch=await request(`/api/timetable/schedule?from=${date}&to=${date}&location_id=${encodeURIComponent(selected.location.id)}`,{token:adminToken});const active=(sch.data?.shifts||[]).filter(s=>s.status!=='cancelled');if(active.length===0){shiftDate=date;break}}
 if(!shiftDate)fail('Nem találtam üres DEMO beosztási napot a published_shifts UAT-hoz.');
 const start=new Date(`${shiftDate}T10:00:00+02:00`),end=new Date(`${shiftDate}T14:00:00+02:00`);
 const createdShift=(await request('/api/timetable/shifts',{method:'POST',token:adminToken,body:{employee_id:selected.slot.employee_id,location_id:selected.location.id,work_date:shiftDate,starts_at:start.toISOString(),ends_at:end.toISOString(),break_minutes:0,shift_type:'regular',legal_override_reason:'Automatikus technikai UAT – azonnali visszavonással',note:'Stage1 published_shifts live UAT'}})).data;shiftId=String(createdShift?.id||'');if(!shiftId)fail('UAT műszak nem jött létre.');
 await request(`/api/timetable/shifts/${encodeURIComponent(shiftId)}`,{method:'PATCH',token:adminToken,body:{status:'published',legal_override_reason:'Automatikus technikai UAT – azonnali visszavonással'}});
 const pub=await availability(selected.location.id,shiftDate,selected.service.id,selected.slot.employee_id);
 if(pub?.schedule_source!=='published_shifts')fail(`Nem published_shifts source: ${JSON.stringify(pub).slice(0,800)}`);
 if(!Array.isArray(pub.slots)||!pub.slots.length)fail('A publikált UAT műszak nem adott foglalható slotot.');
 if(pub.slots.some(s=>new Date(s.start)<start||new Date(s.end)>end))fail('Availability slot kicsúszott a publikált műszakból.');
 log('Published shifts élő availability','PASS',`${shiftDate} 10:00–14:00 · ${pub.slots.length} slot`);
 await request(`/api/timetable/shifts/${encodeURIComponent(shiftId)}`,{method:'DELETE',token:adminToken});shiftId='';log('Published shift UAT cleanup','PASS','műszak cancelled');

 const settings=await request(`/api/transactions/booking-communications/settings?location_id=${encodeURIComponent(selected.location.id)}`,{token:adminToken});originalCommSettings=settings.data||null;
 if(originalCommSettings){await request('/api/transactions/booking-communications/settings',{method:'PUT',token:adminToken,body:{...originalCommSettings,location_id:selected.location.id,confirmation_enabled:true,email_channel_enabled:false,sms_channel_enabled:true}});commSettingsChanged=true;log('Kommunikációs UAT csatorna','PASS','DEMO helyen ideiglenesen SMS-re állítva');}
 const rq=await request(`/api/transactions/booking-communications/appointments/${encodeURIComponent(booking.id)}/requeue`,{method:'POST',token:adminToken,body:{event:'rescheduled'}});if(Number(rq.data?.queued||0)<1)log('Kommunikáció újrasorba állítás','WARN',JSON.stringify(rq.data));else log('Kommunikáció újrasorba állítás','PASS',`${rq.data.queued} db`);
 const processed=await request('/api/transactions/booking-communications/process',{method:'POST',token:adminToken});
 if(!['number','string'].includes(typeof processed.data?.processed))fail(`Régi/hibás queue worker summary: ${JSON.stringify(processed.data)}`);
 const queues=await request(`/api/transactions/booking-communications/queue?location_id=${encodeURIComponent(selected.location.id)}`,{token:adminToken});const item=(queues.data||[]).find(q=>String(q.appointment_id)===String(booking.id)&&q.event_type==='booking_rescheduled');
 if(item){const status=String(item.status);if(status==='pending'&&!/újrapróbálás|ujraprobalas/i.test(String(item.error_text||'')))fail(`Pending queue retry magyarázat nélkül: ${JSON.stringify(item).slice(0,800)}`);if(!['sent','suppressed','pending','failed'].includes(status))fail(`Váratlan queue status: ${status}`);log('Kommunikációs queue terminális/retry viselkedés','PASS',`${status} · attempt=${item.attempt_count}`)}else log('Kommunikációs queue esemény','WARN','a worker gyorsabban feldolgozta / nem található a lekért 300 rekord között');
 if(commSettingsChanged&&originalCommSettings){await request('/api/transactions/booking-communications/settings',{method:'PUT',token:adminToken,body:{...originalCommSettings,location_id:selected.location.id}});commSettingsChanged=false;log('Kommunikációs beállítások visszaállítása');}

 await request(`/api/public/marketing/booking/cancel/${encodeURIComponent(cancelToken)}`,{method:'POST',body:{reason:'Stage1 hardening UAT kész'}});cancelToken='';log('UAT foglalás cleanup','PASS','lemondva');
 console.log('\n=== BOOKING STAGE1 HARDENING LIVE UAT ===');for(const x of report)console.log(`${x.status.padEnd(4)} ${x.name}${x.detail?` :: ${x.detail}`:''}`);const warns=report.filter(x=>x.status==='WARN');if(warns.length){console.error(`\nUAT PASS ${warns.length} figyelmeztetéssel.`);process.exitCode=2}else console.log('\nUAT PASS: published_shifts + reschedule exclusion + communication queue hardening élőben ellenőrizve.');
}catch(e){console.error('\nUAT FAIL:',e?.stack||e);process.exitCode=1}finally{await cleanup()}
