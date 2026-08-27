import {Router} from 'express';
import axios from 'axios';
import crypto from 'crypto';
import db from '../db';
import {requireAuth,AuthRequest} from '../middleware/auth';
import {requireRoles} from '../middleware/requireRoles';
import {parseRoleKeys} from '../security/roles';
import {buildNavInvoiceXml,resolveNavOperation,validateNavXmlPrerequisites,NavInvoiceOperation} from '../nav/navInvoiceXml';
import {validateNavInvoiceXmlXsd} from '../nav/navXsdValidator';

const router=Router();
router.use(requireAuth);
router.use(requireRoles('admin','manager','accounting','bookkeeper','location_manager','salon_manager'));

const sendRoles=new Set(['admin','manager','accounting','bookkeeper']);
const actor=(req:AuthRequest)=>req.user?.email||String(req.user?.id||'');
const text=(v:any)=>String(v??'').trim();
const digits=(v:any)=>text(v).replace(/\D/g,'');
const money=(v:any)=>Math.round(Number(v||0)*100)/100;
const esc=(v:any)=>String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
const sha512=(s:string)=>crypto.createHash('sha512').update(s,'utf8').digest('hex').toUpperCase();
const sha3=(s:string)=>crypto.createHash('sha3-512').update(s,'utf8').digest('hex').toUpperCase();
const rid=()=>`KLEO${Date.now()}${crypto.randomBytes(5).toString('hex')}`.toUpperCase().slice(0,30);
const ts=()=>new Date().toISOString();
const compact=(iso:string)=>iso.replace(/[-:TZ.]/g,'').slice(0,14);
const apiBase=(env:string)=>env==='live'?'https://api.onlineszamla.nav.gov.hu/invoiceService/v3':'https://api-test.onlineszamla.nav.gov.hu/invoiceService/v3';
const PAYMENT_MAP:Record<string,string>={cash:'CASH',keszpenz:'CASH','készpénz':'CASH',card:'CARD',bankcard:'CARD','bankkártya':'CARD',transfer:'TRANSFER',atutalas:'TRANSFER','átutalás':'TRANSFER',other:'OTHER',voucher:'OTHER'};

function canSend(req:AuthRequest){return parseRoleKeys(req.user?.role).some(r=>sendRoles.has(r));}
function payment(v:any){const raw=text(v);if(!raw)return'OTHER';const up=raw.toUpperCase();if(['CASH','CARD','TRANSFER','OTHER'].includes(up))return up;return PAYMENT_MAP[raw.toLowerCase()]||'OTHER';}
function commonHeader(c:any,requestId:string,timestamp:string,signature:string){return `<header><requestId>${requestId}</requestId><timestamp>${timestamp}</timestamp><requestVersion>3.0</requestVersion><headerVersion>1.0</headerVersion></header><user><login>${esc(c.technical_login)}</login><passwordHash cryptoType="SHA-512">${sha512(String(c.technical_password||''))}</passwordHash><taxNumber>${esc(digits(c.supplier_tax_number).slice(0,8))}</taxNumber><requestSignature cryptoType="SHA3-512">${signature}</requestSignature></user>`;}
function software(c:any){return `<software><softwareId>${esc(c.software_id)}</softwareId><softwareName>${esc(c.software_name)}</softwareName><softwareOperation>${esc(c.software_operation||'ONLINE_SERVICE')}</softwareOperation><softwareMainVersion>${esc(c.software_main_version||'1.0')}</softwareMainVersion><softwareDevName>${esc(c.software_dev_name)}</softwareDevName>${c.software_dev_contact?`<softwareDevContact>${esc(c.software_dev_contact)}</softwareDevContact>`:''}<softwareDevCountryCode>${esc(c.software_dev_country_code||'HU')}</softwareDevCountryCode></software>`;}
function decryptToken(encoded:string,keyHex:string){const key=Buffer.from(keyHex,'hex');const decipher=crypto.createDecipheriv('aes-128-ecb',key,null);decipher.setAutoPadding(true);return Buffer.concat([decipher.update(Buffer.from(encoded,'base64')),decipher.final()]).toString('utf8');}
async function exchangeToken(c:any){for(const k of ['technical_login','technical_password','signing_key','exchange_key'])if(!c[k])throw new Error(`NAV technikai hitelesítő adat hiányzik: ${k}`);const requestId=rid(),timestamp=ts(),signature=sha3(requestId+compact(timestamp)+String(c.signing_key));const xml=`<?xml version="1.0" encoding="UTF-8"?><TokenExchangeRequest xmlns="http://schemas.nav.gov.hu/OSA/3.0/api">${commonHeader(c,requestId,timestamp,signature)}${software(c)}</TokenExchangeRequest>`;const r=await axios.post(`${apiBase(c.environment)}/tokenExchange`,xml,{headers:{'Content-Type':'application/xml'},timeout:20000});const encoded=String(r.data).match(/<encodedExchangeToken>([^<]+)<\/encodedExchangeToken>/)?.[1];if(!encoded)throw new Error(`NAV tokenExchange sikertelen: ${String(r.data).slice(0,500)}`);return{token:decryptToken(encoded,String(c.exchange_key)),requestId};}

async function entity(entityId:string){return (await db.query(`SELECT * FROM legal_entities WHERE id=$1::uuid AND active=true`,[entityId])).rows[0]||null;}
async function config(entityId:string,locationId?:string|null){
 const r=await db.query(`SELECT * FROM nav_online_invoice_settings WHERE active=true AND legal_entity_id=$1::uuid AND ($2::text='' OR location_id::text=$2 OR location_id IS NULL) ORDER BY CASE WHEN location_id::text=$2 THEN 0 ELSE 1 END LIMIT 1`,[entityId,String(locationId||'')]);
 if(!r.rows[0])throw new Error('Ehhez a céghez nincs aktív NAV Online Számla konfiguráció.');
 return r.rows[0];
}
async function bundle(documentId:string){
 const d=(await db.query(`SELECT d.*,e.legal_name,e.tax_number entity_tax_number,e.registered_country_code,e.registered_postal_code,e.registered_city,e.registered_address_line,e.bank_account_number,e.invoice_prefix FROM external_financial_documents d JOIN legal_entities e ON e.id=d.legal_entity_id WHERE d.id=$1::uuid`,[documentId])).rows[0];
 if(!d)return null;
 const lines=(await db.query(`SELECT * FROM external_financial_document_lines WHERE document_id=$1::uuid ORDER BY line_number`,[documentId])).rows;
 return{d,lines};
}
function asInvoice(d:any){
 const tax=digits(d.counterparty_tax_number);
 return{
  invoice_no:d.external_document_number,
  issue_date:d.issue_date,
  performance_date:d.performance_date||d.issue_date,
  due_date:d.due_date||d.issue_date,
  currency:String(d.currency||'HUF').toUpperCase(),
  exchange_rate:1,
  customer_name:d.counterparty_name,
  partner_name:d.counterparty_name,
  customer_tax_number:tax||null,
  partner_tax_no:tax||null,
  customer_vat_status:String(d.customer_vat_status||(tax?'DOMESTIC':'PRIVATE_PERSON')).toUpperCase(),
  customer_country_code:String(d.customer_country_code||'HU').toUpperCase(),
  customer_postal_code:d.customer_postal_code,
  customer_city:d.customer_city,
  customer_address:d.customer_address,
  payment_method:payment(d.payment_method),
  appearance:'ELECTRONIC',
  net_total:money(d.net_amount),
  vat_total:money(d.vat_amount),
  gross_total:money(d.gross_amount),
  invoice_type:String(d.invoice_type||'NORMAL').toUpperCase(),
  original_invoice_number:d.original_invoice_number,
  modification_index:d.modification_index,
 };
}
function readiness(d:any,lines:any[],cfg:any){
 const errors:string[]=[];
 if(d.status!=='approved')errors.push('A bizonylatot előbb jóvá kell hagyni az ellenőrzési munkasorban.');
 if(!['invoice','credit_note'].includes(String(d.document_type)))errors.push('NAV Online Számla felé csak számla vagy módosító számla küldhető.');
 if(!text(d.external_document_number))errors.push('A számlaszám hiányzik.');
 if(!d.issue_date)errors.push('A kiállítás dátuma hiányzik.');
 if(!d.performance_date)errors.push('A teljesítés dátuma hiányzik.');
 if(!d.due_date)errors.push('A fizetési határidő hiányzik.');
 const sumNet=money(lines.reduce((s,x)=>s+Number(x.net_amount||0),0)),sumVat=money(lines.reduce((s,x)=>s+Number(x.vat_amount||0),0)),sumGross=money(lines.reduce((s,x)=>s+Number(x.gross_amount||0),0));
 if(!lines.length)errors.push('A számlatételek hiányoznak. PDF vagy összesítő import után a tételeket kézzel ellenőrizni/rögzíteni kell.');
 if(lines.length&&Math.abs(sumNet-money(d.net_amount))>.02)errors.push('A tételek nettó összege nem egyezik a számla nettó végösszegével.');
 if(lines.length&&Math.abs(sumVat-money(d.vat_amount))>.02)errors.push('A tételek ÁFA összege nem egyezik a számla ÁFA végösszegével.');
 if(lines.length&&Math.abs(sumGross-money(d.gross_amount))>.02)errors.push('A tételek bruttó összege nem egyezik a számla bruttó végösszegével.');
 const nav=validateNavXmlPrerequisites(asInvoice(d),lines,cfg);
 return{ready:errors.length===0&&nav.valid,errors:[...errors,...nav.errors],nav};
}
async function audit(documentId:string,req:AuthRequest,eventType:string,payload:any={}){await db.query(`INSERT INTO external_financial_document_events(document_id,event_type,actor,payload) VALUES($1::uuid,$2,$3,$4::jsonb)`,[documentId,eventType,actor(req),JSON.stringify(payload||{})]);}

router.get('/nav/settings',async(req:AuthRequest,res)=>{
 try{
  const entityId=text(req.query.legal_entity_id),locationId=text(req.query.location_id)||null;if(!entityId)return res.status(400).json({message:'A cég kiválasztása kötelező.'});
  const e=await entity(entityId);if(!e)return res.status(404).json({message:'A cég nem található.'});
  let c:any=null;try{c=await config(entityId,locationId)}catch{}
  if(c){c={...c};for(const k of ['technical_password','signing_key','exchange_key'])if(c[k])c[k]='********';}
  res.json({entity:{id:e.id,legal_name:e.legal_name,tax_number:e.tax_number},settings:c});
 }catch(e:any){res.status(409).json({message:e.message});}
});

router.put('/nav/settings',async(req:AuthRequest,res)=>{
 if(!canSend(req))return res.status(403).json({message:'NAV technikai beállítást csak adminisztrátor vagy könyvelési jogosultságú felhasználó módosíthat.'});
 const entityId=text(req.body?.legal_entity_id),locationId=text(req.body?.location_id)||null;
 try{
  const e=await entity(entityId);if(!e)return res.status(404).json({message:'A cég nem található.'});
  const existing=(await db.query(`SELECT * FROM nav_online_invoice_settings WHERE legal_entity_id=$1::uuid AND (($2::uuid IS NULL AND location_id IS NULL) OR location_id=$2::uuid) LIMIT 1`,[entityId,locationId])).rows[0];
  const secret=(name:string)=>{const v=text(req.body?.[name]);return!v||/^\*+$/.test(v)?existing?.[name]||null:v;};
  const values={
   environment:['test','live'].includes(text(req.body?.environment))?text(req.body.environment):'test',
   technical_login:text(req.body?.technical_login)||existing?.technical_login||null,
   technical_password:secret('technical_password'),signing_key:secret('signing_key'),exchange_key:secret('exchange_key'),
   software_id:text(req.body?.software_id)||existing?.software_id||'KLEOSZALONVIR0001',software_name:text(req.body?.software_name)||existing?.software_name||'Kleoszalon VIR',
   software_main_version:text(req.body?.software_main_version)||existing?.software_main_version||'1.0',software_dev_name:text(req.body?.software_dev_name)||existing?.software_dev_name||'Kleopatra2003 Kft',software_dev_contact:text(req.body?.software_dev_contact)||existing?.software_dev_contact||null,
  };
  let row:any;
  if(existing){row=(await db.query(`UPDATE nav_online_invoice_settings SET location_id=$2::uuid,environment=$3,supplier_name=$4,supplier_tax_number=$5,supplier_bank_account=$6,supplier_country_code=$7,supplier_postal_code=$8,supplier_city=$9,supplier_address=$10,invoice_prefix=$11,currency='HUF',technical_login=$12,technical_password=$13,signing_key=$14,exchange_key=$15,software_id=$16,software_name=$17,software_main_version=$18,software_dev_name=$19,software_dev_contact=$20,software_dev_country_code='HU',active=true,updated_at=now() WHERE id=$1 RETURNING *`,[existing.id,locationId,values.environment,e.legal_name,digits(e.tax_number),e.bank_account_number||null,e.registered_country_code||'HU',e.registered_postal_code,e.registered_city,e.registered_address_line,e.invoice_prefix||'KLEO',values.technical_login,values.technical_password,values.signing_key,values.exchange_key,values.software_id,values.software_name,values.software_main_version,values.software_dev_name,values.software_dev_contact])).rows[0];}
  else{row=(await db.query(`INSERT INTO nav_online_invoice_settings(legal_entity_id,location_id,environment,supplier_name,supplier_tax_number,supplier_bank_account,supplier_country_code,supplier_postal_code,supplier_city,supplier_address,invoice_prefix,currency,technical_login,technical_password,signing_key,exchange_key,software_id,software_name,software_operation,software_main_version,software_dev_name,software_dev_contact,software_dev_country_code,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'HUF',$12,$13,$14,$15,$16,$17,'ONLINE_SERVICE',$18,$19,$20,'HU',true) RETURNING *`,[entityId,locationId,values.environment,e.legal_name,digits(e.tax_number),e.bank_account_number||null,e.registered_country_code||'HU',e.registered_postal_code,e.registered_city,e.registered_address_line,e.invoice_prefix||'KLEO',values.technical_login,values.technical_password,values.signing_key,values.exchange_key,values.software_id,values.software_name,values.software_main_version,values.software_dev_name,values.software_dev_contact])).rows[0];}
  for(const k of ['technical_password','signing_key','exchange_key'])if(row[k])row[k]='********';
  res.json({ok:true,settings:row});
 }catch(e:any){res.status(409).json({message:e.message});}
});

router.post('/nav/connection-test',async(req:AuthRequest,res)=>{
 try{const entityId=text(req.body?.legal_entity_id),locationId=text(req.body?.location_id)||null;const c=await config(entityId,locationId);const t=await exchangeToken(c);res.json({ok:true,environment:c.environment,request_id:t.requestId,message:'NAV tokenExchange sikeres ehhez a céghez.'});}catch(e:any){res.status(409).json({ok:false,message:e.message});}
});

router.get('/documents/:id/nav-status',async(req:AuthRequest,res)=>{
 try{
  const b=await bundle(req.params.id);if(!b)return res.status(404).json({message:'A bizonylat nem található.'});
  let c:any=null;try{c=await config(String(b.d.legal_entity_id),b.d.location_id)}catch{}
  const ready=c?readiness(b.d,b.lines,c):{ready:false,errors:['Ehhez a céghez nincs aktív NAV Online Számla konfiguráció.'],nav:null};
  const submission=b.d.finance_invoice_id?(await db.query(`SELECT id,status,transaction_id,error_code,error_message,environment,submitted_at,completed_at,created_at FROM nav_invoice_submissions WHERE invoice_id=$1::uuid ORDER BY created_at DESC LIMIT 1`,[b.d.finance_invoice_id])).rows[0]||null:null;
  res.json({document:b.d,lines:b.lines,readiness:ready,nav_configured:Boolean(c),submission});
 }catch(e:any){res.status(409).json({message:e.message});}
});

router.put('/documents/:id/nav-details',async(req:AuthRequest,res)=>{
 const c=await db.connect();try{
  await c.query('BEGIN');
  const current=(await c.query(`SELECT * FROM external_financial_documents WHERE id=$1::uuid FOR UPDATE`,[req.params.id])).rows[0];if(!current){await c.query('ROLLBACK');return res.status(404).json({message:'A bizonylat nem található.'});}
  if(['submitted','processing','done','warning'].includes(String((current.metadata||{}).nav_status||''))){await c.query('ROLLBACK');return res.status(409).json({message:'Már NAV felé küldött bizonylat adatai nem írhatók át.'});}
  const tax=digits(req.body?.counterparty_tax_number??current.counterparty_tax_number);const vatStatus=text(req.body?.customer_vat_status)||(tax?'DOMESTIC':'PRIVATE_PERSON');
  const updated=(await c.query(`UPDATE external_financial_documents SET document_type=$2,external_document_number=$3,issue_date=$4::date,performance_date=$5::date,due_date=$6::date,counterparty_name=$7,counterparty_tax_number=$8,customer_vat_status=$9,customer_country_code=$10,customer_postal_code=$11,customer_city=$12,customer_address=$13,currency=$14,net_amount=$15,vat_amount=$16,gross_amount=$17,payment_method=$18,invoice_type=$19,original_invoice_number=$20,modification_index=$21,updated_at=now() WHERE id=$1 RETURNING *`,[
   req.params.id,text(req.body?.document_type||current.document_type),text(req.body?.external_document_number||current.external_document_number),req.body?.issue_date||current.issue_date,req.body?.performance_date||current.performance_date||current.issue_date,req.body?.due_date||current.due_date||current.issue_date,text(req.body?.counterparty_name||current.counterparty_name),tax||null,vatStatus.toUpperCase(),text(req.body?.customer_country_code||current.customer_country_code||'HU').toUpperCase(),text(req.body?.customer_postal_code||current.customer_postal_code),text(req.body?.customer_city||current.customer_city),text(req.body?.customer_address||current.customer_address),text(req.body?.currency||current.currency||'HUF').toUpperCase(),money(req.body?.net_amount??current.net_amount),money(req.body?.vat_amount??current.vat_amount),money(req.body?.gross_amount??current.gross_amount),payment(req.body?.payment_method||current.payment_method),text(req.body?.invoice_type||current.invoice_type||'NORMAL').toUpperCase(),text(req.body?.original_invoice_number||current.original_invoice_number)||null,req.body?.modification_index?Number(req.body.modification_index):current.modification_index||null
  ])).rows[0];
  if(Array.isArray(req.body?.lines)){
   await c.query(`DELETE FROM external_financial_document_lines WHERE document_id=$1::uuid`,[req.params.id]);
   for(let i=0;i<req.body.lines.length;i++){const l=req.body.lines[i]||{},qty=Number(l.quantity||1),net=money(l.net_amount),vat=money(l.vat_amount),gross=money(l.gross_amount),unit=Number(l.unit_price_net??(qty?net/qty:0)),rate=Number(l.vat_rate);await c.query(`INSERT INTO external_financial_document_lines(document_id,line_number,description,quantity,unit_of_measure,unit_price_net,vat_rate,net_amount,vat_amount,gross_amount,nav_line_number_reference) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[req.params.id,i+1,text(l.description)||`Tétel ${i+1}`,qty,text(l.unit_of_measure)||'PIECE',unit,Number.isFinite(rate)?rate:0.27,net,vat,gross,l.nav_line_number_reference?Number(l.nav_line_number_reference):null]);}
  }
  await c.query('COMMIT');await audit(req.params.id,req,'nav_details_saved',{line_count:Array.isArray(req.body?.lines)?req.body.lines.length:undefined});
  const b=await bundle(req.params.id);let cfg:any=null;try{cfg=await config(String(b!.d.legal_entity_id),b!.d.location_id)}catch{};res.json({ok:true,document:updated,lines:b?.lines||[],readiness:cfg?readiness(b!.d,b!.lines,cfg):{ready:false,errors:['NAV konfiguráció hiányzik.']}});
 }catch(e:any){await c.query('ROLLBACK').catch(()=>undefined);res.status(409).json({message:e.message});}finally{c.release();}
});

async function promote(documentId:string,req:AuthRequest){
 const c=await db.connect();try{
  await c.query('BEGIN');
  const d=(await c.query(`SELECT d.*,e.legal_name,e.tax_number entity_tax_number FROM external_financial_documents d JOIN legal_entities e ON e.id=d.legal_entity_id WHERE d.id=$1::uuid FOR UPDATE OF d`,[documentId])).rows[0];if(!d)throw new Error('A bizonylat nem található.');
  const lines=(await c.query(`SELECT * FROM external_financial_document_lines WHERE document_id=$1::uuid ORDER BY line_number`,[documentId])).rows;
  const cfg=await config(String(d.legal_entity_id),d.location_id);const check=readiness(d,lines,cfg);if(!check.ready)throw Object.assign(new Error('A számla még nem küldhető a NAV-nak.'),{details:check.errors});
  const inv=asInvoice(d);let finance:any;
  if(d.finance_invoice_id){finance=(await c.query(`UPDATE finance_invoices SET location_id=$2,legal_entity_id=$3,direction='outgoing',invoice_no=$4,partner_name=$5,customer_name=$5,partner_tax_no=$6,customer_tax_number=$6,customer_vat_status=$7,customer_country_code=$8,customer_postal_code=$9,customer_city=$10,customer_address=$11,issue_date=$12,performance_date=$13,due_date=$14,currency='HUF',exchange_rate=1,net_total=$15,vat_total=$16,gross_total=$17,status='approved',document_kind='tax_invoice',invoice_type=$18,original_invoice_number=$19,modification_index=$20,payment_method=$21,issued_at=COALESCE(issued_at,now()),issued_by=COALESCE(issued_by,$22),nav_status=CASE WHEN nav_status IN('submitted','processing','done','warning') THEN nav_status ELSE 'not_submitted' END,updated_at=now() WHERE id=$1 RETURNING *`,[d.finance_invoice_id,d.location_id||null,d.legal_entity_id,d.external_document_number,d.counterparty_name,d.counterparty_tax_number||null,inv.customer_vat_status,inv.customer_country_code,inv.customer_postal_code,inv.customer_city,inv.customer_address,inv.issue_date,inv.performance_date,inv.due_date,d.net_amount,d.vat_amount,d.gross_amount,inv.invoice_type,inv.original_invoice_number||null,inv.modification_index||null,inv.payment_method,actor(req)])).rows[0];await c.query(`DELETE FROM finance_invoice_lines WHERE invoice_id=$1`,[finance.id]);}
  else{finance=(await c.query(`INSERT INTO finance_invoices(location_id,legal_entity_id,direction,invoice_no,partner_name,customer_name,partner_tax_no,customer_tax_number,customer_vat_status,customer_country_code,customer_postal_code,customer_city,customer_address,issue_date,performance_date,due_date,currency,exchange_rate,net_total,vat_total,gross_total,status,note,created_by,document_kind,invoice_type,original_invoice_number,modification_index,nav_status,nav_validation_status,payment_method,issued_at,issued_by) VALUES($1,$2,'outgoing',$3,$4,$4,$5,$5,$6,$7,$8,$9,$10,$11,$12,$13,'HUF',1,$14,$15,$16,'approved',$17,$18,'tax_invoice',$19,$20,$21,'not_submitted','not_validated',$22,now(),$18) RETURNING *`,[d.location_id||null,d.legal_entity_id,d.external_document_number,d.counterparty_name,d.counterparty_tax_number||null,inv.customer_vat_status,inv.customer_country_code,inv.customer_postal_code,inv.customer_city,inv.customer_address,inv.issue_date,inv.performance_date,inv.due_date,d.net_amount,d.vat_amount,d.gross_amount,`Külső ${d.source} számla NAV-adatszolgáltatáshoz. Forrásazonosító: ${d.external_id||d.id}`,actor(req),inv.invoice_type,inv.original_invoice_number||null,inv.modification_index||null,inv.payment_method])).rows[0];}
  for(const l of lines)await c.query(`INSERT INTO finance_invoice_lines(invoice_id,line_number,description,quantity,unit_of_measure,unit_price_net,vat_rate,net_amount,vat_amount,gross_amount,nav_line_number_reference) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[finance.id,l.line_number,l.description,l.quantity,l.unit_of_measure,l.unit_price_net,l.vat_rate,l.net_amount,l.vat_amount,l.gross_amount,l.nav_line_number_reference||null]);
  await c.query(`UPDATE external_financial_documents SET finance_invoice_id=$2,nav_reporting_owner='vir',nav_excluded=false,updated_at=now() WHERE id=$1`,[documentId,finance.id]);
  await c.query('COMMIT');return{finance,cfg};
 }catch(e){await c.query('ROLLBACK').catch(()=>undefined);throw e}finally{c.release();}
}

router.post('/documents/:id/nav-prepare',async(req:AuthRequest,res)=>{
 if(!canSend(req))return res.status(403).json({message:'NAV előkészítést csak adminisztrátor vagy könyvelési jogosultságú felhasználó indíthat.'});
 try{
  const{finance,cfg}=await promote(req.params.id,req);const lines=(await db.query(`SELECT * FROM finance_invoice_lines WHERE invoice_id=$1::uuid ORDER BY line_number`,[finance.id])).rows;
  const validation=validateNavXmlPrerequisites(finance,lines,cfg);if(!validation.valid)return res.status(409).json({message:'A számla NAV XML előfeltételei hibásak.',errors:validation.errors});
  const xml=buildNavInvoiceXml(cfg,finance,lines);const xsd=await validateNavInvoiceXmlXsd(xml);if(!xsd.valid)return res.status(409).json({message:'A NAV XML nem felel meg a hivatalos XSD-nek.',xsd});
  const operation=resolveNavOperation(finance.invoice_type);const s=(await db.query(`INSERT INTO nav_invoice_submissions(invoice_id,invoice_number,operation,environment,status,invoice_xml,created_by,xsd_validation_status,xsd_validated_at,xsd_errors,xsd_schema_revision,invoice_xml_sha256) VALUES($1,$2,$3,$4,'prepared',$5,$6,'passed',now(),'[]'::jsonb,$7,$8) RETURNING *`,[finance.id,finance.invoice_no,operation,cfg.environment,xml,actor(req),xsd.schema_revision,xsd.xml_sha256])).rows[0];
  await db.query(`UPDATE finance_invoices SET nav_status='prepared',nav_submission_id=$2,nav_xsd_validation_status='passed',nav_xsd_validated_at=now(),nav_xsd_schema_revision=$3,nav_xsd_xml_sha256=$4 WHERE id=$1`,[finance.id,s.id,xsd.schema_revision,xsd.xml_sha256]);
  await db.query(`UPDATE external_financial_documents SET nav_prepared_at=now(),updated_at=now() WHERE id=$1::uuid`,[req.params.id]);await audit(req.params.id,req,'nav_prepared',{submission_id:s.id,environment:cfg.environment});
  res.status(201).json({ok:true,finance_invoice_id:finance.id,submission:{id:s.id,status:s.status,environment:s.environment},xsd:{status:xsd.status,schema_revision:xsd.schema_revision,xml_sha256:xsd.xml_sha256}});
 }catch(e:any){res.status(409).json({message:e.message,errors:e.details||undefined});}
});

router.post('/documents/:id/nav-submit',async(req:AuthRequest,res)=>{
 if(!canSend(req))return res.status(403).json({message:'NAV beküldést csak adminisztrátor vagy könyvelési jogosultságú felhasználó indíthat.'});
 if(req.body?.confirm!==true)return res.status(400).json({message:'A NAV beküldéshez explicit megerősítés szükséges.'});
 try{
  const b=await bundle(req.params.id);if(!b)return res.status(404).json({message:'A bizonylat nem található.'});
  let financeId=b.d.finance_invoice_id as string|null;if(!financeId){const p=await promote(req.params.id,req);financeId=p.finance.id;}
  let s=(await db.query(`SELECT * FROM nav_invoice_submissions WHERE invoice_id=$1::uuid AND status='prepared' ORDER BY created_at DESC LIMIT 1`,[financeId])).rows[0];
  if(!s){return res.status(409).json({message:'Előbb futtasd a NAV előkészítést és XSD-ellenőrzést.'});}
  const inv=(await db.query(`SELECT * FROM finance_invoices WHERE id=$1::uuid`,[financeId])).rows[0];const operation=String(s.operation||'').toUpperCase() as NavInvoiceOperation;if(!['CREATE','MODIFY','STORNO'].includes(operation))throw new Error('Érvénytelen NAV művelet.');if(operation!==resolveNavOperation(inv.invoice_type))throw new Error('A NAV művelet nem egyezik a számla típusával.');
  const xsd=await validateNavInvoiceXmlXsd(String(s.invoice_xml||''));if(!xsd.valid)return res.status(409).json({message:'A beküldés előtti NAV XSD-validáció sikertelen. Hálózati beküldés nem történt.',xsd});
  const cfg=await config(String(inv.legal_entity_id),inv.location_id);const entityTax=digits((await entity(String(inv.legal_entity_id)))?.tax_number);if(entityTax!==digits(cfg.supplier_tax_number))throw new Error('Biztonsági blokkolás: a kiválasztott cég adószáma nem egyezik a NAV konfiguráció adószámával.');
  const{token}=await exchangeToken(cfg);const requestId=rid(),timestamp=ts(),invoiceData=Buffer.from(String(s.invoice_xml),'utf8').toString('base64'),partial=sha3(operation+invoiceData),signature=sha3(requestId+compact(timestamp)+String(cfg.signing_key));const xml=`<?xml version="1.0" encoding="UTF-8"?><ManageInvoiceRequest xmlns="http://schemas.nav.gov.hu/OSA/3.0/api">${commonHeader(cfg,requestId,timestamp,signature)}${software(cfg)}<exchangeToken>${esc(token)}</exchangeToken><invoiceOperations><compressedContent>false</compressedContent><invoiceOperation><index>1</index><invoiceOperation>${operation}</invoiceOperation><invoiceData>${invoiceData}</invoiceData></invoiceOperation></invoiceOperations></ManageInvoiceRequest>`;
  await db.query(`UPDATE nav_invoice_submissions SET status='submitting',request_id=$2,request_xml=$3,updated_at=now() WHERE id=$1`,[s.id,requestId,xml]);const r=await axios.post(`${apiBase(cfg.environment)}/manageInvoice`,xml,{headers:{'Content-Type':'application/xml'},timeout:30000});const response=String(r.data),transactionId=response.match(/<transactionId>([^<]+)<\/transactionId>/)?.[1];if(!transactionId)throw new Error(`NAV manageInvoice sikertelen: ${response.slice(0,800)}`);
  await db.query(`UPDATE nav_invoice_submissions SET status='submitted',transaction_id=$2,response_xml=$3,submitted_at=now(),updated_at=now() WHERE id=$1`,[s.id,transactionId,response]);await db.query(`UPDATE finance_invoices SET nav_status='submitted',nav_transaction_id=$2,nav_submission_id=$3 WHERE id=$1`,[financeId,transactionId,s.id]);await db.query(`UPDATE external_financial_documents SET nav_submitted_at=now(),metadata=jsonb_set(COALESCE(metadata,'{}'::jsonb),'{nav_status}',to_jsonb('submitted'::text),true),updated_at=now() WHERE id=$1::uuid`,[req.params.id]);await audit(req.params.id,req,'nav_submitted',{transaction_id:transactionId,environment:cfg.environment});
  res.json({ok:true,transaction_id:transactionId,environment:cfg.environment,operation});
 }catch(e:any){res.status(409).json({message:e.message});}
});

export default router;
