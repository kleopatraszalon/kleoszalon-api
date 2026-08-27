import {Router,Response} from 'express';
import multer from 'multer';
import * as XLSX from 'xlsx';
import db from '../db';
import {requireAuth,type AuthRequest} from '../middleware/auth';
import {requireRoles} from '../middleware/requireRoles';
import {ensureFinanceNav} from '../finance/ensureFinanceNav';

const router=Router();
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:15*1024*1024}});
router.use(requireAuth);
router.use(requireRoles('admin'));

const ENTITY_TYPES=new Set(['COMPANY','SOLE_PROPRIETOR','OTHER']);
const IMPORT_PROFILES=new Set(['AUTO','GENERAL','ACCOUNTING','REGISTRY','VIR']);
const CONFLICT_POLICIES=new Set(['CREATE_ONLY','UPSERT']);
const text=(v:any)=>String(v??'').trim();
const digits=(v:any)=>String(v??'').replace(/\D/g,'');
const actor=(req:AuthRequest)=>req.user?.email||String(req.user?.id||'');
const normKey=(v:any)=>text(v).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'');
const splitList=(v:any)=>Array.isArray(v)?v.map(text).filter(Boolean):text(v).split(/[;,|\n]+/).map(x=>x.trim()).filter(Boolean);
const bool=(v:any,fallback=false)=>{if(typeof v==='boolean')return v;const n=normKey(v);if(['1','true','igen','yes','y','x','aktiv','active'].includes(n))return true;if(['0','false','nem','no','n','inaktiv','inactive'].includes(n))return false;return fallback};
const numberValue=(v:any,fallback:number)=>{if(v===null||v===undefined||v==='')return fallback;const n=Number(String(v).replace(',','.').replace(/[^0-9.\-]/g,''));return Number.isFinite(n)?n:fallback};

const aliases:Record<string,string[]>={
 entity_type:['entity_type','szervezettipus','szervezet tipus','tipus','company_type','type'],
 legal_name:['legal_name','hivatalos nev','cegnev','cég neve','ceg neve','vallalkozas neve','company name','name','supplier_name'],
 short_name:['short_name','rovid nev','rövid név','rovidnev','short name'],
 legal_form:['legal_form','jogi forma','cegforma','company form'],
 tax_number:['tax_number','adoszam','adószám','ado szam','tax id','tax number','supplier_tax_number'],
 group_tax_number:['group_tax_number','csoportos adoszam','csoport adoszam','group tax number'],
 eu_vat_number:['eu_vat_number','kozossegi adoszam','közösségi adószám','eu adoszam','vat number','eu vat'],
 company_register_number:['company_register_number','cegjegyzekszam','cégjegyzékszám','cegjegyzek szam','registration number','company registration number'],
 sole_proprietor_registration_number:['sole_proprietor_registration_number','ev nyilvantartasi szam','egyeni vallalkozo nyilvantartasi szam','sole proprietor registration'],
 statistical_number:['statistical_number','statisztikai szamjel','statisztikai számjel','statistical code'],
 registered_country_code:['registered_country_code','orszagkod','országkód','country','country code','supplier_country_code'],
 registered_postal_code:['registered_postal_code','iranyitoszam','irányítószám','postal code','zip','zip code','supplier_postal_code'],
 registered_city:['registered_city','varos','város','telepules','település','city','supplier_city'],
 registered_address_line:['registered_address_line','cim','cím','utca hazszam','utca házszám','address','address line','supplier_address'],
 full_registered_address:['szekhely','székhely','registered address','full address','teljes cim','teljes cím'],
 main_activity_code:['main_activity_code','teaor','teáor','ovtj','övtj','fo tevekenyseg kod','főtevékenység kód','activity code'],
 main_activity_name:['main_activity_name','fo tevekenyseg','főtevékenység','activity','activity name'],
 representative_name:['representative_name','kepviselo','képviselő','ugyvezeto','ügyvezető','representative','director'],
 representative_title:['representative_title','kepviselo tisztsege','képviselő tisztsége','title','position'],
 bank_account_number:['bank_account_number','bankszamlaszam','bankszámlaszám','bank account','bank account number'],
 iban:['iban'],bic:['bic','swift','bic swift'],official_email:['official_email','email','e-mail','hivatalos email','company email'],phone:['phone','telefon','telephone'],
 currency:['currency','penznem','pénznem'],default_vat_rate:['default_vat_rate','alap afa','alap áfa','afa','áfa','vat','vat rate'],
 invoice_prefix:['invoice_prefix','szamlaprefix','számlaprefix','invoice prefix'],receipt_prefix:['receipt_prefix','nyugtaprefix','receipt prefix'],
 accounting_ledger_code:['accounting_ledger_code','konyvelesi azonosito','könyvelési azonosító','fokonyvi kod','főkönyvi kód','ledger code','accounting code'],
 active:['active','aktiv','aktív','statusz','státusz','status'],
 locations:['locations','location_ids','szalonok','szalon','telephelyek','telephely','units','branches'],
 default_locations:['default_for_location_ids','alap szalonok','alapcég szalon','default locations','default branches']
};

function pick(row:Record<string,any>,field:string){
 const wanted=(aliases[field]||[field]).map(normKey),entries=Object.entries(row);
 for(const [k,v] of entries)if(wanted.includes(normKey(k)))return v;
 if(field==='legal_name')for(const [k,v] of entries)if(normKey(k).includes('cegnev')||normKey(k).includes('companyname'))return v;
 return undefined;
}
function parseFullAddress(raw:any){const s=text(raw).replace(/\s+/g,' ');if(!s)return{};const m=s.match(/^(?:HU[- ]?)?(\d{4})\s+([^,]+),?\s+(.+)$/i);return m?{registered_postal_code:m[1],registered_city:m[2].trim(),registered_address_line:m[3].trim()}:{registered_address_line:s};}
function parseJson(buffer:Buffer){const parsed=JSON.parse(buffer.toString('utf8').replace(/^\uFEFF/,''));if(Array.isArray(parsed))return parsed;for(const k of ['legal_entities','entities','companies','rows','data','results'])if(Array.isArray(parsed?.[k]))return parsed[k];if(parsed&&typeof parsed==='object')return[parsed];return[];}
function parseFile(file:Express.Multer.File){
 const name=file.originalname.toLowerCase();
 if(name.endsWith('.json')||String(file.mimetype).includes('json'))return parseJson(file.buffer);
 const wb=XLSX.read(file.buffer,{type:'buffer',cellDates:false});const ws=wb.Sheets[wb.SheetNames[0]];if(!ws)return[];
 return XLSX.utils.sheet_to_json<Record<string,any>>(ws,{defval:null,raw:false});
}
function parseFormList(raw:any){if(!raw)return[];try{const p=JSON.parse(String(raw));if(Array.isArray(p))return p.map(String).filter(Boolean)}catch{}return splitList(raw)}
function derivedCode(tax:string,index:number){return `LE-${(tax||String(index+1).padStart(6,'0')).slice(-6)}`.toUpperCase();}
function derivedPrefix(prefix:string,tax:string,index:number){const suffix=(tax||String(index+1)).slice(-4);return `${prefix}-${suffix}`.replace(/[^A-Z0-9_-]/g,'').slice(0,24);}

async function activeLocations(){return(await db.query(`SELECT id::text,name,city FROM locations WHERE COALESCE(is_active,true)=true ORDER BY name`)).rows;}
function resolveLocations(raw:any,locations:any[],fallbackIds:string[]){
 const tokens=splitList(raw),byId=new Map(locations.map((x:any)=>[String(x.id),String(x.id)])),byName=new Map<string,string>();
 for(const x of locations){byName.set(normKey(x.name),String(x.id));byName.set(normKey(`${x.name} ${x.city||''}`),String(x.id));}
 const ids:string[]=[],unknown:string[]=[];
 for(const token of tokens){const id=byId.get(token)||byName.get(normKey(token));if(id&&!ids.includes(id))ids.push(id);else if(!id)unknown.push(token)}
 if(!tokens.length)for(const id of fallbackIds)if(byId.has(id)&&!ids.includes(id))ids.push(id);
 return{ids,unknown};
}
function normalizeRow(row:Record<string,any>,index:number,locations:any[],fallbackIds:string[],fallbackDefault:boolean){
 const full=parseFullAddress(pick(row,'full_registered_address'));
 let rawType=text(pick(row,'entity_type')||'COMPANY').toUpperCase();const typeKey=normKey(rawType);
 if(['kft','zrt','nyrt','bt','kkt','company','ceg','gazdasagitarsasag'].some(x=>typeKey.includes(x)))rawType='COMPANY';
 else if(['ev','egyeni','soleproprietor'].some(x=>typeKey.includes(x)))rawType='SOLE_PROPRIETOR';
 else if(!ENTITY_TYPES.has(rawType))rawType='COMPANY';
 const tax=digits(pick(row,'tax_number')).slice(0,11),loc=resolveLocations(pick(row,'locations'),locations,fallbackIds),explicitDefaults=resolveLocations(pick(row,'default_locations'),locations,[]);
 const accounting=text(pick(row,'accounting_ledger_code')).toUpperCase().replace(/[^A-Z0-9_-]/g,'').slice(0,32)||derivedCode(tax,index);
 const x:any={
  entity_type:rawType,legal_name:text(pick(row,'legal_name')),short_name:text(pick(row,'short_name'))||null,legal_form:text(pick(row,'legal_form'))||null,
  tax_number:tax,group_tax_number:digits(pick(row,'group_tax_number')).slice(0,11)||null,eu_vat_number:text(pick(row,'eu_vat_number')).toUpperCase()||null,
  company_register_number:text(pick(row,'company_register_number'))||null,sole_proprietor_registration_number:text(pick(row,'sole_proprietor_registration_number'))||null,
  statistical_number:text(pick(row,'statistical_number'))||null,registered_country_code:text(pick(row,'registered_country_code')||'HU').toUpperCase().slice(0,2),
  registered_postal_code:text(pick(row,'registered_postal_code')||full.registered_postal_code),registered_city:text(pick(row,'registered_city')||full.registered_city),
  registered_address_line:text(pick(row,'registered_address_line')||full.registered_address_line),main_activity_code:text(pick(row,'main_activity_code'))||null,
  main_activity_name:text(pick(row,'main_activity_name'))||null,representative_name:text(pick(row,'representative_name'))||null,representative_title:text(pick(row,'representative_title'))||null,
  bank_account_number:text(pick(row,'bank_account_number'))||null,iban:text(pick(row,'iban')).replace(/\s/g,'').toUpperCase()||null,bic:text(pick(row,'bic')).toUpperCase()||null,
  official_email:text(pick(row,'official_email')).toLowerCase()||null,phone:text(pick(row,'phone'))||null,currency:text(pick(row,'currency')||'HUF').toUpperCase().slice(0,3),
  default_vat_rate:Math.max(0,Math.min(100,numberValue(pick(row,'default_vat_rate'),27))),invoice_prefix:text(pick(row,'invoice_prefix')).toUpperCase().replace(/[^A-Z0-9_-]/g,'').slice(0,24)||derivedPrefix('INV',tax,index),
  receipt_prefix:text(pick(row,'receipt_prefix')).toUpperCase().replace(/[^A-Z0-9_-]/g,'').slice(0,24)||derivedPrefix('NY',tax,index),accounting_ledger_code:accounting,
  active:bool(pick(row,'active'),true),location_ids:loc.ids,default_for_location_ids:explicitDefaults.ids.length?explicitDefaults.ids:(fallbackDefault?loc.ids:[])
 };
 const errors:string[]=[];
 if(!x.legal_name)errors.push('Hiányzik a hivatalos cégnév.');
 if(x.registered_country_code==='HU'&&x.tax_number.length!==11)errors.push('Magyar cégnél 11 számjegyű adószám szükséges.');
 if(!x.tax_number)errors.push('Hiányzik az adószám.');
 if(x.entity_type==='COMPANY'&&!x.company_register_number)errors.push('Hiányzik a cégjegyzékszám.');
 if(x.entity_type==='SOLE_PROPRIETOR'&&!x.sole_proprietor_registration_number)errors.push('Hiányzik az EV nyilvántartási szám.');
 if(!x.registered_postal_code||!x.registered_city||!x.registered_address_line)errors.push('Hiányos a székhely.');
 if(!x.accounting_ledger_code)errors.push('Hiányzik a könyvelési azonosító.');
 if(!x.location_ids.length)errors.push('Nincs szalon/telephely hozzárendelve.');
 if(loc.unknown.length)errors.push(`Ismeretlen szalon: ${loc.unknown.join(', ')}`);
 if(explicitDefaults.unknown.length)errors.push(`Ismeretlen alapértelmezett szalon: ${explicitDefaults.unknown.join(', ')}`);
 for(const id of x.default_for_location_ids)if(!x.location_ids.includes(id))errors.push('Alapcég csak hozzárendelt szalonban jelölhető.');
 return{row:index+2,data:x,errors};
}
async function prepare(req:AuthRequest){
 await ensureFinanceNav();const file=(req as any).file as Express.Multer.File|undefined;if(!file?.buffer)throw Object.assign(new Error('Válasszon importfájlt.'),{status:400});
 const ext=file.originalname.toLowerCase();if(!/\.(xlsx|xls|xlsm|csv|tsv|txt|json)$/.test(ext))throw Object.assign(new Error('Támogatott formátum: XLSX, XLS, XLSM, CSV, TSV, TXT vagy JSON.'),{status:400});
 const profile=text((req as any).body?.profile||'AUTO').toUpperCase();if(!IMPORT_PROFILES.has(profile))throw Object.assign(new Error('Ismeretlen importprofil.'),{status:400});
 const policy=text((req as any).body?.conflict_policy||'UPSERT').toUpperCase();if(!CONFLICT_POLICIES.has(policy))throw Object.assign(new Error('Ismeretlen ütközéskezelés.'),{status:400});
 const locations=await activeLocations(),fallbackIds=parseFormList((req as any).body?.default_location_ids),fallbackDefault=bool((req as any).body?.set_default_for_fallback,false);
 let raw:any[]=[];try{raw=parseFile(file)}catch(e:any){throw Object.assign(new Error(`A fájl nem olvasható: ${e?.message||e}`),{status:400})}
 if(!raw.length)throw Object.assign(new Error('A fájl nem tartalmaz importálható adatsort.'),{status:400});if(raw.length>1000)throw Object.assign(new Error('Egy import legfeljebb 1000 céget tartalmazhat.'),{status:400});
 const existing=(await db.query(`SELECT id::text,tax_number,accounting_ledger_code,legal_name FROM legal_entities`)).rows,byTax=new Map(existing.map((x:any)=>[String(x.tax_number),x]));
 const seen=new Set<string>(),rows=raw.map((r,i)=>normalizeRow(r&&typeof r==='object'?r:{},i,locations,fallbackIds,fallbackDefault)).map(item=>{
   const found=byTax.get(item.data.tax_number),duplicateInFile=Boolean(item.data.tax_number&&seen.has(item.data.tax_number));if(item.data.tax_number)seen.add(item.data.tax_number);
   if(duplicateInFile)item.errors.push('Az adószám többször szerepel ugyanebben az importfájlban.');
   const action=item.errors.length?'ERROR':found?(policy==='UPSERT'?'UPDATE':'SKIP'):'CREATE';return{...item,action,existing_id:found?.id||null,existing_name:found?.legal_name||null};
 });
 return{file_name:file.originalname,profile,policy,locations,rows};
}
async function writeEntity(c:any,x:any,id:string|null,req:AuthRequest,eventType:string,source:any){
 if(id){
  await c.query(`UPDATE legal_entities SET entity_type=$2,legal_name=$3,short_name=$4,legal_form=$5,tax_number=$6,group_tax_number=$7,eu_vat_number=$8,company_register_number=$9,sole_proprietor_registration_number=$10,statistical_number=$11,registered_country_code=$12,registered_postal_code=$13,registered_city=$14,registered_address_line=$15,main_activity_code=$16,main_activity_name=$17,representative_name=$18,representative_title=$19,bank_account_number=$20,iban=$21,bic=$22,official_email=$23,phone=$24,currency=$25,default_vat_rate=$26,invoice_prefix=$27,receipt_prefix=$28,accounting_ledger_code=$29,active=$30,updated_by=$31,updated_at=now() WHERE id=$1::uuid`,[id,x.entity_type,x.legal_name,x.short_name,x.legal_form,x.tax_number,x.group_tax_number,x.eu_vat_number,x.company_register_number,x.sole_proprietor_registration_number,x.statistical_number,x.registered_country_code,x.registered_postal_code,x.registered_city,x.registered_address_line,x.main_activity_code,x.main_activity_name,x.representative_name,x.representative_title,x.bank_account_number,x.iban,x.bic,x.official_email,x.phone,x.currency,x.default_vat_rate,x.invoice_prefix,x.receipt_prefix,x.accounting_ledger_code,x.active,actor(req)]);
 }else{
  id=String((await c.query(`INSERT INTO legal_entities(entity_type,legal_name,short_name,legal_form,tax_number,group_tax_number,eu_vat_number,company_register_number,sole_proprietor_registration_number,statistical_number,registered_country_code,registered_postal_code,registered_city,registered_address_line,main_activity_code,main_activity_name,representative_name,representative_title,bank_account_number,iban,bic,official_email,phone,currency,default_vat_rate,invoice_prefix,receipt_prefix,accounting_ledger_code,active,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$30) RETURNING id::text`,[x.entity_type,x.legal_name,x.short_name,x.legal_form,x.tax_number,x.group_tax_number,x.eu_vat_number,x.company_register_number,x.sole_proprietor_registration_number,x.statistical_number,x.registered_country_code,x.registered_postal_code,x.registered_city,x.registered_address_line,x.main_activity_code,x.main_activity_name,x.representative_name,x.representative_title,x.bank_account_number,x.iban,x.bic,x.official_email,x.phone,x.currency,x.default_vat_rate,x.invoice_prefix,x.receipt_prefix,x.accounting_ledger_code,x.active,actor(req)])).rows[0].id);
 }
 await c.query(`UPDATE legal_entity_locations SET active=false,is_default=false WHERE legal_entity_id=$1::uuid`,[id]);
 for(const locationId of x.location_ids)await c.query(`INSERT INTO legal_entity_locations(legal_entity_id,location_id,is_default,active) VALUES($1,$2::uuid,$3,true) ON CONFLICT(legal_entity_id,location_id) DO UPDATE SET active=true,is_default=EXCLUDED.is_default`,[id,locationId,x.default_for_location_ids.includes(locationId)]);
 for(const locationId of x.default_for_location_ids){await c.query(`UPDATE legal_entity_locations SET is_default=false WHERE location_id::text=$1 AND legal_entity_id<>$2::uuid`,[locationId,id]);await c.query(`UPDATE legal_entity_locations SET is_default=true WHERE location_id::text=$1 AND legal_entity_id=$2::uuid`,[locationId,id]);}
 await c.query(`CREATE TABLE IF NOT EXISTS legal_entity_audit_log(id bigserial PRIMARY KEY,legal_entity_id uuid NOT NULL REFERENCES legal_entities(id) ON DELETE RESTRICT,event_type text NOT NULL,actor text,payload jsonb NOT NULL DEFAULT '{}'::jsonb,created_at timestamptz NOT NULL DEFAULT now())`);
 await c.query(`INSERT INTO legal_entity_audit_log(legal_entity_id,event_type,actor,payload) VALUES($1,$2,$3,$4::jsonb)`,[id,eventType,actor(req),JSON.stringify({source,...source,location_ids:x.location_ids,default_for_location_ids:x.default_for_location_ids})]);
 return id;
}

router.post('/import/preview',upload.single('file'),async(req:AuthRequest,res:Response)=>{try{
 const p=await prepare(req),stats={total:p.rows.length,create:p.rows.filter(x=>x.action==='CREATE').length,update:p.rows.filter(x=>x.action==='UPDATE').length,skip:p.rows.filter(x=>x.action==='SKIP').length,error:p.rows.filter(x=>x.action==='ERROR').length};
 return res.json({ok:true,file_name:p.file_name,profile:p.profile,conflict_policy:p.policy,stats,rows:p.rows.map(x=>({row:x.row,action:x.action,legal_name:x.data.legal_name,tax_number:x.data.tax_number,accounting_ledger_code:x.data.accounting_ledger_code,location_ids:x.data.location_ids,location_names:x.data.location_ids.map((id:string)=>p.locations.find((l:any)=>String(l.id)===id)?.name||id),errors:x.errors,existing_id:x.existing_id,existing_name:x.existing_name}))});
 }catch(e:any){return res.status(Number(e?.status||500)).json({ok:false,message:e?.message||'Az import előnézete nem készíthető el.'})}});

router.post('/import/apply',upload.single('file'),async(req:AuthRequest,res:Response)=>{const c=await db.connect();try{
 const p=await prepare(req),skipInvalid=bool((req as any).body?.skip_invalid,false),errors=p.rows.filter(x=>x.action==='ERROR');if(errors.length&&!skipInvalid)return res.status(400).json({ok:false,message:`${errors.length} hibás sor van. Javítsa a fájlt, vagy engedélyezze a hibás sorok kihagyását.`,error_rows:errors.map(x=>({row:x.row,errors:x.errors}))});
 await c.query('BEGIN');let created=0,updated=0,skipped=0,invalid=0;const imported:any[]=[];
 for(const item of p.rows){if(item.action==='ERROR'){invalid++;continue}if(item.action==='SKIP'){skipped++;continue}const id=await writeEntity(c,item.data,item.existing_id,req,item.action==='CREATE'?'IMPORTED_CREATED':'IMPORTED_UPDATED',{file_name:p.file_name,profile:p.profile,row:item.row});if(item.action==='CREATE')created++;else updated++;imported.push({row:item.row,id,legal_name:item.data.legal_name,tax_number:item.data.tax_number,action:item.action});}
 await c.query('COMMIT');return res.json({ok:true,file_name:p.file_name,profile:p.profile,conflict_policy:p.policy,created,updated,skipped,invalid,total:p.rows.length,imported});
 }catch(e:any){await c.query('ROLLBACK').catch(()=>undefined);const status=Number(e?.status||(e?.code==='23505'?409:500));return res.status(status).json({ok:false,message:e?.code==='23505'?'Az import egyik adószáma vagy könyvelési azonosítója ütközik egy meglévő céggel.':e?.message||'A cégimport nem hajtható végre.'})}finally{c.release()}});

export default router;
