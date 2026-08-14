import axios from 'axios';
import crypto from 'crypto';
import db from '../db';
import {ensureNavInvoiceCore} from '../finance/ensureNavInvoiceCore';
import {buildNavInvoiceXml,resolveNavOperation,validateNavXmlPrerequisites,NavInvoiceOperation} from './navInvoiceXml';
import {validateNavInvoiceXmlXsd,NavXsdValidationResult} from './navXsdValidator';

const esc=(v:any)=>String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
const sha512=(s:string)=>crypto.createHash('sha512').update(s,'utf8').digest('hex').toUpperCase();
const sha3=(s:string)=>crypto.createHash('sha3-512').update(s,'utf8').digest('hex').toUpperCase();
const compact=(s:string)=>s.replace(/[-:TZ.]/g,'').slice(0,14);
const requestId=(prefix='KLEOW')=>`${prefix}${Date.now()}${crypto.randomBytes(5).toString('hex')}`.toUpperCase().slice(0,30);
const truthy=(v:any)=>/^(1|true|yes|on)$/i.test(String(v||'').trim());
const terminalSubmissionStatuses=new Set(['done','warning','error','aborted']);
const MAX_ATTEMPTS=Math.max(1,Math.min(20,Number(process.env.NAV_QUEUE_MAX_ATTEMPTS||6)));
const BATCH_SIZE=Math.max(1,Math.min(25,Number(process.env.NAV_QUEUE_BATCH_SIZE||5)));
const POLL_SECONDS=Math.max(10,Math.min(300,Number(process.env.NAV_QUEUE_POLL_SECONDS||20)));

export class NavQueueWorkerError extends Error{
  code:string;
  retryable:boolean;
  constructor(code:string,message:string,retryable=false){super(message);this.name='NavQueueWorkerError';this.code=code;this.retryable=retryable}
}

export type NavQueueWorkerState={
  enabled:boolean;
  running:boolean;
  started_at:string|null;
  last_tick_at:string|null;
  last_success_at:string|null;
  last_error_at:string|null;
  last_error:string|null;
  processed:number;
  submitted:number;
  refreshed:number;
};

const state:NavQueueWorkerState={enabled:false,running:false,started_at:null,last_tick_at:null,last_success_at:null,last_error_at:null,last_error:null,processed:0,submitted:0,refreshed:0};
let timer:NodeJS.Timeout|null=null;

const apiBase=(environment:string)=>environment==='live'?'https://api.onlineszamla.nav.gov.hu/invoiceService/v3':'https://api-test.onlineszamla.nav.gov.hu/invoiceService/v3';

async function activeConfig(locationId:any){
  const q=await db.query(`SELECT * FROM nav_online_invoice_settings WHERE active=true AND ($1::text='' OR location_id::text=$1 OR location_id IS NULL) ORDER BY CASE WHEN location_id::text=$1 THEN 0 ELSE 1 END LIMIT 1`,[String(locationId||'')]);
  const row=q.rows[0];
  if(!row)throw new NavQueueWorkerError('NAV_CONFIG_MISSING','Nincs aktív NAV Online Számla konfiguráció ehhez a számlához.');
  return {...row,
    technical_login:process.env.NAV_TECHNICAL_LOGIN||row.technical_login,
    technical_password:process.env.NAV_TECHNICAL_PASSWORD||row.technical_password,
    signing_key:process.env.NAV_SIGNING_KEY||row.signing_key,
    exchange_key:process.env.NAV_EXCHANGE_KEY||row.exchange_key
  };
}

function requireCredentials(c:any,environment:string){
  const keys=['technical_login','technical_password','signing_key','exchange_key'] as const;
  const missing=keys.filter(k=>!String(c?.[k]||'').trim());
  if(missing.length)throw new NavQueueWorkerError('NAV_CREDENTIALS_MISSING',`Hiányzó NAV technikai hitelesítő adat: ${missing.join(', ')}.`);
  if(!/^[0-9a-fA-F]{32}$/.test(String(c.exchange_key)))throw new NavQueueWorkerError('NAV_EXCHANGE_KEY_INVALID','A NAV cserekulcsnak 32 hexadecimális karakterből kell állnia.');
  if(environment==='live'){
    if(!Boolean(c.live_submit_enabled)||!truthy(process.env.NAV_LIVE_SUBMIT_ENABLED))throw new NavQueueWorkerError('NAV_LIVE_LOCKED','Az éles NAV beküldés kettős biztonsági zára nincs feloldva.');
    const envKeys=['NAV_TECHNICAL_LOGIN','NAV_TECHNICAL_PASSWORD','NAV_SIGNING_KEY','NAV_EXCHANGE_KEY'] as const;
    const missingEnv=envKeys.filter(k=>!String(process.env[k]||'').trim());
    if(missingEnv.length)throw new NavQueueWorkerError('NAV_LIVE_SECRETS_NOT_ENV',`Éles NAV beküldéshez deployment secretként hiányzik: ${missingEnv.join(', ')}.`);
  }
}

function commonHeader(c:any,id:string,timestamp:string,signature:string){
  return `<header><requestId>${id}</requestId><timestamp>${timestamp}</timestamp><requestVersion>3.0</requestVersion><headerVersion>1.0</headerVersion></header><user><login>${esc(c.technical_login)}</login><passwordHash cryptoType="SHA-512">${sha512(String(c.technical_password||''))}</passwordHash><taxNumber>${esc(String(c.supplier_tax_number||'').replace(/\D/g,'').slice(0,8))}</taxNumber><requestSignature cryptoType="SHA3-512">${signature}</requestSignature></user>`;
}
function software(c:any){return `<software><softwareId>${esc(c.software_id)}</softwareId><softwareName>${esc(c.software_name)}</softwareName><softwareOperation>${esc(c.software_operation||'ONLINE_SERVICE')}</softwareOperation><softwareMainVersion>${esc(c.software_main_version||'1.0')}</softwareMainVersion><softwareDevName>${esc(c.software_dev_name)}</softwareDevName>${c.software_dev_contact?`<softwareDevContact>${esc(c.software_dev_contact)}</softwareDevContact>`:''}<softwareDevCountryCode>${esc(c.software_dev_country_code||'HU')}</softwareDevCountryCode></software>`}
function decryptToken(encoded:string,keyHex:string){const decipher=crypto.createDecipheriv('aes-128-ecb',Buffer.from(keyHex,'hex'),null);decipher.setAutoPadding(true);return Buffer.concat([decipher.update(Buffer.from(encoded,'base64')),decipher.final()]).toString('utf8')}

async function exchangeToken(c:any){
  requireCredentials(c,String(c.environment));
  const id=requestId('KLEOWT'),timestamp=new Date().toISOString(),signature=sha3(id+compact(timestamp)+String(c.signing_key));
  const xml=`<?xml version="1.0" encoding="UTF-8"?><TokenExchangeRequest xmlns="http://schemas.nav.gov.hu/OSA/3.0/api">${commonHeader(c,id,timestamp,signature)}${software(c)}</TokenExchangeRequest>`;
  try{
    const r=await axios.post(`${apiBase(String(c.environment))}/tokenExchange`,xml,{headers:{'Content-Type':'application/xml'},timeout:20000});
    const encoded=String(r.data).match(/<encodedExchangeToken>([^<]+)<\/encodedExchangeToken>/)?.[1];
    if(!encoded)throw new NavQueueWorkerError('NAV_TOKEN_REJECTED',`NAV tokenExchange válaszban nincs exchange token: ${String(r.data).slice(0,500)}`);
    return decryptToken(encoded,String(c.exchange_key));
  }catch(e:any){
    if(e instanceof NavQueueWorkerError)throw e;
    throw new NavQueueWorkerError('NAV_TOKEN_NETWORK',`NAV tokenExchange átmeneti hálózati hiba: ${String(e?.message||e)}`,true);
  }
}

async function recordXsd(invoiceId:string,submissionId:string|null,result:NavXsdValidationResult,createdBy:string){
  const errors=JSON.stringify(result.errors||[]);
  await db.query(`INSERT INTO nav_invoice_xsd_validation_runs(invoice_id,submission_id,status,xml_sha256,schema_revision,schema_name,validator,errors,raw_output,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`,[invoiceId,submissionId,result.status,result.xml_sha256,result.schema_revision,result.schema_name,result.validator,errors,String(result.raw_output||'').slice(0,32768),createdBy]);
  await db.query(`UPDATE finance_invoices SET nav_xsd_validation_status=$2,nav_xsd_validated_at=now(),nav_xsd_validation_errors=$3::jsonb,nav_xsd_schema_revision=$4,nav_xsd_xml_sha256=$5 WHERE id=$1::uuid`,[invoiceId,result.status,errors,result.schema_revision,result.xml_sha256]);
  if(submissionId)await db.query(`UPDATE nav_invoice_submissions SET xsd_validation_status=$2,xsd_validated_at=now(),xsd_errors=$3::jsonb,xsd_schema_revision=$4,invoice_xml_sha256=$5,updated_at=now() WHERE id=$1::uuid`,[submissionId,result.status,errors,result.schema_revision,result.xml_sha256]);
}

export async function prepareQueuedInvoice(invoiceId:string,createdBy='nav-queue-worker'){
  const inv=(await db.query(`SELECT * FROM finance_invoices WHERE id=$1::uuid`,[invoiceId])).rows[0];
  if(!inv)throw new NavQueueWorkerError('INVOICE_NOT_FOUND','A NAV sorban szereplő számla nem található.');
  if(String(inv.document_kind||'')!=='tax_invoice'||!inv.issued_at)throw new NavQueueWorkerError('INVOICE_NOT_ISSUED','NAV adatszolgáltatás csak hivatalosan kiállított számlához készíthető elő.');

  const last=(await db.query(`SELECT * FROM nav_invoice_submissions WHERE invoice_id=$1::uuid ORDER BY created_at DESC LIMIT 1`,[invoiceId])).rows[0];
  if(last?.transaction_id)return last;
  if(last?.status==='submitting'&&!last?.transaction_id)throw new NavQueueWorkerError('NAV_SUBMISSION_UNCERTAIN','Korábbi NAV manageInvoice kérés folyamatban/ismert eredmény nélkül maradt; automatikus ismételt beküldés blokkolva.');
  if(last?.status==='error'&&last?.request_id&&!last?.transaction_id)throw new NavQueueWorkerError('NAV_SUBMISSION_UNCERTAIN','Korábbi NAV manageInvoice kérés eredménye bizonytalan; automatikus újraküldés helyett kézi egyeztetés szükséges.');
  if(last&&['prepared','submitted','processing'].includes(String(last.status)))return last;

  const c=await activeConfig(inv.location_id);
  const environment=String(c.environment||'');
  if(!['test','live'].includes(environment))throw new NavQueueWorkerError('NAV_ENV_INVALID','Érvénytelen NAV környezet.');
  const lines=(await db.query(`SELECT * FROM finance_invoice_lines WHERE invoice_id=$1::uuid ORDER BY line_number`,[invoiceId])).rows;
  const prerequisites=validateNavXmlPrerequisites(inv,lines,c);
  if(!prerequisites.valid)throw new NavQueueWorkerError('NAV_PREREQUISITES_FAILED',prerequisites.errors.join(' · '));
  const operation=resolveNavOperation(inv.invoice_type);
  const xml=buildNavInvoiceXml(c,inv,lines);
  let xsd:NavXsdValidationResult;
  try{xsd=await validateNavInvoiceXmlXsd(xml)}catch(e:any){throw new NavQueueWorkerError('NAV_XSD_ENGINE_ERROR',`A lokális NAV XSD motor nem érhető el: ${String(e?.message||e)}`,true)}
  await recordXsd(String(inv.id),null,xsd,createdBy).catch(()=>undefined);
  if(!xsd.valid)throw new NavQueueWorkerError('NAV_XSD_FAILED','A generált NAV XML nem felel meg a rögzített hivatalos XSD-nek.');
  const s=(await db.query(`INSERT INTO nav_invoice_submissions(invoice_id,work_order_id,invoice_number,operation,environment,status,invoice_xml,created_by,xsd_validation_status,xsd_validated_at,xsd_errors,xsd_schema_revision,invoice_xml_sha256) VALUES($1,$2,$3,$4,$5,'prepared',$6,$7,'passed',now(),'[]'::jsonb,$8,$9) RETURNING *`,[inv.id,inv.work_order_id||null,inv.invoice_no,operation,environment,xml,createdBy,xsd.schema_revision,xsd.xml_sha256])).rows[0];
  await recordXsd(String(inv.id),String(s.id),xsd,createdBy).catch(()=>undefined);
  return s;
}

export async function submitPreparedSubmission(submissionId:string){
  let s=(await db.query(`SELECT s.*,i.location_id,i.invoice_type,i.document_kind,i.issued_at FROM nav_invoice_submissions s JOIN finance_invoices i ON i.id=s.invoice_id WHERE s.id=$1::uuid`,[submissionId])).rows[0];
  if(!s)throw new NavQueueWorkerError('SUBMISSION_NOT_FOUND','NAV beküldés nem található.');
  if(s.transaction_id)return{transaction_id:String(s.transaction_id),environment:String(s.environment),operation:String(s.operation),idempotent:true};
  if(String(s.status)==='submitting')throw new NavQueueWorkerError('NAV_SUBMISSION_UNCERTAIN','A NAV beküldés már submitting állapotban van transactionId nélkül; automatikus ismétlés blokkolva.');
  if(String(s.document_kind)!=='tax_invoice'||!s.issued_at)throw new NavQueueWorkerError('INVOICE_NOT_ISSUED','Élesíthető NAV beküldéshez hivatalosan kiállított számla szükséges.');
  const operation=String(s.operation||'').toUpperCase() as NavInvoiceOperation;
  if(!['CREATE','MODIFY','STORNO'].includes(operation))throw new NavQueueWorkerError('NAV_OPERATION_INVALID',`Érvénytelen NAV művelet: ${operation}.`);
  if(operation!==resolveNavOperation(s.invoice_type))throw new NavQueueWorkerError('NAV_OPERATION_MISMATCH','A NAV művelet nem egyezik a számla típusával.');
  if(!String(s.invoice_xml||'').trim())throw new NavQueueWorkerError('NAV_XML_MISSING','A beküldéshez nincs előkészített NAV XML.');

  const c=await activeConfig(s.location_id);
  const environment=String(s.environment||'');
  if(environment!==String(c.environment))throw new NavQueueWorkerError('NAV_ENVIRONMENT_MISMATCH','A beküldés rögzített NAV környezete eltér az aktív konfigurációtól.');
  requireCredentials(c,environment);

  let xsd:NavXsdValidationResult;
  try{xsd=await validateNavInvoiceXmlXsd(String(s.invoice_xml))}catch(e:any){throw new NavQueueWorkerError('NAV_XSD_ENGINE_ERROR',`A lokális NAV XSD motor nem érhető el: ${String(e?.message||e)}`,true)}
  await recordXsd(String(s.invoice_id),String(s.id),xsd,'nav-queue-worker').catch(()=>undefined);
  if(!xsd.valid)throw new NavQueueWorkerError('NAV_XSD_FAILED','A tárolt NAV XML XSD-validációja sikertelen; hálózati beküldés nem történt.');

  const id=requestId('KLEOWM');
  const claimed=(await db.query(`UPDATE nav_invoice_submissions SET status='submitting',request_id=$2,error_code=NULL,error_message=NULL,updated_at=now() WHERE id=$1::uuid AND transaction_id IS NULL AND status IN ('prepared','error') RETURNING *`,[submissionId,id])).rows[0];
  if(!claimed){
    const current=(await db.query(`SELECT * FROM nav_invoice_submissions WHERE id=$1::uuid`,[submissionId])).rows[0];
    if(current?.transaction_id)return{transaction_id:String(current.transaction_id),environment:String(current.environment),operation:String(current.operation),idempotent:true};
    throw new NavQueueWorkerError('NAV_SUBMISSION_BUSY','A NAV beküldést másik folyamat már feldolgozza.');
  }
  s={...s,...claimed};

  let token:string;
  try{token=await exchangeToken(c)}catch(e:any){
    await db.query(`UPDATE nav_invoice_submissions SET status='prepared',error_code=$2,error_message=$3,updated_at=now() WHERE id=$1::uuid AND transaction_id IS NULL`,[submissionId,e?.code||'NAV_TOKEN_ERROR',String(e?.message||e)]).catch(()=>undefined);
    throw e;
  }

  const timestamp=new Date().toISOString(),invoiceData=Buffer.from(String(s.invoice_xml),'utf8').toString('base64');
  const partial=sha3(operation+invoiceData),signature=sha3(id+compact(timestamp)+String(c.signing_key)+partial);
  const xml=`<?xml version="1.0" encoding="UTF-8"?><ManageInvoiceRequest xmlns="http://schemas.nav.gov.hu/OSA/3.0/api">${commonHeader(c,id,timestamp,signature)}${software(c)}<exchangeToken>${esc(token)}</exchangeToken><invoiceOperations><compressedContent>false</compressedContent><invoiceOperation><index>1</index><invoiceOperation>${operation}</invoiceOperation><invoiceData>${invoiceData}</invoiceData></invoiceOperation></invoiceOperations></ManageInvoiceRequest>`;
  await db.query(`UPDATE nav_invoice_submissions SET request_xml=$2,updated_at=now() WHERE id=$1::uuid`,[submissionId,xml]);
  let response:string;
  try{
    const r=await axios.post(`${apiBase(environment)}/manageInvoice`,xml,{headers:{'Content-Type':'application/xml'},timeout:30000});
    response=String(r.data);
  }catch(e:any){
    const message=`NAV manageInvoice hálózati eredménye bizonytalan: ${String(e?.message||e)}`;
    await db.query(`UPDATE nav_invoice_submissions SET status='error',error_code='NAV_MANAGE_UNCERTAIN',error_message=$2,updated_at=now() WHERE id=$1::uuid`,[submissionId,message]).catch(()=>undefined);
    throw new NavQueueWorkerError('NAV_MANAGE_UNCERTAIN',`${message}. Biztonsági okból automatikus újraküldés nem történik.`);
  }
  const transactionId=response.match(/<transactionId>([^<]+)<\/transactionId>/)?.[1];
  if(!transactionId){
    await db.query(`UPDATE nav_invoice_submissions SET status='error',response_xml=$2,error_code='NAV_MANAGE_NO_TRANSACTION',error_message='A NAV manageInvoice válasz nem tartalmaz transactionId-t.',updated_at=now() WHERE id=$1::uuid`,[submissionId,response]).catch(()=>undefined);
    throw new NavQueueWorkerError('NAV_MANAGE_NO_TRANSACTION','A NAV manageInvoice válasz nem tartalmaz transactionId-t; automatikus újraküldés blokkolva.');
  }
  await db.query(`UPDATE nav_invoice_submissions SET status='submitted',transaction_id=$2,response_xml=$3,submitted_at=now(),error_code=NULL,error_message=NULL,updated_at=now() WHERE id=$1::uuid`,[submissionId,transactionId,response]);
  await db.query(`UPDATE finance_invoices SET nav_status='submitted',nav_transaction_id=$2,nav_submission_id=$3 WHERE id=$1::uuid`,[s.invoice_id,transactionId,submissionId]);
  return{transaction_id:transactionId,environment,operation,idempotent:false};
}

const tag=(xml:string,name:string)=>xml.match(new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:\\w+:)?${name}>`,'i'))?.[1]?.trim()||null;
const blocks=(xml:string,name:string)=>[...xml.matchAll(new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:\\w+:)?${name}>`,'gi'))].map(x=>x[1]);
function validationMessages(xml:string){
  const result:any[]=[];
  for(const kind of ['businessValidationMessages','technicalValidationMessages'])for(const block of blocks(xml,kind))result.push({type:kind.startsWith('business')?'business':'technical',result_code:String(tag(block,'validationResultCode')||'').toUpperCase()||null,error_code:tag(block,'validationErrorCode')||null,message:tag(block,'message')||null,pointer:tag(block,'pointer')||null});
  return result;
}

export async function refreshSubmissionStatus(submissionId:string){
  const s=(await db.query(`SELECT s.*,i.location_id FROM nav_invoice_submissions s JOIN finance_invoices i ON i.id=s.invoice_id WHERE s.id=$1::uuid`,[submissionId])).rows[0];
  if(!s)throw new NavQueueWorkerError('SUBMISSION_NOT_FOUND','NAV beküldés nem található.');
  if(!s.transaction_id)throw new NavQueueWorkerError('TRANSACTION_ID_MISSING','A NAV státuszlekérdezéshez még nincs transactionId.');
  if(terminalSubmissionStatuses.has(String(s.status)))return{status:String(s.status),terminal:true,nav_result:s.nav_result||null};
  const environment=String(s.environment||'');
  const c=await activeConfig(s.location_id);
  if(String(c.environment)!==environment)throw new NavQueueWorkerError('NAV_ENVIRONMENT_MISMATCH','A NAV konfiguráció környezete eltér a beküldés rögzített környezetétől.');
  requireCredentials(c,environment);
  const id=requestId('KLEOWS'),timestamp=new Date().toISOString(),signature=sha3(id+compact(timestamp)+String(c.signing_key));
  const xml=`<?xml version="1.0" encoding="UTF-8"?><QueryTransactionStatusRequest xmlns="http://schemas.nav.gov.hu/OSA/3.0/api">${commonHeader(c,id,timestamp,signature)}${software(c)}<transactionId>${esc(s.transaction_id)}</transactionId><returnOriginalRequest>false</returnOriginalRequest></QueryTransactionStatusRequest>`;
  let text:string;
  try{const r=await axios.post(`${apiBase(environment)}/queryTransactionStatus`,xml,{headers:{'Content-Type':'application/xml'},timeout:20000});text=String(r.data)}catch(e:any){throw new NavQueueWorkerError('NAV_STATUS_NETWORK',`NAV queryTransactionStatus átmeneti hálózati hiba: ${String(e?.message||e)}`,true)}
  const processing=blocks(text,'processingResult'),invoiceStatuses=processing.map(x=>String(tag(x,'invoiceStatus')||'').toUpperCase()).filter(Boolean),messages=validationMessages(text),errors=messages.filter(x=>x.result_code==='ERROR'),warnings=messages.filter(x=>x.result_code==='WARN');
  let mapped='processing';
  if(invoiceStatuses.includes('ABORTED'))mapped='aborted';
  else if(errors.length)mapped='error';
  else if(invoiceStatuses.length&&invoiceStatuses.every(x=>x==='DONE'))mapped=warnings.length?'warning':'done';
  else if(invoiceStatuses.length&&invoiceStatuses.every(x=>['RECEIVED','PROCESSING','SAVED','DONE'].includes(x)))mapped='processing';
  else if(!invoiceStatuses.length)throw new NavQueueWorkerError('NAV_STATUS_EMPTY','A NAV queryTransactionStatus válaszban nincs feldolgozási állapot.',true);
  const result={invoice_statuses:invoiceStatuses,validation_messages:messages,warning_count:warnings.length,error_count:errors.length};
  const firstProblem=errors[0]||warnings[0]||null;
  await db.query(`UPDATE nav_invoice_submissions SET status=$2,response_xml=$3,nav_result=$4::jsonb,error_code=$5,error_message=$6,completed_at=CASE WHEN $2 IN ('done','warning','error','aborted') THEN now() ELSE completed_at END,updated_at=now() WHERE id=$1::uuid`,[s.id,mapped,text,JSON.stringify(result),firstProblem?.error_code||null,firstProblem?.message||null]);
  await db.query(`UPDATE finance_invoices SET nav_status=$2,nav_last_polled_at=now(),nav_last_result=$3::jsonb,nav_warning_count=$4,nav_error_count=$5 WHERE id=$1::uuid`,[s.invoice_id,mapped,JSON.stringify(result),warnings.length,errors.length]);
  return{status:mapped,terminal:['done','warning','error','aborted'].includes(mapped),...result};
}

function backoffSeconds(attempts:number){return Math.min(900,30*Math.pow(2,Math.max(0,attempts-1)))}
async function claimQueued(){
  const c=await db.connect();
  try{
    await c.query('BEGIN');
    const row=(await c.query(`SELECT q.id,q.invoice_id,q.attempts FROM nav_invoice_queue q JOIN finance_invoices i ON i.id=q.invoice_id JOIN LATERAL (SELECT s.* FROM nav_online_invoice_settings s WHERE s.active=true AND (s.location_id=i.location_id OR s.location_id IS NULL) ORDER BY CASE WHEN s.location_id=i.location_id THEN 0 ELSE 1 END LIMIT 1) cfg ON true WHERE q.status='queued' AND q.next_attempt_at<=now() AND cfg.auto_submit=true AND (cfg.environment='test' OR cfg.auto_submit_test_only=false) ORDER BY q.created_at FOR UPDATE OF q SKIP LOCKED LIMIT 1`)).rows[0];
    if(!row){await c.query('COMMIT');return null}
    const claimed=(await c.query(`UPDATE nav_invoice_queue SET status='processing',attempts=attempts+1,last_attempt_at=now(),last_error=NULL,last_error_code=NULL,updated_at=now() WHERE id=$1 RETURNING *`,[row.id])).rows[0];
    await c.query('COMMIT');return claimed;
  }catch(e){await c.query('ROLLBACK').catch(()=>undefined);throw e}finally{c.release()}
}

async function processOneQueued(){
  const q=await claimQueued();if(!q)return false;
  state.processed++;
  try{
    const submission=await prepareQueuedInvoice(String(q.invoice_id));
    await db.query(`UPDATE nav_invoice_queue SET submission_id=$2,updated_at=now() WHERE id=$1`,[q.id,submission.id]);
    const submitted=await submitPreparedSubmission(String(submission.id));
    await db.query(`UPDATE nav_invoice_queue SET status='submitted',submission_id=$2,next_attempt_at=now()+($3::text||' seconds')::interval,last_result=$4::jsonb,last_error=NULL,last_error_code=NULL,updated_at=now() WHERE id=$1`,[q.id,submission.id,String(POLL_SECONDS),JSON.stringify(submitted)]);
    await db.query(`UPDATE finance_invoices SET nav_queue_status='submitted' WHERE id=$1::uuid`,[q.invoice_id]);
    state.submitted++;return true;
  }catch(e:any){
    const retryable=Boolean(e?.retryable)&&Number(q.attempts)<MAX_ATTEMPTS,code=String(e?.code||'NAV_QUEUE_ERROR'),message=String(e?.message||e).slice(0,4000);
    if(retryable){const delay=backoffSeconds(Number(q.attempts));await db.query(`UPDATE nav_invoice_queue SET status='queued',next_attempt_at=now()+($2::text||' seconds')::interval,last_error=$3,last_error_code=$4,updated_at=now() WHERE id=$1`,[q.id,String(delay),message,code]);}
    else{await db.query(`UPDATE nav_invoice_queue SET status='error',completed_at=now(),last_error=$2,last_error_code=$3,updated_at=now() WHERE id=$1`,[q.id,message,code]);await db.query(`UPDATE finance_invoices SET nav_queue_status='error' WHERE id=$1::uuid`,[q.invoice_id]).catch(()=>undefined)}
    return true;
  }
}

async function pollSubmitted(){
  const rows=(await db.query(`SELECT q.*,COALESCE(q.submission_id,i.nav_submission_id,(SELECT s.id FROM nav_invoice_submissions s WHERE s.invoice_id=q.invoice_id AND s.transaction_id IS NOT NULL ORDER BY s.created_at DESC LIMIT 1)) effective_submission_id FROM nav_invoice_queue q JOIN finance_invoices i ON i.id=q.invoice_id JOIN LATERAL (SELECT s.* FROM nav_online_invoice_settings s WHERE s.active=true AND (s.location_id=i.location_id OR s.location_id IS NULL) ORDER BY CASE WHEN s.location_id=i.location_id THEN 0 ELSE 1 END LIMIT 1) cfg ON true WHERE q.status='submitted' AND q.next_attempt_at<=now() AND cfg.auto_refresh=true ORDER BY q.updated_at LIMIT $1`,[BATCH_SIZE])).rows;
  for(const q of rows){
    if(!q.effective_submission_id){await db.query(`UPDATE nav_invoice_queue SET status='error',completed_at=now(),last_error_code='SUBMISSION_NOT_FOUND',last_error='A NAV státuszlekérdezéshez nem található submission.',updated_at=now() WHERE id=$1`,[q.id]);continue}
    try{
      const result=await refreshSubmissionStatus(String(q.effective_submission_id));state.refreshed++;
      if(result.status==='done'||result.status==='warning'){
        await db.query(`UPDATE nav_invoice_queue SET status=$2,submission_id=$3,completed_at=now(),last_result=$4::jsonb,last_error=NULL,last_error_code=NULL,updated_at=now() WHERE id=$1`,[q.id,result.status,q.effective_submission_id,JSON.stringify(result)]);
        await db.query(`UPDATE finance_invoices SET nav_queue_status=$2 WHERE id=$1::uuid`,[q.invoice_id,result.status]);
      }else if(result.status==='error'||result.status==='aborted'){
        await db.query(`UPDATE nav_invoice_queue SET status='error',submission_id=$2,completed_at=now(),last_result=$3::jsonb,last_error=$4,last_error_code=$5,updated_at=now() WHERE id=$1`,[q.id,q.effective_submission_id,JSON.stringify(result),`NAV feldolgozási állapot: ${result.status}`,String(result.status).toUpperCase()]);
        await db.query(`UPDATE finance_invoices SET nav_queue_status='error' WHERE id=$1::uuid`,[q.invoice_id]);
      }else{
        await db.query(`UPDATE nav_invoice_queue SET status='submitted',submission_id=$2,next_attempt_at=now()+($3::text||' seconds')::interval,last_result=$4::jsonb,updated_at=now() WHERE id=$1`,[q.id,q.effective_submission_id,String(POLL_SECONDS),JSON.stringify(result)]);
      }
    }catch(e:any){
      const delay=e?.retryable?backoffSeconds(Math.max(1,Number(q.attempts||1))):300;
      await db.query(`UPDATE nav_invoice_queue SET next_attempt_at=now()+($2::text||' seconds')::interval,last_error=$3,last_error_code=$4,updated_at=now() WHERE id=$1`,[q.id,String(delay),String(e?.message||e).slice(0,4000),String(e?.code||'NAV_STATUS_ERROR')]);
    }
  }
}

export async function runNavQueueWorkerOnce(){
  if(state.running)return{skipped:true,reason:'already_running',state:{...state}};
  state.running=true;state.last_tick_at=new Date().toISOString();
  try{
    await ensureNavInvoiceCore();
    for(let i=0;i<BATCH_SIZE;i++){const worked=await processOneQueued();if(!worked)break}
    await pollSubmitted();
    state.last_success_at=new Date().toISOString();state.last_error=null;
    return{ok:true,state:{...state}};
  }catch(e:any){state.last_error_at=new Date().toISOString();state.last_error=String(e?.message||e);throw e}
  finally{state.running=false}
}

export async function getNavQueueWorkerStatus(){
  let counts:any[]=[];
  try{counts=(await db.query(`SELECT status,COUNT(*)::int count FROM nav_invoice_queue GROUP BY status ORDER BY status`)).rows}catch{}
  return{...state,interval_seconds:POLL_SECONDS,max_attempts:MAX_ATTEMPTS,batch_size:BATCH_SIZE,queue_counts:counts};
}

export function startNavQueueWorker(){
  if(timer)return;
  state.enabled=!/^(0|false|off|no)$/i.test(String(process.env.NAV_QUEUE_WORKER_ENABLED??'true'));
  if(!state.enabled){console.log('[NAV queue worker] disabled');return}
  state.started_at=new Date().toISOString();
  const intervalMs=POLL_SECONDS*1000;
  timer=setInterval(()=>void runNavQueueWorkerOnce().catch(e=>console.error('[NAV queue worker]',e?.message||e)),intervalMs);
  timer.unref?.();
  setTimeout(()=>void runNavQueueWorkerOnce().catch(e=>console.error('[NAV queue worker startup]',e?.message||e)),2000).unref?.();
  console.log(`[NAV queue worker] started, interval=${POLL_SECONDS}s batch=${BATCH_SIZE}`);
}
