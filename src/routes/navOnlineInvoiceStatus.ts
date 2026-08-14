import {Router} from 'express';
import axios from 'axios';
import crypto from 'crypto';
import db from '../db';
import{requireAuth,AuthRequest}from'../middleware/auth';

const r=Router();
r.use(requireAuth);
const esc=(v:any)=>String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const sha512=(s:string)=>crypto.createHash('sha512').update(s).digest('hex').toUpperCase();
const sha3=(s:string)=>crypto.createHash('sha3-512').update(s).digest('hex').toUpperCase();
const rid=()=>`KLEOST${Date.now()}${crypto.randomBytes(4).toString('hex')}`.toUpperCase().slice(0,30);
const compact=(s:string)=>s.replace(/[-:TZ.]/g,'').slice(0,14);
const base=(e:string)=>e==='live'?'https://api.onlineszamla.nav.gov.hu/invoiceService/v3':'https://api-test.onlineszamla.nav.gov.hu/invoiceService/v3';

async function cfg(locationId?:string){
 const q=await db.query(`SELECT * FROM nav_online_invoice_settings WHERE active=true AND ($1::text='' OR location_id::text=$1 OR location_id IS NULL) ORDER BY CASE WHEN location_id::text=$1 THEN 0 ELSE 1 END LIMIT 1`,[locationId||'']);
 if(!q.rows[0])throw new Error('NAV beállítás hiányzik.');
 const x=q.rows[0];
 return{...x,technical_login:process.env.NAV_TECHNICAL_LOGIN||x.technical_login,technical_password:process.env.NAV_TECHNICAL_PASSWORD||x.technical_password,signing_key:process.env.NAV_SIGNING_KEY||x.signing_key}
}

function header(c:any,id:string,t:string){
 const sig=sha3(id+compact(t)+String(c.signing_key));
 return `<header><requestId>${id}</requestId><timestamp>${t}</timestamp><requestVersion>3.0</requestVersion><headerVersion>1.0</headerVersion></header><user><login>${esc(c.technical_login)}</login><passwordHash cryptoType="SHA-512">${sha512(String(c.technical_password||''))}</passwordHash><taxNumber>${String(c.supplier_tax_number).replace(/\D/g,'').slice(0,8)}</taxNumber><requestSignature cryptoType="SHA3-512">${sig}</requestSignature></user>`
}

const tag=(xml:string,name:string)=>xml.match(new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:\\w+:)?${name}>`,'i'))?.[1]?.trim()||null;
const blocks=(xml:string,name:string)=>[...xml.matchAll(new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:\\w+:)?${name}>`,'gi'))].map(x=>x[1]);
function validationMessages(xml:string){
 const result:any[]=[];
 for(const kind of ['businessValidationMessages','technicalValidationMessages']){
  for(const block of blocks(xml,kind)){
   result.push({
    type:kind.startsWith('business')?'business':'technical',
    result_code:String(tag(block,'validationResultCode')||'').toUpperCase()||null,
    error_code:tag(block,'validationErrorCode')||null,
    message:tag(block,'message')||null,
    pointer:tag(block,'pointer')||null
   });
  }
 }
 return result;
}

r.post('/submissions/:id/refresh',async(req:AuthRequest,res)=>{
 try{
  const s=(await db.query(`SELECT s.*,i.location_id FROM nav_invoice_submissions s JOIN finance_invoices i ON i.id=s.invoice_id WHERE s.id=$1::uuid`,[req.params.id])).rows[0];
  if(!s)return res.status(404).json({message:'Beküldés nem található.'});
  if(!s.transaction_id)return res.status(409).json({message:'Még nincs NAV transactionId.'});
  const submissionEnvironment=String(s.environment||'');
  if(!['test','live'].includes(submissionEnvironment))return res.status(409).json({ok:false,message:'A NAV beküldés rögzített környezete érvénytelen.',submission_environment:submissionEnvironment||null});
  const c=await cfg(String(s.location_id||req.user?.location_id||''));
  if(String(c.environment)!==submissionEnvironment)return res.status(409).json({ok:false,error:'nav_environment_mismatch',message:'A NAV konfiguráció környezete eltér a beküldés rögzített környezetétől. A státuszlekérdezés biztonsági okból blokkolva.',submission_environment:submissionEnvironment,configured_environment:c.environment});
  const id=rid(),t=new Date().toISOString();
  const xml=`<?xml version="1.0" encoding="UTF-8"?><QueryTransactionStatusRequest xmlns="http://schemas.nav.gov.hu/OSA/3.0/api">${header(c,id,t)}<software><softwareId>${esc(c.software_id)}</softwareId><softwareName>${esc(c.software_name)}</softwareName><softwareOperation>${esc(c.software_operation||'ONLINE_SERVICE')}</softwareOperation><softwareMainVersion>${esc(c.software_main_version||'1.0')}</softwareMainVersion><softwareDevName>${esc(c.software_dev_name)}</softwareDevName><softwareDevCountryCode>${esc(c.software_dev_country_code||'HU')}</softwareDevCountryCode></software><transactionId>${esc(s.transaction_id)}</transactionId><returnOriginalRequest>false</returnOriginalRequest></QueryTransactionStatusRequest>`;
  const a=await axios.post(`${base(submissionEnvironment)}/queryTransactionStatus`,xml,{headers:{'Content-Type':'application/xml'},timeout:20000});
  const text=String(a.data);
  const processing=blocks(text,'processingResult');
  const invoiceStatuses=processing.map(x=>String(tag(x,'invoiceStatus')||'').toUpperCase()).filter(Boolean);
  const messages=validationMessages(text);
  const errors=messages.filter(x=>x.result_code==='ERROR');
  const warnings=messages.filter(x=>x.result_code==='WARN');
  let mapped='processing';
  if(invoiceStatuses.includes('ABORTED'))mapped='aborted';
  else if(errors.length)mapped='error';
  else if(invoiceStatuses.length&&invoiceStatuses.every(x=>x==='DONE'))mapped=warnings.length?'warning':'done';
  else if(invoiceStatuses.length&&invoiceStatuses.every(x=>['RECEIVED','PROCESSING','SAVED','DONE'].includes(x)))mapped='processing';
  else if(!invoiceStatuses.length)throw new Error(`A NAV queryTransactionStatus válaszban nincs feldolgozási állapot: ${text.slice(0,700)}`);

  const result={invoice_statuses:invoiceStatuses,validation_messages:messages,warning_count:warnings.length,error_count:errors.length};
  const firstProblem=errors[0]||warnings[0]||null;
  await db.query(`UPDATE nav_invoice_submissions SET status=$2,response_xml=$3,nav_result=$4::jsonb,error_code=$5,error_message=$6,completed_at=CASE WHEN $2 IN ('done','warning','error','aborted') THEN now() ELSE completed_at END,updated_at=now() WHERE id=$1`,[s.id,mapped,text,JSON.stringify(result),firstProblem?.error_code||null,firstProblem?.message||null]);
  await db.query(`UPDATE finance_invoices SET nav_status=$2,nav_last_polled_at=now(),nav_last_result=$3::jsonb,nav_warning_count=$4,nav_error_count=$5 WHERE id=$1`,[s.invoice_id,mapped,JSON.stringify(result),warnings.length,errors.length]);
  res.json({ok:true,status:mapped,invoice_statuses:invoiceStatuses,validation_messages:messages,warning_count:warnings.length,error_count:errors.length,environment:submissionEnvironment})
 }catch(e:any){res.status(409).json({ok:false,message:e.message})}
});

export default r;
