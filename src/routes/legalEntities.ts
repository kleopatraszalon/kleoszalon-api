import {Router,Response} from 'express';
import db from '../db';
import {requireAuth,type AuthRequest} from '../middleware/auth';
import {requireRoles} from '../middleware/requireRoles';
import {parseRoleKeys} from '../security/roles';
import {ensureFinanceNav} from '../finance/ensureFinanceNav';

const router=Router();
router.use(requireAuth);
const GLOBAL_ROLES=new Set(['admin','manager','accounting','bookkeeper']);
const ENTITY_TYPES=new Set(['COMPANY','SOLE_PROPRIETOR','OTHER']);
const digits=(v:any)=>String(v??'').replace(/\D/g,'');
const text=(v:any)=>String(v??'').trim();
const money=(v:any)=>Math.round(Number(v||0)*100)/100;
const actor=(req:AuthRequest)=>req.user?.email||String(req.user?.id||'');

function global(req:AuthRequest){return parseRoleKeys(req.user?.role).some(r=>GLOBAL_ROLES.has(r))}
async function ensure(){await ensureFinanceNav()}
function normalize(body:any){
 const entity_type=text(body?.entity_type||'COMPANY').toUpperCase();
 const country=text(body?.registered_country_code||'HU').toUpperCase().slice(0,2);
 return{
  entity_type,legal_name:text(body?.legal_name),short_name:text(body?.short_name)||null,legal_form:text(body?.legal_form)||null,
  tax_number:digits(body?.tax_number),group_tax_number:digits(body?.group_tax_number)||null,eu_vat_number:text(body?.eu_vat_number).toUpperCase()||null,
  company_register_number:text(body?.company_register_number)||null,sole_proprietor_registration_number:text(body?.sole_proprietor_registration_number)||null,
  statistical_number:text(body?.statistical_number)||null,registered_country_code:country,registered_postal_code:text(body?.registered_postal_code),
  registered_city:text(body?.registered_city),registered_address_line:text(body?.registered_address_line),main_activity_code:text(body?.main_activity_code)||null,
  main_activity_name:text(body?.main_activity_name)||null,representative_name:text(body?.representative_name)||null,representative_title:text(body?.representative_title)||null,
  bank_account_number:text(body?.bank_account_number)||null,iban:text(body?.iban).replace(/\s/g,'').toUpperCase()||null,bic:text(body?.bic).toUpperCase()||null,
  official_email:text(body?.official_email).toLowerCase()||null,phone:text(body?.phone)||null,currency:text(body?.currency||'HUF').toUpperCase().slice(0,3),
  default_vat_rate:Math.max(0,Math.min(100,Number(body?.default_vat_rate??27))),invoice_prefix:text(body?.invoice_prefix||'KLEO').replace(/[^A-Za-z0-9_-]/g,'').slice(0,24)||'KLEO',
  receipt_prefix:text(body?.receipt_prefix||'KLEO-NY').replace(/[^A-Za-z0-9_-]/g,'').slice(0,24)||'KLEO-NY',accounting_ledger_code:text(body?.accounting_ledger_code).toUpperCase().replace(/[^A-Z0-9_-]/g,'').slice(0,32),
  active:body?.active!==false,location_ids:Array.isArray(body?.location_ids)?[...new Set(body.location_ids.map(String).filter(Boolean))]:[],
  default_for_location_ids:Array.isArray(body?.default_for_location_ids)?[...new Set(body.default_for_location_ids.map(String).filter(Boolean))]:[],
 };
}
function validate(x:any){
 const errors:string[]=[];
 if(!ENTITY_TYPES.has(x.entity_type))errors.push('Érvénytelen szervezettípus.');
 if(!x.legal_name)errors.push('A hivatalos cégnév / vállalkozói név kötelező.');
 if(x.registered_country_code==='HU'&&x.tax_number.length!==11)errors.push('Magyar adózónál a teljes, 11 számjegyű adószám kötelező.');
 if(!x.tax_number)errors.push('Az adószám kötelező.');
 if(x.entity_type==='COMPANY'&&!x.company_register_number)errors.push('Cégnél a cégjegyzékszám kötelező.');
 if(x.entity_type==='SOLE_PROPRIETOR'&&!x.sole_proprietor_registration_number)errors.push('Egyéni vállalkozónál a nyilvántartási szám kötelező.');
 if(!x.registered_postal_code||!x.registered_city||!x.registered_address_line)errors.push('A teljes székhely kötelező.');
 if(!x.accounting_ledger_code)errors.push('A külön könyvelési azonosító kötelező.');
 if(!x.location_ids.length)errors.push('Legalább egy szalont hozzá kell rendelni a céghez.');
 for(const id of x.default_for_location_ids)if(!x.location_ids.includes(id))errors.push('Alapértelmezett cég csak olyan szalonban lehet, amelyhez hozzá van rendelve.');
 return errors;
}
async function allowedEntity(req:AuthRequest,id:string){
 if(global(req))return true;
 const own=String(req.user?.location_id||'');if(!own)return false;
 return Boolean((await db.query(`SELECT 1 FROM legal_entity_locations WHERE legal_entity_id=$1::uuid AND location_id::text=$2 AND active=true`,[id,own])).rows[0]);
}
async function entityRow(id:string){
 return (await db.query(`SELECT e.*,COALESCE(json_agg(json_build_object('id',l.id::text,'name',l.name,'city',l.city,'is_default',el.is_default) ORDER BY l.name) FILTER(WHERE l.id IS NOT NULL),'[]'::json) locations FROM legal_entities e LEFT JOIN legal_entity_locations el ON el.legal_entity_id=e.id AND el.active=true LEFT JOIN locations l ON l.id=el.location_id WHERE e.id=$1::uuid GROUP BY e.id`,[id])).rows[0]||null;
}
async function audit(c:any,entityId:string,req:AuthRequest,eventType:string,payload:any){
 await c.query(`CREATE TABLE IF NOT EXISTS legal_entity_audit_log(id bigserial PRIMARY KEY,legal_entity_id uuid NOT NULL REFERENCES legal_entities(id) ON DELETE RESTRICT,event_type text NOT NULL,actor text,payload jsonb NOT NULL DEFAULT '{}'::jsonb,created_at timestamptz NOT NULL DEFAULT now())`);
 await c.query(`INSERT INTO legal_entity_audit_log(legal_entity_id,event_type,actor,payload) VALUES($1,$2,$3,$4::jsonb)`,[entityId,eventType,actor(req),JSON.stringify(payload||{})]);
}

router.get('/',async(req:AuthRequest,res:Response)=>{try{
 await ensure();const params:any[]=[];let scope='';if(!global(req)){const own=String(req.user?.location_id||'');if(!own)return res.status(403).json({message:'A felhasználóhoz nincs szalon rendelve.'});params.push(own);scope=` AND EXISTS(SELECT 1 FROM legal_entity_locations sx WHERE sx.legal_entity_id=e.id AND sx.location_id::text=$1 AND sx.active=true)`}
 if(req.query.location_id){params.push(String(req.query.location_id));scope+=` AND EXISTS(SELECT 1 FROM legal_entity_locations sx WHERE sx.legal_entity_id=e.id AND sx.location_id::text=$${params.length} AND sx.active=true)`}
 const rows=(await db.query(`SELECT e.*,COALESCE(json_agg(json_build_object('id',l.id::text,'name',l.name,'city',l.city,'is_default',el.is_default) ORDER BY l.name) FILTER(WHERE l.id IS NOT NULL),'[]'::json) locations FROM legal_entities e LEFT JOIN legal_entity_locations el ON el.legal_entity_id=e.id AND el.active=true LEFT JOIN locations l ON l.id=el.location_id WHERE ($${params.length+1}::boolean OR e.active=true)${scope} GROUP BY e.id ORDER BY e.active DESC,e.legal_name`,[...params,req.query.include_inactive==='1'])).rows;
 return res.json({ok:true,rows});
 }catch(e:any){return res.status(500).json({message:e?.message||'A cégek nem tölthetők be.'})}});

router.get('/for-location/:locationId',async(req:AuthRequest,res:Response)=>{try{
 await ensure();const locationId=String(req.params.locationId);if(!global(req)&&String(req.user?.location_id||'')!==locationId)return res.status(403).json({message:'Másik szalon cégei nem kérdezhetők le.'});
 const rows=(await db.query(`SELECT e.id::text,e.legal_name,e.short_name,e.tax_number,e.accounting_ledger_code,e.receipt_prefix,e.invoice_prefix,el.is_default FROM legal_entities e JOIN legal_entity_locations el ON el.legal_entity_id=e.id WHERE el.location_id::text=$1 AND e.active=true AND el.active=true ORDER BY el.is_default DESC,e.legal_name`,[locationId])).rows;
 return res.json({ok:true,rows,default_legal_entity_id:rows.find((x:any)=>x.is_default)?.id||rows[0]?.id||null});
 }catch(e:any){return res.status(500).json({message:e?.message||'A szalonhoz tartozó cégek nem tölthetők be.'})}});

router.post('/',requireRoles('admin'),async(req:AuthRequest,res:Response)=>{const c=await db.connect();try{
 await ensure();const x=normalize(req.body),errors=validate(x);if(errors.length)return res.status(400).json({message:'A cég törzsadatai hiányosak.',errors});
 await c.query('BEGIN');
 for(const locationId of x.location_ids){const ok=(await c.query(`SELECT 1 FROM locations WHERE id::text=$1 AND COALESCE(is_active,true)=true`,[locationId])).rows[0];if(!ok)throw Object.assign(new Error('Egy hozzárendelt szalon nem található vagy inaktív.'),{status:400})}
 const q=await c.query(`INSERT INTO legal_entities(entity_type,legal_name,short_name,legal_form,tax_number,group_tax_number,eu_vat_number,company_register_number,sole_proprietor_registration_number,statistical_number,registered_country_code,registered_postal_code,registered_city,registered_address_line,main_activity_code,main_activity_name,representative_name,representative_title,bank_account_number,iban,bic,official_email,phone,currency,default_vat_rate,invoice_prefix,receipt_prefix,accounting_ledger_code,active,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$30) RETURNING id`,[x.entity_type,x.legal_name,x.short_name,x.legal_form,x.tax_number,x.group_tax_number,x.eu_vat_number,x.company_register_number,x.sole_proprietor_registration_number,x.statistical_number,x.registered_country_code,x.registered_postal_code,x.registered_city,x.registered_address_line,x.main_activity_code,x.main_activity_name,x.representative_name,x.representative_title,x.bank_account_number,x.iban,x.bic,x.official_email,x.phone,x.currency,x.default_vat_rate,x.invoice_prefix,x.receipt_prefix,x.accounting_ledger_code,x.active,actor(req)]);const id=String(q.rows[0].id);
 for(const locationId of x.location_ids)await c.query(`INSERT INTO legal_entity_locations(legal_entity_id,location_id,is_default,active) VALUES($1,$2::uuid,$3,true)`,[id,locationId,x.default_for_location_ids.includes(locationId)]);
 for(const locationId of x.default_for_location_ids){await c.query(`UPDATE legal_entity_locations SET is_default=false WHERE location_id::text=$1 AND legal_entity_id<>$2::uuid`,[locationId,id]);await c.query(`UPDATE legal_entity_locations SET is_default=true WHERE location_id::text=$1 AND legal_entity_id=$2::uuid`,[locationId,id])}
 await audit(c,id,req,'CREATED',{location_ids:x.location_ids,default_for_location_ids:x.default_for_location_ids});await c.query('COMMIT');return res.status(201).json({ok:true,entity:await entityRow(id)});
 }catch(e:any){await c.query('ROLLBACK').catch(()=>undefined);const status=Number(e?.status||(/unique/i.test(String(e?.message))?409:500));return res.status(status).json({message:e?.code==='23505'?'Az adószám vagy könyvelési azonosító már használatban van.':e?.message||'A cég nem menthető.'})}finally{c.release()}});

router.put('/:id',requireRoles('admin'),async(req:AuthRequest,res:Response)=>{const c=await db.connect();try{
 await ensure();const id=String(req.params.id),x=normalize(req.body),errors=validate(x);if(errors.length)return res.status(400).json({message:'A cég törzsadatai hiányosak.',errors});
 await c.query('BEGIN');const before=(await c.query(`SELECT * FROM legal_entities WHERE id=$1::uuid FOR UPDATE`,[id])).rows[0];if(!before){await c.query('ROLLBACK');return res.status(404).json({message:'A cég nem található.'})}
 await c.query(`UPDATE legal_entities SET entity_type=$2,legal_name=$3,short_name=$4,legal_form=$5,tax_number=$6,group_tax_number=$7,eu_vat_number=$8,company_register_number=$9,sole_proprietor_registration_number=$10,statistical_number=$11,registered_country_code=$12,registered_postal_code=$13,registered_city=$14,registered_address_line=$15,main_activity_code=$16,main_activity_name=$17,representative_name=$18,representative_title=$19,bank_account_number=$20,iban=$21,bic=$22,official_email=$23,phone=$24,currency=$25,default_vat_rate=$26,invoice_prefix=$27,receipt_prefix=$28,accounting_ledger_code=$29,active=$30,updated_by=$31,updated_at=now() WHERE id=$1::uuid`,[id,x.entity_type,x.legal_name,x.short_name,x.legal_form,x.tax_number,x.group_tax_number,x.eu_vat_number,x.company_register_number,x.sole_proprietor_registration_number,x.statistical_number,x.registered_country_code,x.registered_postal_code,x.registered_city,x.registered_address_line,x.main_activity_code,x.main_activity_name,x.representative_name,x.representative_title,x.bank_account_number,x.iban,x.bic,x.official_email,x.phone,x.currency,x.default_vat_rate,x.invoice_prefix,x.receipt_prefix,x.accounting_ledger_code,x.active,actor(req)]);
 await c.query(`UPDATE legal_entity_locations SET active=false,is_default=false WHERE legal_entity_id=$1::uuid`,[id]);for(const locationId of x.location_ids)await c.query(`INSERT INTO legal_entity_locations(legal_entity_id,location_id,is_default,active) VALUES($1,$2::uuid,$3,true) ON CONFLICT(legal_entity_id,location_id) DO UPDATE SET active=true,is_default=EXCLUDED.is_default`,[id,locationId,x.default_for_location_ids.includes(locationId)]);
 for(const locationId of x.default_for_location_ids){await c.query(`UPDATE legal_entity_locations SET is_default=false WHERE location_id::text=$1 AND legal_entity_id<>$2::uuid`,[locationId,id]);await c.query(`UPDATE legal_entity_locations SET is_default=true WHERE location_id::text=$1 AND legal_entity_id=$2::uuid`,[locationId,id])}
 await audit(c,id,req,'UPDATED',{before:{legal_name:before.legal_name,tax_number:before.tax_number},location_ids:x.location_ids,default_for_location_ids:x.default_for_location_ids});await c.query('COMMIT');return res.json({ok:true,entity:await entityRow(id)});
 }catch(e:any){await c.query('ROLLBACK').catch(()=>undefined);return res.status(e?.code==='23505'?409:500).json({message:e?.code==='23505'?'Az adószám vagy könyvelési azonosító már használatban van.':e?.message||'A cég nem módosítható.'})}finally{c.release()}});

router.get('/:id/accounting/summary',async(req:AuthRequest,res:Response)=>{try{
 await ensure();const id=String(req.params.id);if(!await allowedEntity(req,id))return res.status(403).json({message:'Ehhez a cégkönyveléshez nincs jogosultság.'});const from=text(req.query.from)||new Date(new Date().getFullYear(),0,1).toISOString().slice(0,10),to=text(req.query.to)||new Date().toISOString().slice(0,10);
 const [mov,inv,wo]=await Promise.all([
  db.query(`SELECT COALESCE(SUM(CASE WHEN direction='income' AND COALESCE(payment_status,'posted')<>'cancelled' THEN amount ELSE 0 END),0)::numeric income,COALESCE(SUM(CASE WHEN direction='expense' AND COALESCE(payment_status,'posted')<>'cancelled' THEN amount ELSE 0 END),0)::numeric expense,COUNT(*)::int movement_count FROM financial_movements WHERE legal_entity_id=$1::uuid AND occurred_at::date BETWEEN $2::date AND $3::date`,[id,from,to]),
  db.query(`SELECT COUNT(*)::int invoice_count,COALESCE(SUM(gross_total),0)::numeric invoice_gross FROM finance_invoices WHERE legal_entity_id=$1::uuid AND issue_date BETWEEN $2::date AND $3::date`,[id,from,to]),
  db.query(`SELECT COUNT(*)::int work_order_count,COALESCE(SUM(gross_total),0)::numeric work_order_gross FROM work_orders WHERE legal_entity_id=$1::uuid AND created_at::date BETWEEN $2::date AND $3::date`,[id,from,to])
 ]);const entity=await entityRow(id);const income=money(mov.rows[0]?.income),expense=money(mov.rows[0]?.expense);return res.json({ok:true,entity,from,to,income,expense,balance:money(income-expense),movement_count:Number(mov.rows[0]?.movement_count||0),invoice_count:Number(inv.rows[0]?.invoice_count||0),invoice_gross:money(inv.rows[0]?.invoice_gross),work_order_count:Number(wo.rows[0]?.work_order_count||0),work_order_gross:money(wo.rows[0]?.work_order_gross)});
 }catch(e:any){return res.status(500).json({message:e?.message||'A cég könyvelési összesítője nem tölthető be.'})}});

router.get('/:id/accounting/movements',async(req:AuthRequest,res:Response)=>{try{
 await ensure();const id=String(req.params.id);if(!await allowedEntity(req,id))return res.status(403).json({message:'Ehhez a cégkönyveléshez nincs jogosultság.'});const rows=(await db.query(`SELECT m.*,a.name account_name,c.name category_name FROM financial_movements m LEFT JOIN financial_accounts a ON a.id=m.account_id LEFT JOIN financial_categories c ON c.id=m.category_id WHERE m.legal_entity_id=$1::uuid ORDER BY m.occurred_at DESC LIMIT 500`,[id])).rows;return res.json({ok:true,rows});
 }catch(e:any){return res.status(500).json({message:e?.message||'A cég könyvelési tételei nem tölthetők be.'})}});

router.get('/:id/accounting/invoices',async(req:AuthRequest,res:Response)=>{try{
 await ensure();const id=String(req.params.id);if(!await allowedEntity(req,id))return res.status(403).json({message:'Ehhez a cégkönyveléshez nincs jogosultság.'});const rows=(await db.query(`SELECT id,invoice_no,direction,partner_name,customer_name,issue_date,currency,net_total,vat_total,gross_total,status,document_kind,nav_status,work_order_id FROM finance_invoices WHERE legal_entity_id=$1::uuid ORDER BY issue_date DESC,created_at DESC LIMIT 500`,[id])).rows;return res.json({ok:true,rows});
 }catch(e:any){return res.status(500).json({message:e?.message||'A cég számlái nem tölthetők be.'})}});

export default router;
