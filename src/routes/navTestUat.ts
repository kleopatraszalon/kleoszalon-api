import {NextFunction,Request,Response,Router} from 'express';
import crypto from 'crypto';
import db from '../db';
import {AuthRequest} from '../middleware/auth';

const router=Router();
const actor=(req:AuthRequest)=>req.user?.email||String(req.user?.id||'');
const tag=()=>`NAV-UAT-${new Date().toISOString().replace(/\D/g,'').slice(0,14)}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
const masked=(v:any)=>String(v||'').trim()==='********';
const keepSecret=(incoming:any,current:any)=>{
  const next=String(incoming||'').trim();
  if(!next||masked(next))return current||null;
  return next;
};
const safeConfig=(row:any)=>row?{
  id:String(row.id),
  location_id:row.location_id?String(row.location_id):null,
  active:Boolean(row.active),
  environment:String(row.environment),
  supplier_name:row.supplier_name||'',
  supplier_tax_number:row.supplier_tax_number||'',
  supplier_country_code:row.supplier_country_code||'HU',
  supplier_postal_code:row.supplier_postal_code||'',
  supplier_city:row.supplier_city||'',
  supplier_address:row.supplier_address||'',
  invoice_prefix:row.invoice_prefix||'KLEO',
  software_id:row.software_id||'KLEOSZALONVIR0001',
  technical_login:process.env.NAV_TECHNICAL_LOGIN||row.technical_login||'',
  technical_password_configured:Boolean(process.env.NAV_TECHNICAL_PASSWORD||row.technical_password),
  signing_key_configured:Boolean(process.env.NAV_SIGNING_KEY||row.signing_key),
  exchange_key_configured:Boolean(process.env.NAV_EXCHANGE_KEY||row.exchange_key),
  credential_source:{
    technical_login:process.env.NAV_TECHNICAL_LOGIN?'environment':'database',
    technical_password:process.env.NAV_TECHNICAL_PASSWORD?'environment':'database',
    signing_key:process.env.NAV_SIGNING_KEY?'environment':'database',
    exchange_key:process.env.NAV_EXCHANGE_KEY?'environment':'database'
  },
  test_ready:String(row.environment)==='test'&&Boolean(process.env.NAV_TECHNICAL_LOGIN||row.technical_login)&&Boolean(process.env.NAV_TECHNICAL_PASSWORD||row.technical_password)&&Boolean(process.env.NAV_SIGNING_KEY||row.signing_key)&&Boolean(process.env.NAV_EXCHANGE_KEY||row.exchange_key),
  live_submission_blocked:true
}:null;

async function selectedConfig(locationId:string){
  const q=await db.query(`SELECT * FROM nav_online_invoice_settings WHERE active=true AND ($1::text='' OR location_id::text=$1 OR location_id IS NULL) ORDER BY CASE WHEN location_id::text=$1 THEN 0 ELSE 1 END LIMIT 1`,[locationId]);
  return q.rows[0]||null;
}

/**
 * Hard safety gate for automated NAV UAT. Production routes ignore this middleware
 * unless the caller explicitly sets uat_test_only=true. In UAT mode submission is
 * physically blocked unless BOTH the prepared submission and the currently selected
 * NAV configuration point to the test environment.
 */
export async function navTestOnlySubmitGuard(req:Request,res:Response,next:NextFunction){
  try{
    if(req.method!=='POST'||req.body?.uat_test_only!==true||!/^\/submissions\/[^/]+\/submit\/?$/.test(req.path))return next();
    const submissionId=decodeURIComponent(req.path.split('/')[2]||'');
    const q=await db.query(`SELECT s.id,s.environment,i.location_id::text FROM nav_invoice_submissions s JOIN finance_invoices i ON i.id=s.invoice_id WHERE s.id=$1::uuid LIMIT 1`,[submissionId]);
    const s=q.rows[0];
    if(!s)return res.status(404).json({ok:false,message:'NAV UAT: a beküldés nem található.'});
    const c=await selectedConfig(String(s.location_id||''));
    if(String(s.environment)!=='test'||String(c?.environment)!=='test')return res.status(409).json({ok:false,error:'nav_uat_live_blocked',message:'NAV UAT biztonsági blokkolás: automatizált UAT kizárólag a NAV tesztkörnyezetbe küldhet.',submission_environment:s.environment||null,configured_environment:c?.environment||null});
    res.setHeader('X-NAV-UAT-Safety','test-only');
    next();
  }catch(e){next(e)}
}

router.get('/configuration',async(req:AuthRequest,res,next)=>{
  try{
    const requested=String(req.query.location_id||req.user?.location_id||'').trim();
    const active=await selectedConfig(requested);
    const inactive=active?null:(await db.query(`SELECT * FROM nav_online_invoice_settings WHERE environment='test' AND ($1::text='' AND location_id IS NULL OR location_id::text=$1) ORDER BY updated_at DESC LIMIT 1`,[requested])).rows[0]||null;
    const row=active||inactive;
    res.json({ok:true,configured:Boolean(row),config:safeConfig(row),active:Boolean(active),test_only:true,live_configuration_write_blocked:true,protected_live_config:Boolean(row&&String(row.environment)==='live')});
  }catch(e){next(e)}
});

router.put('/configuration',async(req:AuthRequest,res,next)=>{
  const c=await db.connect();
  try{
    if(req.body?.environment&&String(req.body.environment).toLowerCase()!=='test')return res.status(409).json({ok:false,error:'nav_uat_live_blocked',message:'A NAV UAT konfigurációs végpont kizárólag a tesztkörnyezetet engedélyezi.'});
    const requested=String(req.body?.location_id||req.user?.location_id||'').trim();
    const locationId=requested||null;
    const supplierName=String(req.body?.supplier_name||'').trim();
    const supplierTaxNumber=String(req.body?.supplier_tax_number||'').replace(/\D/g,'');
    const postalCode=String(req.body?.supplier_postal_code||'').trim();
    const city=String(req.body?.supplier_city||'').trim();
    const address=String(req.body?.supplier_address||'').trim();
    const invoicePrefix=String(req.body?.invoice_prefix||'KLEO').trim().toUpperCase().replace(/[^A-Z0-9_-]/g,'').slice(0,20)||'KLEO';
    if(!supplierName||supplierTaxNumber.length!==11||!postalCode||!city||!address)return res.status(400).json({ok:false,message:'A teszt NAV konfigurációhoz kibocsátó név, 11 számjegyű adószám, irányítószám, város és cím szükséges.'});

    await c.query('BEGIN');
    const existing=(await c.query(`SELECT * FROM nav_online_invoice_settings WHERE location_id IS NOT DISTINCT FROM $1::uuid ORDER BY updated_at DESC LIMIT 1 FOR UPDATE`,[locationId])).rows[0]||null;
    if(existing&&String(existing.environment)!=='test'){
      await c.query('ROLLBACK');
      return res.status(409).json({ok:false,error:'nav_uat_live_config_protected',message:'Ehhez a telephelyhez éles NAV konfiguráció tartozik. A teszt UAT végpont ezt nem írhatja felül.'});
    }

    // Az ENV-ben tárolt secretet soha nem másoljuk át az adatbázisba.
    // Üres/maszkolt mezőnél csak a korábban DB-ben tárolt értéket tartjuk meg;
    // az effektív credential ellenőrzése külön, ENV overlay-jel történik.
    const technicalLogin=keepSecret(req.body?.technical_login,existing?.technical_login);
    const technicalPassword=keepSecret(req.body?.technical_password,existing?.technical_password);
    const signingKey=keepSecret(req.body?.signing_key,existing?.signing_key);
    const exchangeKey=keepSecret(req.body?.exchange_key,existing?.exchange_key);
    const effectiveTechnicalLogin=process.env.NAV_TECHNICAL_LOGIN||technicalLogin;
    const effectiveTechnicalPassword=process.env.NAV_TECHNICAL_PASSWORD||technicalPassword;
    const effectiveSigningKey=process.env.NAV_SIGNING_KEY||signingKey;
    const effectiveExchangeKey=process.env.NAV_EXCHANGE_KEY||exchangeKey;
    if(!effectiveTechnicalLogin||!effectiveTechnicalPassword||!effectiveSigningKey||!effectiveExchangeKey){
      await c.query('ROLLBACK');
      return res.status(400).json({ok:false,message:'A NAV teszt technikai login, jelszó, aláírókulcs és cserekulcs mind szükséges. A kulcsokat ne chatben küldje; az admin felületen vagy Render környezeti változóként adja meg.'});
    }
    if(!/^[0-9a-fA-F]{32}$/.test(String(effectiveExchangeKey))) {
      await c.query('ROLLBACK');
      return res.status(400).json({ok:false,message:'A NAV cserekulcsnak 32 hexadecimális karakterből kell állnia.'});
    }

    let row:any;
    if(existing){
      row=(await c.query(`UPDATE nav_online_invoice_settings SET active=true,environment='test',supplier_name=$2,supplier_tax_number=$3,supplier_country_code='HU',supplier_postal_code=$4,supplier_city=$5,supplier_address=$6,invoice_prefix=$7,technical_login=$8,technical_password=$9,signing_key=$10,exchange_key=$11,updated_at=now() WHERE id=$1::uuid RETURNING *`,[existing.id,supplierName,supplierTaxNumber,postalCode,city,address,invoicePrefix,technicalLogin,technicalPassword,signingKey,exchangeKey])).rows[0];
    }else{
      row=(await c.query(`INSERT INTO nav_online_invoice_settings(location_id,active,environment,supplier_name,supplier_tax_number,supplier_country_code,supplier_postal_code,supplier_city,supplier_address,invoice_prefix,technical_login,technical_password,signing_key,exchange_key) VALUES($1::uuid,true,'test',$2,$3,'HU',$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,[locationId,supplierName,supplierTaxNumber,postalCode,city,address,invoicePrefix,technicalLogin,technicalPassword,signingKey,exchangeKey])).rows[0];
    }
    await c.query('COMMIT');
    console.info('[NAV-UAT] test configuration saved',{config_id:String(row.id),location_id:row.location_id?String(row.location_id):null,actor:actor(req)});
    res.json({ok:true,message:'NAV tesztkörnyezeti konfiguráció mentve és aktiválva.',config:safeConfig(row)});
  }catch(e:any){
    await c.query('ROLLBACK').catch(()=>undefined);
    if(String(e?.code||'')==='22P02')return res.status(400).json({ok:false,message:'Érvénytelen telephely-azonosító.'});
    next(e);
  }finally{c.release()}
});

router.get('/environment',async(req:AuthRequest,res,next)=>{
  try{
    const requested=String(req.query.location_id||req.user?.location_id||'').trim();
    const c=await selectedConfig(requested);
    if(!c)return res.status(404).json({ok:false,message:'Nincs aktív NAV Online Számla konfiguráció.'});
    const safe=safeConfig(c);
    res.json({ok:true,environment:c.environment,location_id:c.location_id||null,test_ready:Boolean(safe?.test_ready),credentials_configured:{technical_login:Boolean(safe?.technical_login),technical_password:Boolean(safe?.technical_password_configured),signing_key:Boolean(safe?.signing_key_configured),exchange_key:Boolean(safe?.exchange_key_configured)},live_submission_blocked:true});
  }catch(e){next(e)}
});

router.post('/fixture',async(req:AuthRequest,res,next)=>{
  const c=await db.connect();
  try{
    const requested=String(req.body?.location_id||req.user?.location_id||'').trim();
    const config=await selectedConfig(requested);
    if(!config)return res.status(409).json({ok:false,message:'NAV UAT: nincs aktív NAV konfiguráció.'});
    if(String(config.environment)!=='test')return res.status(409).json({ok:false,error:'nav_uat_live_blocked',message:'NAV UAT tesztadat nem készíthető, mert az aktív NAV konfiguráció nem tesztkörnyezet.',environment:config.environment});
    const safe=safeConfig(config);
    if(!safe?.test_ready)return res.status(409).json({ok:false,error:'nav_uat_credentials_missing',message:'NAV UAT: a teszt technikai felhasználó hitelesítő adatai hiányosak.'});
    const uatTag=tag();
    const invoiceNo=`KLEO-${uatTag}`.slice(0,50);
    const locationId=config.location_id||requested||null;
    await c.query('BEGIN');
    const inv=(await c.query(`INSERT INTO finance_invoices(location_id,direction,invoice_no,partner_name,customer_name,customer_country_code,customer_postal_code,customer_city,customer_address,issue_date,performance_date,due_date,currency,net_total,vat_total,gross_total,status,note,created_by,invoice_type,nav_status,nav_validation_status,payment_method,payment_date) VALUES($1::uuid,'outgoing',$2,$3,$3,'HU','3300','Eger','NAV teszt UAT utca 1.',CURRENT_DATE,CURRENT_DATE,CURRENT_DATE,'HUF',2000,320,2320,'draft',$4,$5,'NORMAL','not_submitted','not_validated','CASH',CURRENT_DATE) RETURNING id::text,invoice_no,location_id::text,invoice_type,net_total,vat_total,gross_total`,[locationId,invoiceNo,`${uatTag} Teszt Vendég`,`${uatTag} · AUTOMATIZÁLT NAV TESZT UAT · NEM ÉLES ÜZLETI BIZONYLAT`,actor(req)])).rows[0];
    await c.query(`INSERT INTO finance_invoice_lines(invoice_id,line_number,description,quantity,unit_of_measure,unit_price_net,vat_rate,net_amount,vat_amount,gross_amount) VALUES($1::uuid,1,$2,1,'PIECE',1000,0.27,1000,270,1270),($1::uuid,2,$3,1,'PIECE',1000,0.05,1000,50,1050)`,[inv.id,`${uatTag} 27%-os teszttétel`,`${uatTag} 5%-os teszttétel`]);
    await c.query('COMMIT');
    res.status(201).json({ok:true,tag:uatTag,environment:'test',live_submission_blocked:true,invoice:inv,expected:{operation:'CREATE',vat_rates:[0.27,0.05],gross_total:2320}});
  }catch(e){await c.query('ROLLBACK').catch(()=>undefined);next(e)}finally{c.release()}
});

router.get('/chain/:invoiceId',async(req:AuthRequest,res,next)=>{
  try{
    const root=(await db.query(`SELECT id::text,invoice_no,invoice_type,original_invoice_id::text,original_invoice_number,modification_index,nav_status,nav_transaction_id,nav_xsd_validation_status,created_at,note FROM finance_invoices WHERE id=$1::uuid`,[req.params.invoiceId])).rows[0];
    if(!root)return res.status(404).json({message:'NAV UAT gyökérszámla nem található.'});
    if(!String(root.invoice_no||'').startsWith('KLEO-NAV-UAT-'))return res.status(403).json({message:'Ez a végpont csak NAV-UAT számlalánchoz használható.'});
    const invoices=(await db.query(`SELECT id::text,invoice_no,invoice_type,original_invoice_id::text,original_invoice_number,modification_index,nav_status,nav_transaction_id,nav_xsd_validation_status,created_at FROM finance_invoices WHERE id=$1::uuid OR original_invoice_id=$1::uuid ORDER BY COALESCE(modification_index,0),created_at`,[root.id])).rows;
    const submissions=(await db.query(`SELECT s.id::text,s.invoice_id::text,s.invoice_number,s.operation,s.environment,s.transaction_id,s.status,s.error_code,s.error_message,s.xsd_validation_status,s.xsd_schema_revision,s.submitted_at,s.completed_at,s.nav_result FROM nav_invoice_submissions s WHERE s.invoice_id=ANY($1::uuid[]) ORDER BY s.created_at`,[invoices.map((x:any)=>x.id)])).rows;
    res.json({ok:true,root_invoice_id:root.id,invoices,submissions});
  }catch(e){next(e)}
});

export default router;
