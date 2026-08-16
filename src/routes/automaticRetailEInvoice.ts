import {Router} from 'express';
import db from '../db';
import {requireAuth,AuthRequest} from '../middleware/auth';
import {prepareQueuedInvoice} from '../nav/navQueueWorker';

const router=Router();
router.use(requireAuth);
const PAYMENT_METHODS=new Set(['cash','card','transfer','voucher','other']);
const PAYMENT_MAP:Record<string,string>={cash:'CASH',card:'CARD',transfer:'TRANSFER',voucher:'OTHER',other:'OTHER'};
const money=(v:any)=>{const n=Number(v??0);return Number.isFinite(n)?Math.round(n*100)/100:0};
const actor=(req:AuthRequest)=>req.user?.email||String(req.user?.id||'automatic-retail-e-invoice');
async function tableExists(name:string){const q=await db.query(`SELECT to_regclass($1) IS NOT NULL ok`,[`public.${name}`]);return Boolean(q.rows[0]?.ok)}
async function activeNavConfig(c:any,locationId:string){return (await c.query(`SELECT * FROM nav_online_invoice_settings WHERE active=true AND ($1::text='' OR location_id::text=$1 OR location_id IS NULL) ORDER BY CASE WHEN location_id::text=$1 THEN 0 ELSE 1 END LIMIT 1`,[locationId])).rows[0]||null}
async function nextOfficialNumber(c:any){const ok=(await c.query(`SELECT to_regprocedure('next_internal_invoice_number()') IS NOT NULL ok`)).rows[0]?.ok;if(!ok)throw Object.assign(new Error('A hivatalos számlaszám-generátor nem érhető el.'),{status:503,code:'INVOICE_NUMBER_GENERATOR_MISSING'});return String((await c.query(`SELECT next_internal_invoice_number() invoice_no`)).rows[0]?.invoice_no||'')}

async function ensureRetailSchema(c:any){await c.query(`
 CREATE TABLE IF NOT EXISTS retail_sales(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),location_id text NOT NULL,client_id text,customer_name text,customer_email text,customer_phone text,payment_method text NOT NULL,gross_total numeric(14,2) NOT NULL DEFAULT 0,invoice_requested boolean NOT NULL DEFAULT true,finance_invoice_id uuid,status text NOT NULL DEFAULT 'paid',created_by text,created_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS retail_sale_items(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),sale_id uuid NOT NULL REFERENCES retail_sales(id) ON DELETE CASCADE,product_id text NOT NULL,product_name text NOT NULL,quantity numeric(14,3) NOT NULL,unit_price_gross numeric(14,2) NOT NULL,gross_amount numeric(14,2) NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
 CREATE INDEX IF NOT EXISTS retail_sales_location_created_idx ON retail_sales(location_id,created_at DESC);
`)}

router.post('/retail/sales',async(req:AuthRequest,res,next)=>{
 const c=await db.connect();let invoice:any=null;
 try{
  await c.query('BEGIN');await ensureRetailSchema(c);
  if(!(await tableExists('finance_invoices'))||!(await tableExists('finance_invoice_lines')))throw Object.assign(new Error('A számlázási adatbázisséma nem érhető el.'),{status:503,code:'INVOICE_SCHEMA_MISSING'});
  const locationId=String(req.body?.location_id||req.query.location_id||'').trim();if(!locationId)throw Object.assign(new Error('A termékeladáshoz telephely szükséges.'),{status:400,code:'LOCATION_REQUIRED'});
  const method=String(req.body?.payment_method||'cash').toLowerCase();if(!PAYMENT_METHODS.has(method))throw Object.assign(new Error('Érvénytelen fizetési mód.'),{status:400,code:'PAYMENT_METHOD_INVALID'});
  const requestedItems=Array.isArray(req.body?.items)?req.body.items:[];if(!requestedItems.length)throw Object.assign(new Error('Legalább egy terméket válasszon.'),{status:400,code:'ITEM_REQUIRED'});
  const name=String(req.body?.billing_name||req.body?.customer_name||'').trim(),email=String(req.body?.customer_email||'').trim(),tax=String(req.body?.billing_tax_number||'').replace(/\D/g,''),country=String(req.body?.billing_country_code||'HU').trim().toUpperCase(),postal=String(req.body?.billing_postal_code||'').trim(),city=String(req.body?.billing_city||'').trim(),address=String(req.body?.billing_address||'').trim();
  const errors:string[]=[];if(!name)errors.push('Számlázási név szükséges.');if(!postal)errors.push('Irányítószám szükséges.');if(!city)errors.push('Város szükséges.');if(!address)errors.push('Számlázási cím szükséges.');if(tax&&tax.length!==11)errors.push('A magyar adószám 11 számjegyű legyen.');if(errors.length)throw Object.assign(new Error('Az automatikus e-számlához hiányosak a számlázási adatok.'),{status:409,code:'BILLING_INCOMPLETE',errors});
  const cfg=await activeNavConfig(c,locationId);if(!cfg)throw Object.assign(new Error('Ehhez a szalonhoz nincs aktív NAV/kibocsátói konfiguráció.'),{status:409,code:'NAV_CONFIG_MISSING'});

  const normalized:any[]=[];
  for(const item of requestedItems){const id=String(item?.product_id||item?.id||'').trim(),qty=Math.max(0,Number(item?.quantity||0));if(!id||!(qty>0))throw Object.assign(new Error('A termék és a pozitív mennyiség kötelező.'),{status:400,code:'ITEM_INVALID'});const p=(await c.query(`SELECT p.id::text id,p.name,COALESCE(NULLIF(to_jsonb(p)->>'retail_price_gross','')::numeric,NULLIF(to_jsonb(p)->>'sale_price','')::numeric,NULLIF(to_jsonb(p)->>'price','')::numeric,0)::numeric price,COALESCE(NULLIF(to_jsonb(p)->>'vat_rate','')::numeric,$2::numeric)::numeric vat_rate FROM products p WHERE p.id::text=$1 AND COALESCE(NULLIF(to_jsonb(p)->>'is_active','')::boolean,true)=true LIMIT 1`,[id,Number(cfg?.default_vat_rate??0.27)])).rows[0];if(!p)throw Object.assign(new Error('Egy kiválasztott termék nem található vagy inaktív.'),{status:400,code:'PRODUCT_NOT_FOUND'});const price=money(item?.unit_price??p.price),gross=money(price*qty);normalized.push({...p,quantity:qty,price,gross})}
  const total=money(normalized.reduce((n,x)=>n+x.gross,0));if(!(total>0))throw Object.assign(new Error('A számla végösszegének pozitívnak kell lennie.'),{status:409,code:'INVALID_INVOICE_TOTAL'});
  const sale=(await c.query(`INSERT INTO retail_sales(location_id,client_id,customer_name,customer_email,customer_phone,payment_method,gross_total,invoice_requested,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,true,$8) RETURNING *`,[locationId,String(req.body?.client_id||'')||null,name,email||null,String(req.body?.customer_phone||'')||null,method,total,actor(req)])).rows[0];
  const hasBalances=await tableExists('product_stock_balances');
  for(const item of normalized){await c.query(`INSERT INTO retail_sale_items(sale_id,product_id,product_name,quantity,unit_price_gross,gross_amount) VALUES($1,$2,$3,$4,$5,$6)`,[sale.id,item.id,item.name,item.quantity,item.price,item.gross]);if(hasBalances)await c.query(`UPDATE product_stock_balances SET quantity=GREATEST(0,COALESCE(quantity,0)-$3) WHERE product_id::text=$1 AND location_id::text=$2`,[item.id,locationId,item.quantity]).catch(()=>undefined)}
  const totalNet=money(normalized.reduce((n,x)=>n+x.gross/(1+Number(x.vat_rate||0.27)),0)),totalVat=money(total-totalNet),invoiceNo=await nextOfficialNumber(c),createdBy=actor(req);
  invoice=(await c.query(`INSERT INTO finance_invoices(location_id,direction,invoice_no,partner_name,customer_name,partner_tax_no,customer_tax_number,customer_vat_status,customer_country_code,customer_postal_code,customer_city,customer_address,issue_date,performance_date,due_date,currency,net_total,vat_total,gross_total,status,note,created_by,document_kind,invoice_type,nav_status,nav_validation_status,payment_method,payment_date,issued_at,issued_by) VALUES($1,'outgoing',$2,$3,$3,$4,$4,$5,$6,$7,$8,$9,CURRENT_DATE,CURRENT_DATE,CURRENT_DATE,'HUF',$10,$11,$12,'paid',$13,$14,'tax_invoice','NORMAL','not_submitted','not_validated',$15,CURRENT_DATE,now(),$14) RETURNING *`,[locationId,invoiceNo,name,tax||null,tax?'DOMESTIC':'PRIVATE_PERSON',country,postal,city,address,totalNet,totalVat,total,`Automatikus e-számla termékeladás ${sale.id}`,createdBy,PAYMENT_MAP[method]||'OTHER'])).rows[0];
  let line=0;for(const item of normalized){line++;const rate=Number(item.vat_rate||0.27),lineNet=money(item.gross/(1+rate)),lineVat=money(item.gross-lineNet);await c.query(`INSERT INTO finance_invoice_lines(invoice_id,line_number,description,quantity,unit_of_measure,unit_price_net,vat_rate,net_amount,vat_amount,gross_amount,product_id) VALUES($1,$2,$3,$4,'PIECE',$5,$6,$7,$8,$9,$10)`,[invoice.id,line,item.name,item.quantity,Number((lineNet/item.quantity).toFixed(4)),rate,lineNet,lineVat,item.gross,item.id])}
  await c.query(`UPDATE retail_sales SET finance_invoice_id=$2,invoice_requested=true WHERE id=$1`,[sale.id,invoice.id]);await c.query('COMMIT');
  let nav:any=null,navError:string|null=null;try{nav=await prepareQueuedInvoice(String(invoice.id),createdBy)}catch(e:any){navError=String(e?.message||e);console.error('[automatic-retail-e-invoice] NAV queue prepare failed',invoice.id,e?.code||'',navError)}
  return res.status(201).json({ok:true,sale:{...sale,finance_invoice_id:invoice.id,invoice_requested:true},invoice,items:normalized,total,e_invoice:true,nav_submission:nav,nav_queue_error:navError});
 }catch(e:any){await c.query('ROLLBACK').catch(()=>undefined);console.error('[automatic-retail-e-invoice] failed',e?.code||'',e?.message||e);const status=Number(e?.status||500);return res.status(status>=400&&status<600?status:500).json({message:String(e?.message||'A termékeladás nem rögzíthető.'),code:e?.code||'AUTOMATIC_RETAIL_E_INVOICE_FAILED',errors:e?.errors||undefined,e_invoice_required:true})}finally{c.release()}
});

export default router;
