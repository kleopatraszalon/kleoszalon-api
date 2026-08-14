const BASE="https://kleoszalon-api-1.onrender.com";
async function call(path,options={}){const r=await fetch(BASE+path,{...options,headers:{"content-type":"application/json","user-agent":"Kleopatra-Customer-Dashboard-Diag/1.0",...(options.headers||{})}});const text=await r.text();let body;try{body=JSON.parse(text)}catch{body={raw:text.slice(0,2000)}}return{status:r.status,body}}
const login=await call('/api/login',{method:'POST',body:JSON.stringify({identifier:'ugyfel1',password:'Teszt1234!'})});
console.log('LOGIN',login.status,JSON.stringify({role:login.body?.role,account_type:login.body?.account_type,has_token:Boolean(login.body?.token)}));
if(!login.body?.token)process.exit(1);
const dash=await call('/api/customer-portal/dashboard',{headers:{authorization:`Bearer ${login.body.token}`}});
console.log('DASHBOARD_STATUS',dash.status);
console.log('DASHBOARD_BODY',JSON.stringify(dash.body));
if(dash.status!==200)process.exitCode=1;
