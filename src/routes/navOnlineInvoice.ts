import {Router} from 'express';
import axios from 'axios';
import crypto from 'crypto';
import db from '../db';
import {requireAuth,AuthRequest} from '../middleware/auth';
import {buildNavInvoiceXml,resolveNavOperation,validateNavXmlPrerequisites,NavInvoiceOperation} from '../nav/navInvoiceXml';
import {getNavXsdRuntimeInfo,validateNavInvoiceXmlXsd,NavXsdValidationResult} from '../nav/navXsdValidator';

const router=Router();
router.use(requireAuth);

const actor=(r:AuthRequest)=>r.user?.email||String(r.user?.id||'');
const esc=(v:any)=>String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
const sha512=(s:string)=>crypto.createHash('sha512').update(s,'utf8').digest('hex').toUpperCase();
const sha3=(s:string)=>crypto.createHash('sha3-512').update(s,'utf8').digest('hex').toUpperCase();
const rid=()=>`KLEO${Date.now()}${crypto.randomBytes(5).toString('hex')}`.toUpperCase().slice(0,30);
const ts=()=>new Date().toISOString();
const compact=(iso:string)=>iso.replace(/[-:TZ.]/g,'').slice(0,14);
const allowedOperations=new Set<NavInvoiceOperation>(['CREATE','MODIFY','STORNO']);

type XsdAuditInput={
  status:'passed'|'failed'|'engine_error';
  errors:any[];
  xml_sha256:string|null;
  schema_revision:string|null;
  schema_name:string|null;
  validator:string|null;
  raw_output:string;
};

function apiBase(env:string){
  return env==='live'?'https://api.onlineszamla.nav.gov.hu/invoiceService/v3':'https://api-test.onlineszamla.nav.gov.hu/invoiceService/v3';
}

async function cfg(locationId?:string){
  const r=await db.query(`SELECT * FROM nav_online_invoice_settings WHERE active=true AND ($1::text='' OR location_id::text=$1 OR location_id IS NULL) ORDER BY CASE WHEN location_id::text=$1 THEN 0 ELSE 1 END LIMIT 1`,[locationId||'']);
  if(!r.rows[0])throw new Error('A NAV Online Számla beállításai hiányoznak.');
  const x=r.rows[0];
  return {...x,technical_login:process.env.NAV_TECHNICAL_LOGIN||x.technical_login,technical_password:process.env.NAV_TECHNICAL_PASSWORD||x.technical_password,signing_key:process.env.NAV_SIGNING_KEY||x.signing_key,exchange_key:process.env.NAV_EXCHANGE_KEY||x.exchange_key};
}

const missingCfg=(e:any)=>String(e?.message||e).includes('NAV Online Számla beállításai hiányoznak');

function commonHeader(c:any,requestId:string,timestamp:string,signature:string){
  return `<header><requestId>${requestId}</requestId><timestamp>${timestamp}</timestamp><requestVersion>3.0</requestVersion><headerVersion>1.0</headerVersion></header><user><login>${esc(c.technical_login)}</login><passwordHash cryptoType="SHA-512">${sha512(String(c.technical_password||''))}</passwordHash><taxNumber>${esc(String(c.supplier_tax_number).replace(/\D/g,'').slice(0,8))}</taxNumber><requestSignature cryptoType="SHA3-512">${signature}</requestSignature></user>`;
}

function software(c:any){
  return `<software><softwareId>${esc(c.software_id)}</softwareId><softwareName>${esc(c.software_name)}</softwareName><softwareOperation>${esc(c.software_operation||'ONLINE_SERVICE')}</softwareOperation><softwareMainVersion>${esc(c.software_main_version||'1.0')}</softwareMainVersion><softwareDevName>${esc(c.software_dev_name)}</softwareDevName>${c.software_dev_contact?`<softwareDevContact>${esc(c.software_dev_contact)}</softwareDevContact>`:''}<softwareDevCountryCode>${esc(c.software_dev_country_code||'HU')}</softwareDevCountryCode></software>`;
}

function decryptToken(encoded:string,keyHex:string){
  const key=Buffer.from(keyHex,'hex');
  const decipher=crypto.createDecipheriv('aes-128-ecb',key,null);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(Buffer.from(encoded,'base64')),decipher.final()]).toString('utf8');
}

async function exchangeToken(c:any){
  for(const k of ['technical_login','technical_password','signing_key','exchange_key'])if(!c[k])throw new Error(`NAV technikai hitelesítő adat hiányzik: ${k}`);
  const requestId=rid(),timestamp=ts(),signature=sha3(requestId+compact(timestamp)+String(c.signing_key));
  const xml=`<?xml version="1.0" encoding="UTF-8"?><TokenExchangeRequest xmlns="http://schemas.nav.gov.hu/OSA/3.0/api">${commonHeader(c,requestId,timestamp,signature)}${software(c)}</TokenExchangeRequest>`;
  const r=await axios.post(`${apiBase(c.environment)}/tokenExchange`,xml,{headers:{'Content-Type':'application/xml'},timeout:20000});
  const encoded=String(r.data).match(/<encodedExchangeToken>([^<]+)<\/encodedExchangeToken>/)?.[1];
  if(!encoded)throw new Error(`NAV tokenExchange sikertelen: ${String(r.data).slice(0,500)}`);
  return {token:decryptToken(encoded,String(c.exchange_key)),requestId,response:String(r.data)};
}

function toAudit(result:NavXsdValidationResult):XsdAuditInput{
  return {
    status:result.status,
    errors:result.errors,
    xml_sha256:result.xml_sha256,
    schema_revision:result.schema_revision,
    schema_name:result.schema_name,
    validator:result.validator,
    raw_output:result.raw_output
  };
}

function engineAudit(error:any):XsdAuditInput{
  const message=String(error?.message||error||'Ismeretlen XSD validátor hiba').slice(0,4000);
  return {
    status:'engine_error',
    errors:[{message,raw_message:message,file_name:null,line_number:null}],
    xml_sha256:null,
    schema_revision:null,
    schema_name:null,
    validator:null,
    raw_output:message
  };
}

async function recordXsdAudit(req:AuthRequest,invoiceId:string,submissionId:string|null,audit:XsdAuditInput){
  const errorsJson=JSON.stringify(audit.errors||[]);
  await db.query(`INSERT INTO nav_invoice_xsd_validation_runs(invoice_id,submission_id,status,xml_sha256,schema_revision,schema_name,validator,errors,raw_output,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`,[invoiceId,submissionId,audit.status,audit.xml_sha256,audit.schema_revision,audit.schema_name,audit.validator,errorsJson,String(audit.raw_output||'').slice(0,32768),actor(req)]);
  await db.query(`UPDATE finance_invoices SET nav_xsd_validation_status=$2,nav_xsd_validated_at=now(),nav_xsd_validation_errors=$3::jsonb,nav_xsd_schema_revision=$4,nav_xsd_xml_sha256=$5 WHERE id=$1::uuid`,[invoiceId,audit.status,errorsJson,audit.schema_revision,audit.xml_sha256]);
  if(submissionId){
    await db.query(`UPDATE nav_invoice_submissions SET xsd_validation_status=$2,xsd_validated_at=now(),xsd_errors=$3::jsonb,xsd_schema_revision=$4,invoice_xml_sha256=$5,updated_at=now() WHERE id=$1::uuid`,[submissionId,audit.status,errorsJson,audit.schema_revision,audit.xml_sha256]);
  }
}

async function loadInvoiceLines(invoiceId:string){
  const inv=(await db.query(`SELECT * FROM finance_invoices WHERE id=$1::uuid`,[invoiceId])).rows[0];
  if(!inv)return null;
  const lines=(await db.query(`SELECT * FROM finance_invoice_lines WHERE invoice_id=$1::uuid ORDER BY line_number`,[invoiceId])).rows;
  return {inv,lines};
}

router.get('/settings',async(req:AuthRequest,res,next)=>{
  try{
    const c=await cfg(String(req.query.location_id||req.user?.location_id||''));
    const copy={...c};
    for(const k of ['technical_password','signing_key','exchange_key'])if(copy[k])copy[k]='********';
    res.json(copy);
  }catch(e:any){if(missingCfg(e))return res.json(null);next(e)}
});

router.get('/connection-test',async(req:AuthRequest,res)=>{
  try{
    const c=await cfg(String(req.query.location_id||req.user?.location_id||''));
    const t=await exchangeToken(c);
    res.json({ok:true,environment:c.environment,request_id:t.requestId,message:'NAV tokenExchange sikeres.'});
  }catch(e:any){res.status(409).json({ok:false,message:e.message})}
});

router.get('/xsd-status',async(_req:AuthRequest,res)=>{
  try{
    const info=await getNavXsdRuntimeInfo();
    res.json({ok:true,...info,fail_closed:true});
  }catch(e:any){
    res.status(503).json({ok:false,ready:false,fail_closed:true,message:'A lokális NAV XSD validátor nem érhető el; a NAV beküldés biztonsági okból blokkolva.',detail:String(e?.message||e)});
  }
});

router.post('/invoices/:id/xsd-validate',async(req:AuthRequest,res)=>{
  const bundle=await loadInvoiceLines(req.params.id);
  if(!bundle)return res.status(404).json({message:'A számla nem található.'});
  try{
    const c=await cfg(String(bundle.inv.location_id||req.user?.location_id||''));
    const prerequisites=validateNavXmlPrerequisites(bundle.inv,bundle.lines);
    if(!prerequisites.valid)return res.status(409).json({ok:false,message:'A számla NAV XML előfeltételei hibásak.',errors:prerequisites.errors});
    const xml=buildNavInvoiceXml(c,bundle.inv,bundle.lines);
    const result=await validateNavInvoiceXmlXsd(xml);
    await recordXsdAudit(req,bundle.inv.id,null,toAudit(result));
    if(!result.valid)return res.status(409).json({ok:false,message:'A NAV XML nem felel meg a rögzített hivatalos XSD-nek.',xsd:result});
    res.json({ok:true,operation:resolveNavOperation(bundle.inv.invoice_type),xsd:result});
  }catch(e:any){
    if(missingCfg(e))return res.status(409).json({ok:false,message:e.message});
    const audit=engineAudit(e);
    await recordXsdAudit(req,bundle.inv.id,null,audit).catch(()=>undefined);
    res.status(503).json({ok:false,message:'A lokális NAV XSD validátor hibát jelzett; a NAV beküldés blokkolva.',detail:String(e?.message||e)});
  }
});

router.post('/invoices/:id/prepare',async(req:AuthRequest,res,next)=>{
  try{
    const inv=(await db.query(`SELECT * FROM finance_invoices WHERE id=$1::uuid`,[req.params.id])).rows[0];
    if(!inv)return res.status(404).json({message:'A számla nem található.'});
    const c=await cfg(String(inv.location_id||req.user?.location_id||''));
    let lines=(await db.query(`SELECT * FROM finance_invoice_lines WHERE invoice_id=$1::uuid ORDER BY line_number`,[inv.id])).rows;
    if(!lines.length&&inv.work_order_id){
      const items=(await db.query(`SELECT * FROM work_order_items WHERE work_order_id=$1 ORDER BY created_at`,[inv.work_order_id])).rows;
      for(let i=0;i<items.length;i++){
        const x=items[i],gross=Number(x.line_total||0),vatRate=Number(c.default_vat_rate||0.27),net=gross/(1+vatRate),vat=gross-net;
        const l=(await db.query(`INSERT INTO finance_invoice_lines(invoice_id,line_number,description,quantity,unit_of_measure,unit_price_net,vat_rate,net_amount,vat_amount,gross_amount,service_id,product_id) VALUES($1,$2,$3,$4,'PIECE',$5,$6,$7,$8,$9,$10,$11) RETURNING *`,[inv.id,i+1,x.item_name||'Tétel',Number(x.quantity||1),net/Number(x.quantity||1),vatRate,net,vat,gross,x.service_id?String(x.service_id):null,x.product_id?String(x.product_id):null])).rows[0];
        lines.push(l);
      }
    }
    const validation=validateNavXmlPrerequisites(inv,lines);
    if(!validation.valid)return res.status(409).json({ok:false,message:'A számla NAV XML előfeltételei hibásak.',errors:validation.errors});
    const operation=resolveNavOperation(inv.invoice_type);
    const xml=buildNavInvoiceXml(c,inv,lines);
    let xsd:NavXsdValidationResult;
    try{
      xsd=await validateNavInvoiceXmlXsd(xml);
    }catch(e:any){
      const audit=engineAudit(e);
      await recordXsdAudit(req,inv.id,null,audit).catch(()=>undefined);
      return res.status(503).json({ok:false,message:'A lokális NAV XSD validátor nem érhető el; az előkészítés és a NAV beküldés blokkolva.',detail:String(e?.message||e)});
    }
    if(!xsd.valid){
      await recordXsdAudit(req,inv.id,null,toAudit(xsd));
      return res.status(409).json({ok:false,message:'A generált NAV XML nem felel meg a rögzített hivatalos XSD-nek. Beküldés nem készíthető elő.',xsd});
    }
    const s=(await db.query(`INSERT INTO nav_invoice_submissions(invoice_id,work_order_id,invoice_number,operation,environment,status,invoice_xml,created_by,xsd_validation_status,xsd_validated_at,xsd_errors,xsd_schema_revision,invoice_xml_sha256) VALUES($1,$2,$3,$4,$5,'prepared',$6,$7,'passed',now(),'[]'::jsonb,$8,$9) RETURNING *`,[inv.id,inv.work_order_id||null,inv.invoice_no,operation,c.environment,xml,actor(req),xsd.schema_revision,xsd.xml_sha256])).rows[0];
    await recordXsdAudit(req,inv.id,s.id,toAudit(xsd));
    res.status(201).json({submission:s,operation,xsd_validation:{status:xsd.status,schema_revision:xsd.schema_revision,xml_sha256:xsd.xml_sha256,validator:xsd.validator},invoice_xml:xml});
  }catch(e:any){if(missingCfg(e))return res.status(409).json({ok:false,message:e.message});next(e)}
});

router.post('/submissions/:id/submit',async(req:AuthRequest,res)=>{
  try{
    const s=(await db.query(`SELECT * FROM nav_invoice_submissions WHERE id=$1::uuid`,[req.params.id])).rows[0];
    if(!s)return res.status(404).json({message:'NAV beküldés nem található.'});
    const operation=String(s.operation||'').toUpperCase() as NavInvoiceOperation;
    if(!allowedOperations.has(operation))return res.status(409).json({ok:false,message:`Érvénytelen NAV számlaművelet: ${operation||'hiányzik'}`});
    if(!String(s.invoice_xml||'').trim())return res.status(409).json({ok:false,message:'A NAV beküldéshez nincs előkészített invoice_xml.'});
    const inv=(await db.query(`SELECT * FROM finance_invoices WHERE id=$1::uuid`,[s.invoice_id])).rows[0];
    if(!inv)return res.status(404).json({message:'A számla nem található.'});
    const expectedOperation=resolveNavOperation(inv.invoice_type);
    if(operation!==expectedOperation)return res.status(409).json({ok:false,message:`A NAV művelet (${operation}) nem egyezik a számla típusával (${expectedOperation}). Készítse elő újra az adatszolgáltatást.`});

    // Fail-closed kapu: a tárolt XML-t minden beküldés előtt újravalidáljuk.
    // TokenExchange/manageInvoice kizárólag sikeres helyi XSD-validáció után indulhat.
    let xsd:NavXsdValidationResult;
    try{
      xsd=await validateNavInvoiceXmlXsd(String(s.invoice_xml));
    }catch(e:any){
      const audit=engineAudit(e);
      await recordXsdAudit(req,inv.id,s.id,audit).catch(()=>undefined);
      return res.status(503).json({ok:false,message:'A lokális NAV XSD validátor nem érhető el; a NAV beküldés blokkolva.',detail:String(e?.message||e)});
    }
    await recordXsdAudit(req,inv.id,s.id,toAudit(xsd));
    if(!xsd.valid)return res.status(409).json({ok:false,message:'A NAV XML XSD-validációja sikertelen; a NAV felé nem történt hálózati beküldés.',xsd});

    const c=await cfg(String(inv.location_id||req.user?.location_id||''));
    const {token}=await exchangeToken(c);
    const requestId=rid(),timestamp=ts();
    const invoiceData=Buffer.from(String(s.invoice_xml),'utf8').toString('base64');
    const partial=sha3(operation+invoiceData);
    const signature=sha3(requestId+compact(timestamp)+String(c.signing_key)+partial);
    const xml=`<?xml version="1.0" encoding="UTF-8"?><ManageInvoiceRequest xmlns="http://schemas.nav.gov.hu/OSA/3.0/api">${commonHeader(c,requestId,timestamp,signature)}${software(c)}<exchangeToken>${esc(token)}</exchangeToken><invoiceOperations><compressedContent>false</compressedContent><invoiceOperation><index>1</index><invoiceOperation>${operation}</invoiceOperation><invoiceData>${invoiceData}</invoiceData></invoiceOperation></invoiceOperations></ManageInvoiceRequest>`;
    await db.query(`UPDATE nav_invoice_submissions SET status='submitting',request_id=$2,request_xml=$3,updated_at=now() WHERE id=$1`,[s.id,requestId,xml]);
    const r=await axios.post(`${apiBase(c.environment)}/manageInvoice`,xml,{headers:{'Content-Type':'application/xml'},timeout:30000});
    const response=String(r.data),transactionId=response.match(/<transactionId>([^<]+)<\/transactionId>/)?.[1];
    if(!transactionId)throw new Error(`NAV manageInvoice sikertelen: ${response.slice(0,800)}`);
    await db.query(`UPDATE nav_invoice_submissions SET status='submitted',transaction_id=$2,response_xml=$3,submitted_at=now(),updated_at=now() WHERE id=$1`,[s.id,transactionId,response]);
    await db.query(`UPDATE finance_invoices SET nav_status='submitted',nav_transaction_id=$2,nav_submission_id=$3 WHERE id=$1`,[s.invoice_id,transactionId,s.id]);
    res.json({ok:true,transaction_id:transactionId,environment:c.environment,operation,xsd_validation:{status:xsd.status,schema_revision:xsd.schema_revision,xml_sha256:xsd.xml_sha256}});
  }catch(e:any){
    await db.query(`UPDATE nav_invoice_submissions SET status='error',error_message=$2,updated_at=now() WHERE id=$1::uuid`,[req.params.id,String(e.message||e)]).catch(()=>undefined);
    res.status(409).json({ok:false,message:e.message});
  }
});

router.get('/invoices/:id/submissions',async(req,res,next)=>{
  try{
    const r=await db.query(`SELECT id,invoice_number,operation,environment,request_id,transaction_id,status,error_code,error_message,xsd_validation_status,xsd_validated_at,xsd_errors,xsd_schema_revision,invoice_xml_sha256,submitted_at,completed_at,created_at FROM nav_invoice_submissions WHERE invoice_id=$1::uuid ORDER BY created_at DESC`,[req.params.id]);
    res.json(r.rows);
  }catch(e){next(e)}
});

export default router;
