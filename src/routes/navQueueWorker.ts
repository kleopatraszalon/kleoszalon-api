import {Router} from 'express';
import db from '../db';
import {requireAuth,AuthRequest} from '../middleware/auth';
import {requireManagement} from '../middleware/requireRoles';
import {getNavQueueWorkerStatus,runNavQueueWorkerOnce,startNavQueueWorker} from '../nav/navQueueWorker';

const router=Router();
if(process.env.NODE_ENV!=='test')startNavQueueWorker();
router.use(requireAuth,requireManagement);
const truthy=(v:any)=>/^(1|true|yes|on)$/i.test(String(v||'').trim());
const digits=(v:any)=>String(v||'').replace(/\D/g,'');

async function selectedConfig(locationId:string){
  return (await db.query(`SELECT * FROM nav_online_invoice_settings WHERE active=true AND ($1::text='' OR location_id::text=$1 OR location_id IS NULL) ORDER BY CASE WHEN location_id::text=$1 THEN 0 ELSE 1 END LIMIT 1`,[locationId])).rows[0]||null;
}
function safeAutomation(c:any){
  if(!c)return null;
  const env=String(c.environment||'test');
  const credentialPresence={
    technical_login:Boolean(process.env.NAV_TECHNICAL_LOGIN||c.technical_login),
    technical_password:Boolean(process.env.NAV_TECHNICAL_PASSWORD||c.technical_password),
    signing_key:Boolean(process.env.NAV_SIGNING_KEY||c.signing_key),
    exchange_key:Boolean(process.env.NAV_EXCHANGE_KEY||c.exchange_key)
  };
  return{
    id:String(c.id),location_id:c.location_id?String(c.location_id):null,environment:env,
    auto_submit:Boolean(c.auto_submit),auto_refresh:Boolean(c.auto_refresh),auto_submit_test_only:Boolean(c.auto_submit_test_only),
    credentials_configured:credentialPresence,
    live_submit_enabled:Boolean(c.live_submit_enabled),
    live_env_gate:truthy(process.env.NAV_LIVE_SUBMIT_ENABLED),
    live_secrets_in_environment:['NAV_TECHNICAL_LOGIN','NAV_TECHNICAL_PASSWORD','NAV_SIGNING_KEY','NAV_EXCHANGE_KEY'].every(k=>Boolean(String(process.env[k]||'').trim()))
  };
}
function readiness(c:any,worker:any){
  const checks:any[]=[];
  const add=(id:string,label:string,ok:boolean,source:'local'|'nav'|'deployment',blocking=true)=>checks.push({id,label,ok,source,blocking});
  if(!c){
    add('config','Aktív NAV Online Számla konfiguráció',false,'local');
    return{ready_for_test:false,ready_for_live:false,checks,missing:checks.filter(x=>!x.ok).map(x=>x.id),nav_required:['technical_login','technical_password','xml_signing_key','xml_exchange_key']};
  }
  const safe=safeAutomation(c)!;
  const issuerTax=digits(c.supplier_tax_number);
  add('supplier_name','Kibocsátó hivatalos neve',Boolean(String(c.supplier_name||'').trim()),'local');
  add('supplier_tax_number','Kibocsátó 11 számjegyű adószáma',issuerTax.length===11,'local');
  add('supplier_address','Kibocsátó teljes címe',Boolean(String(c.supplier_postal_code||'').trim()&&String(c.supplier_city||'').trim()&&String(c.supplier_address||'').trim()),'local');
  add('invoice_prefix','Számlaprefix',Boolean(String(c.invoice_prefix||'').trim()),'local');
  add('software_id','Számlázóprogram azonosító',Boolean(String(c.software_id||'').trim()),'local');
  add('technical_login','NAV technikai felhasználónév',safe.credentials_configured.technical_login,'nav');
  add('technical_password','NAV technikai jelszó',safe.credentials_configured.technical_password,'nav');
  add('xml_signing_key','NAV XML aláírókulcs',safe.credentials_configured.signing_key,'nav');
  add('xml_exchange_key','NAV XML cserekulcs',safe.credentials_configured.exchange_key,'nav');
  add('worker','Automatikus NAV queue worker telepítve és engedélyezve',Boolean(worker?.enabled),'local');
  add('auto_refresh','Automatikus NAV státuszfrissítés engedélyezve',Boolean(c.auto_refresh),'local');
  const baseReady=checks.filter(x=>x.blocking&&['local','nav'].includes(x.source)).every(x=>x.ok);
  const testEnvironment=String(c.environment)==='test';
  add('test_environment','Aktív konfiguráció TEST környezetben',testEnvironment,'local');
  const readyForTest=baseReady&&testEnvironment;
  const liveEnvironment=String(c.environment)==='live';
  add('live_environment','Aktív konfiguráció LIVE környezetben',liveEnvironment,'deployment');
  add('live_db_gate','DB live_submit_enabled kapu',Boolean(c.live_submit_enabled),'deployment');
  add('live_env_gate','NAV_LIVE_SUBMIT_ENABLED deployment kapu',safe.live_env_gate,'deployment');
  add('live_secrets','Mind a négy NAV hitelesítő adat deployment secretként van tárolva',safe.live_secrets_in_environment,'deployment');
  add('live_auto_test_only_off','TEST-only automatikus küldés kikapcsolva',!Boolean(c.auto_submit_test_only),'deployment');
  const liveChecks=checks.filter(x=>x.blocking&&x.id!=='test_environment');
  const readyForLive=liveChecks.every(x=>x.ok);
  return{
    ready_for_test:readyForTest,
    ready_for_live:readyForLive,
    environment:String(c.environment),
    checks,
    missing:checks.filter(x=>x.blocking&&!x.ok).map(x=>x.id),
    nav_required:['technical_login','technical_password','xml_signing_key','xml_exchange_key'],
    external_validation_required:['NAV TEST tokenExchange','NAV TEST manageInvoice CREATE','NAV TEST queryTransactionStatus DONE','NAV TEST MODIFY','NAV TEST STORNO','könyvelői számlakép/ÁFA ellenőrzés','első kontrollált LIVE pilot']
  };
}

router.get('/go-live-readiness',async(req:AuthRequest,res,next)=>{try{
  const locationId=String(req.query.location_id||req.user?.location_id||'').trim();
  const [config,worker]=await Promise.all([selectedConfig(locationId),getNavQueueWorkerStatus()]);
  res.json({ok:true,readiness:readiness(config,worker),automation:safeAutomation(config)});
}catch(e){next(e)}});

router.get('/queue-worker/status',async(req:AuthRequest,res,next)=>{try{
  const locationId=String(req.query.location_id||req.user?.location_id||'').trim();
  const [worker,config,counts]=await Promise.all([
    getNavQueueWorkerStatus(),
    selectedConfig(locationId),
    db.query(`SELECT q.status,COUNT(*)::int count FROM nav_invoice_queue q JOIN finance_invoices i ON i.id=q.invoice_id WHERE ($1::text='' OR i.location_id::text=$1 OR i.location_id IS NULL) GROUP BY q.status ORDER BY q.status`,[locationId])
  ]);
  res.json({ok:true,worker,automation:safeAutomation(config),queue_counts:counts.rows});
}catch(e){next(e)}});

router.post('/queue-worker/run-now',async(_req,res,next)=>{try{res.json(await runNavQueueWorkerOnce())}catch(e){next(e)}});

router.get('/automation',async(req:AuthRequest,res,next)=>{try{
  const locationId=String(req.query.location_id||req.user?.location_id||'').trim();
  res.json({ok:true,automation:safeAutomation(await selectedConfig(locationId)),worker:await getNavQueueWorkerStatus()});
}catch(e){next(e)}});

router.put('/automation',async(req:AuthRequest,res,next)=>{try{
  const locationId=String(req.body?.location_id||req.user?.location_id||'').trim();
  const c=await selectedConfig(locationId);
  if(!c)return res.status(409).json({ok:false,message:'Először NAV Online Számla konfiguráció szükséges.'});
  const autoSubmit=Boolean(req.body?.auto_submit),autoRefresh=req.body?.auto_refresh===undefined?Boolean(c.auto_refresh):Boolean(req.body.auto_refresh),testOnly=req.body?.auto_submit_test_only===undefined?Boolean(c.auto_submit_test_only):Boolean(req.body.auto_submit_test_only);
  const safe=safeAutomation(c)!;
  if(autoSubmit){
    const credentialsReady=Object.values(safe.credentials_configured).every(Boolean);
    if(!credentialsReady)return res.status(409).json({ok:false,error:'nav_credentials_missing',message:'Az automatikus NAV beküldés csak teljes technikai hitelesítő adatkészlettel kapcsolható be.'});
    if(String(c.environment)==='live'){
      if(testOnly)return res.status(409).json({ok:false,error:'nav_auto_test_only',message:'Éles környezetben az auto_submit_test_only kapcsolót előbb tudatosan ki kell kapcsolni.'});
      if(!safe.live_submit_enabled||!safe.live_env_gate||!safe.live_secrets_in_environment)return res.status(409).json({ok:false,error:'nav_live_automation_locked',message:'Éles automatikus beküldéshez a DB live_submit_enabled, a NAV_LIVE_SUBMIT_ENABLED deployment kapu és a négy NAV secret környezeti változó egyaránt szükséges.'});
    }
  }
  const updated=(await db.query(`UPDATE nav_online_invoice_settings SET auto_submit=$2,auto_refresh=$3,auto_submit_test_only=$4,updated_at=now() WHERE id=$1::uuid RETURNING *`,[c.id,autoSubmit,autoRefresh,testOnly])).rows[0];
  res.json({ok:true,automation:safeAutomation(updated)});
}catch(e){next(e)}});

router.post('/queue/:id/retry',async(req,res,next)=>{try{
  const q=(await db.query(`UPDATE nav_invoice_queue SET status='queued',attempts=0,next_attempt_at=now(),completed_at=NULL,last_error=NULL,last_error_code=NULL,last_result=NULL,updated_at=now() WHERE id=$1::uuid AND status IN ('error','cancelled') RETURNING *`,[req.params.id])).rows[0];
  if(!q)return res.status(409).json({ok:false,message:'Csak hibás vagy megszakított NAV sor tétel indítható újra.'});
  await db.query(`UPDATE finance_invoices SET nav_queue_status='queued' WHERE id=$1::uuid`,[q.invoice_id]).catch(()=>undefined);
  res.json({ok:true,queue:q});
}catch(e){next(e)}});

router.post('/queue/:id/cancel',async(req,res,next)=>{try{
  const q=(await db.query(`UPDATE nav_invoice_queue SET status='cancelled',completed_at=now(),last_error=COALESCE($2,last_error),last_error_code='MANUAL_CANCEL',updated_at=now() WHERE id=$1::uuid AND status IN ('queued','processing') RETURNING *`,[req.params.id,String(req.body?.reason||'Kézi megszakítás').slice(0,1000)])).rows[0];
  if(!q)return res.status(409).json({ok:false,message:'A NAV sor tétel ebben az állapotban nem szakítható meg.'});
  await db.query(`UPDATE finance_invoices SET nav_queue_status='cancelled' WHERE id=$1::uuid`,[q.invoice_id]).catch(()=>undefined);
  res.json({ok:true,queue:q});
}catch(e){next(e)}});

export default router;
