import { Router } from "express";
import db from "../db";
import { AuthRequest } from "../middleware/auth";
import { requireIdempotencyKey, reverseFinancialMovement } from "../finance/financialIntegrity";

const router=Router();
const num=(v:any)=>{const n=Number(v??0);return Number.isFinite(n)?n:0};
const money=(v:any)=>Math.round(num(v)*100)/100;
const actor=(req:AuthRequest)=>req.user?.email||String(req.user?.id||"");
const role=(req:AuthRequest)=>String(req.user?.role||"").toLowerCase();
const isGlobal=(req:AuthRequest)=>["admin","manager","business_manager","owner"].includes(role(req));
const ownLocation=(req:AuthRequest)=>String(req.user?.location_id||"").trim()||null;
const requestedLocation=(req:AuthRequest)=>isGlobal(req)?(String(req.query.location_id??req.body?.location_id??"").trim()||null):ownLocation(req);

async function ensureSchema(){
 await db.query(`
  ALTER TABLE financial_accounts ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 100;
  ALTER TABLE financial_accounts ADD COLUMN IF NOT EXISTS allow_cash boolean NOT NULL DEFAULT true;
  ALTER TABLE financial_accounts ADD COLUMN IF NOT EXISTS allow_cashless boolean NOT NULL DEFAULT true;
  ALTER TABLE financial_accounts ADD COLUMN IF NOT EXISTS external_code text;
  ALTER TABLE financial_accounts ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
  ALTER TABLE financial_movements ADD COLUMN IF NOT EXISTS partner_id bigint;
  ALTER TABLE financial_movements ADD COLUMN IF NOT EXISTS payment_method_code text;
  ALTER TABLE financial_movements ADD COLUMN IF NOT EXISTS document_type_code text;
  ALTER TABLE financial_movements ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
  ALTER TABLE financial_movements ADD COLUMN IF NOT EXISTS cancelled_by text;
  ALTER TABLE financial_movements ADD COLUMN IF NOT EXISTS cancellation_reason text;
  ALTER TABLE financial_movements ADD COLUMN IF NOT EXISTS employee_id text;
  ALTER TABLE financial_movements ADD COLUMN IF NOT EXISTS client_id text;
  ALTER TABLE financial_movements ADD COLUMN IF NOT EXISTS service_id text;
  ALTER TABLE financial_movements ADD COLUMN IF NOT EXISTS product_id text;

  CREATE TABLE IF NOT EXISTS finance_partners(
   id bigserial PRIMARY KEY,location_id text,partner_type text NOT NULL DEFAULT 'company',name text NOT NULL,
   tax_number text,email text,phone text,address text,contact_name text,note text,supplier_id text,
   active boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_finance_partners_location ON finance_partners(location_id,active,name);

  CREATE TABLE IF NOT EXISTS finance_document_types(
   id bigserial PRIMARY KEY,location_id text,code text NOT NULL,name text NOT NULL,direction text NOT NULL DEFAULT 'both',
   group_key text NOT NULL DEFAULT 'other',system boolean NOT NULL DEFAULT false,active boolean NOT NULL DEFAULT true,
   sort_order integer NOT NULL DEFAULT 100,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS uq_finance_document_types_scope ON finance_document_types(COALESCE(location_id,''),code);

  CREATE TABLE IF NOT EXISTS finance_payment_methods(
   id bigserial PRIMARY KEY,location_id text,code text NOT NULL,name text NOT NULL,method_type text NOT NULL DEFAULT 'custom',
   account_id uuid,fee_percent numeric(9,4) NOT NULL DEFAULT 0,fee_fixed numeric(14,2) NOT NULL DEFAULT 0,
   processing_days integer NOT NULL DEFAULT 0,brand_fees jsonb NOT NULL DEFAULT '{}'::jsonb,allow_installments boolean NOT NULL DEFAULT false,
   active boolean NOT NULL DEFAULT true,sort_order integer NOT NULL DEFAULT 100,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS uq_finance_payment_methods_scope ON finance_payment_methods(COALESCE(location_id,''),code);

  CREATE TABLE IF NOT EXISTS finance_documents(
   id bigserial PRIMARY KEY,location_id text,document_no text,document_type_code text NOT NULL,document_date date NOT NULL DEFAULT CURRENT_DATE,
   status text NOT NULL DEFAULT 'posted',partner_id bigint,account_id uuid,direction text NOT NULL DEFAULT 'expense',amount numeric(14,2) NOT NULL DEFAULT 0,
   currency text NOT NULL DEFAULT 'HUF',content text,note text,reference_type text,reference_id text,movement_id uuid,
   created_by text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_finance_documents_scope ON finance_documents(location_id,document_date DESC);

  CREATE TABLE IF NOT EXISTS finance_online_settings(
   location_key text PRIMARY KEY,payment_link_enabled boolean NOT NULL DEFAULT false,booking_prepayment_enabled boolean NOT NULL DEFAULT false,
   membership_gift_enabled boolean NOT NULL DEFAULT false,provider text,provider_status text NOT NULL DEFAULT 'not_connected',
   prepayment_percent numeric(7,2) NOT NULL DEFAULT 0,payment_expiry_minutes integer NOT NULL DEFAULT 60,
   invoice_provider text,invoice_connection_status text NOT NULL DEFAULT 'not_connected',vat_rate numeric(7,2) NOT NULL DEFAULT 27,
   updated_by text,updated_at timestamptz NOT NULL DEFAULT now()
  );
 `);
 const defaults=[
  ['material_purchase','Alapanyag beszerzés','expense','inventory'],['product_purchase','Termék beszerzés','expense','inventory'],
  ['salary','Munkabér','expense','salary'],['tax','Adók és díjak','expense','tax'],['service_income','Szolgáltatások nyújtása','income','sales'],
  ['rental_income','Bérleti értékesítés','income','sales'],['product_income','Termék értékesítés','income','sales'],['other_income','Egyéb bevételek','income','other'],
  ['other_expense','Egyéb kiadások','expense','other'],['transfer','Tranzakciós díj / átvezetés','both','transfer'],['gift_card','Utalványok eladása','income','sales'],
  ['maintenance','Karbantartás','expense','operations'],['education','Oktatás','expense','hr'],['utilities','Közüzemi díjak','expense','operations'],
  ['rent','Bérleti díj','expense','operations'],['marketing','Marketing','expense','marketing'],['refund','Visszatérítés','expense','sales']
 ];
 for(const d of defaults) await db.query(`INSERT INTO finance_document_types(location_id,code,name,direction,group_key,system) VALUES(NULL,$1,$2,$3,$4,true) ON CONFLICT DO NOTHING`,d);
 const methods=[['cash','Készpénz','cash'],['card','Bankkártya','card'],['transfer','Átutalás','bank_transfer'],['voucher','Utalvány','voucher'],['online','Online bankkártya','online_card']];
 for(const m of methods) await db.query(`INSERT INTO finance_payment_methods(location_id,code,name,method_type) VALUES(NULL,$1,$2,$3) ON CONFLICT DO NOTHING`,m);
}
router.use(async(_req,_res,next)=>{try{await ensureSchema();next()}catch(e){next(e)}});
router.use((req:AuthRequest,res,next)=>{if(["employee","customer","guest"].includes(role(req)))return res.status(403).json({message:"Ehhez a pénzügyi adminisztrációhoz nincs jogosultsága."});next()});

router.get('/dashboard',async(req:AuthRequest,res,next)=>{try{
 const loc=requestedLocation(req),from=String(req.query.from||new Date(new Date().getFullYear(),0,1).toISOString().slice(0,10)),to=String(req.query.to||new Date().toISOString().slice(0,10));
 const p=[loc,from,to];
 const accounts=await db.query(`SELECT a.*,a.opening_balance+COALESCE(SUM(CASE WHEN m.direction='income' THEN m.amount ELSE -m.amount END),0)::numeric current_balance,
  COALESCE(SUM(CASE WHEN m.direction='income' AND m.occurred_at>=$2::date AND m.occurred_at<($3::date+1) THEN m.amount ELSE 0 END),0)::numeric period_income,
  COALESCE(SUM(CASE WHEN m.direction='expense' AND m.occurred_at>=$2::date AND m.occurred_at<($3::date+1) THEN m.amount ELSE 0 END),0)::numeric period_expense
  FROM financial_accounts a LEFT JOIN financial_movements m ON m.account_id=a.id WHERE ($1::text IS NULL OR a.location_id::text=$1 OR a.location_id IS NULL)
  GROUP BY a.id ORDER BY a.active DESC,a.sort_order,a.name`,p);
 const timeline=await db.query(`SELECT date_trunc('month',m.occurred_at)::date month,
  COALESCE(SUM(m.amount) FILTER(WHERE m.direction='income'),0)::numeric income,
  COALESCE(SUM(m.amount) FILTER(WHERE m.direction='expense'),0)::numeric expense
  FROM financial_movements m WHERE ($1::text IS NULL OR m.location_id::text=$1 OR m.location_id IS NULL) AND m.occurred_at>=$2::date AND m.occurred_at<($3::date+1)
  GROUP BY 1 ORDER BY 1`,p);
 const composition=await db.query(`SELECT COALESCE(c.name,m.document_type_code,m.reference_type,'Egyéb') label,m.direction,COALESCE(SUM(m.amount),0)::numeric amount FROM financial_movements m LEFT JOIN financial_categories c ON c.id=m.category_id WHERE ($1::text IS NULL OR m.location_id::text=$1 OR m.location_id IS NULL) AND m.occurred_at>=$2::date AND m.occurred_at<($3::date+1) GROUP BY 1,2 ORDER BY amount DESC LIMIT 30`,p);
 res.json({accounts:accounts.rows,timeline:timeline.rows,composition:composition.rows,from,to});
}catch(e){next(e)}});

router.patch('/accounts/:id',async(req:AuthRequest,res,next)=>{try{const b=req.body||{};const {rows}=await db.query(`UPDATE financial_accounts SET name=COALESCE(NULLIF($2,''),name),account_type=COALESCE(NULLIF($3,''),account_type),opening_balance=COALESCE($4,opening_balance),note=COALESCE($5,note),active=COALESCE($6,active),sort_order=COALESCE($7,sort_order),allow_cash=COALESCE($8,allow_cash),allow_cashless=COALESCE($9,allow_cashless),updated_at=now() WHERE id=$1::uuid RETURNING *`,[req.params.id,String(b.name||''),String(b.account_type||''),b.opening_balance==null?null:money(b.opening_balance),b.note??null,b.active==null?null:Boolean(b.active),b.sort_order==null?null:Number(b.sort_order),b.allow_cash==null?null:Boolean(b.allow_cash),b.allow_cashless==null?null:Boolean(b.allow_cashless)]);if(!rows[0])return res.status(404).json({message:'Pénztár nem található.'});res.json(rows[0])}catch(e){next(e)}});

router.get('/partners',async(req:AuthRequest,res,next)=>{try{const loc=requestedLocation(req),q=String(req.query.q||'').trim();const {rows}=await db.query(`SELECT p.*,COALESCE(SUM(CASE WHEN m.direction='income' THEN m.amount ELSE -m.amount END),0)::numeric balance FROM finance_partners p LEFT JOIN financial_movements m ON m.partner_id=p.id WHERE ($1::text IS NULL OR p.location_id=$1 OR p.location_id IS NULL) AND ($2='' OR p.name ILIKE '%'||$2||'%' OR COALESCE(p.tax_number,'') ILIKE '%'||$2||'%') GROUP BY p.id ORDER BY p.active DESC,p.name`,[loc,q]);res.json(rows)}catch(e){next(e)}});
router.post('/partners',async(req:AuthRequest,res,next)=>{try{const b=req.body||{},name=String(b.name||'').trim();if(!name)return res.status(400).json({message:'A partner neve kötelező.'});const loc=requestedLocation(req);const {rows}=await db.query(`INSERT INTO finance_partners(location_id,partner_type,name,tax_number,email,phone,address,contact_name,note,supplier_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[loc,String(b.partner_type||'company'),name,b.tax_number||null,b.email||null,b.phone||null,b.address||null,b.contact_name||null,b.note||null,b.supplier_id||null]);res.status(201).json(rows[0])}catch(e){next(e)}});
router.patch('/partners/:id',async(req:AuthRequest,res,next)=>{try{const b=req.body||{};const {rows}=await db.query(`UPDATE finance_partners SET partner_type=COALESCE($2,partner_type),name=COALESCE(NULLIF($3,''),name),tax_number=$4,email=$5,phone=$6,address=$7,contact_name=$8,note=$9,active=COALESCE($10,active),updated_at=now() WHERE id=$1 RETURNING *`,[req.params.id,b.partner_type??null,String(b.name||''),b.tax_number??null,b.email??null,b.phone??null,b.address??null,b.contact_name??null,b.note??null,b.active==null?null:Boolean(b.active)]);res.json(rows[0]||null)}catch(e){next(e)}});

router.get('/document-types',async(req:AuthRequest,res,next)=>{try{const loc=requestedLocation(req);const {rows}=await db.query(`SELECT * FROM finance_document_types WHERE active=true AND ($1::text IS NULL OR location_id=$1 OR location_id IS NULL) ORDER BY direction,sort_order,name`,[loc]);res.json(rows)}catch(e){next(e)}});
router.post('/document-types',async(req:AuthRequest,res,next)=>{try{const b=req.body||{},name=String(b.name||'').trim(),code=String(b.code||name.toLowerCase().replace(/[^a-z0-9]+/g,'_')).trim();if(!name||!code)return res.status(400).json({message:'Név és kód szükséges.'});const {rows}=await db.query(`INSERT INTO finance_document_types(location_id,code,name,direction,group_key,system,sort_order) VALUES($1,$2,$3,$4,$5,false,$6) RETURNING *`,[requestedLocation(req),code,name,String(b.direction||'both'),String(b.group_key||'other'),Number(b.sort_order||100)]);res.status(201).json(rows[0])}catch(e){next(e)}});

router.get('/payment-methods',async(req:AuthRequest,res,next)=>{try{const loc=requestedLocation(req);const {rows}=await db.query(`SELECT pm.*,a.name account_name FROM finance_payment_methods pm LEFT JOIN financial_accounts a ON a.id=pm.account_id WHERE pm.active=true AND ($1::text IS NULL OR pm.location_id=$1 OR pm.location_id IS NULL) ORDER BY pm.sort_order,pm.name`,[loc]);res.json(rows)}catch(e){next(e)}});
router.post('/payment-methods',async(req:AuthRequest,res,next)=>{try{const b=req.body||{},name=String(b.name||'').trim(),code=String(b.code||'').trim();if(!name||!code)return res.status(400).json({message:'A fizetési mód neve és kódja kötelező.'});const {rows}=await db.query(`INSERT INTO finance_payment_methods(location_id,code,name,method_type,account_id,fee_percent,fee_fixed,processing_days,brand_fees,allow_installments,sort_order) VALUES($1,$2,$3,$4,$5::uuid,$6,$7,$8,$9::jsonb,$10,$11) RETURNING *`,[requestedLocation(req),code,name,String(b.method_type||'custom'),b.account_id||null,money(b.fee_percent),money(b.fee_fixed),Number(b.processing_days||0),JSON.stringify(b.brand_fees||{}),Boolean(b.allow_installments),Number(b.sort_order||100)]);res.status(201).json(rows[0])}catch(e){next(e)}});
router.patch('/payment-methods/:id',async(req:AuthRequest,res,next)=>{try{const b=req.body||{};const {rows}=await db.query(`UPDATE finance_payment_methods SET name=COALESCE(NULLIF($2,''),name),account_id=COALESCE($3::uuid,account_id),fee_percent=COALESCE($4,fee_percent),fee_fixed=COALESCE($5,fee_fixed),processing_days=COALESCE($6,processing_days),brand_fees=COALESCE($7::jsonb,brand_fees),allow_installments=COALESCE($8,allow_installments),active=COALESCE($9,active),updated_at=now() WHERE id=$1 RETURNING *`,[req.params.id,String(b.name||''),b.account_id||null,b.fee_percent==null?null:money(b.fee_percent),b.fee_fixed==null?null:money(b.fee_fixed),b.processing_days==null?null:Number(b.processing_days),b.brand_fees==null?null:JSON.stringify(b.brand_fees),b.allow_installments==null?null:Boolean(b.allow_installments),b.active==null?null:Boolean(b.active)]);res.json(rows[0]||null)}catch(e){next(e)}});

router.get('/documents',async(req:AuthRequest,res,next)=>{try{const loc=requestedLocation(req),from=String(req.query.from||''),to=String(req.query.to||''),type=String(req.query.type||''),q=String(req.query.q||'');const {rows}=await db.query(`SELECT d.*,p.name partner_name,a.name account_name,dt.name document_type_name FROM finance_documents d LEFT JOIN finance_partners p ON p.id=d.partner_id LEFT JOIN financial_accounts a ON a.id=d.account_id LEFT JOIN finance_document_types dt ON dt.code=d.document_type_code AND (dt.location_id=d.location_id OR dt.location_id IS NULL) WHERE ($1::text IS NULL OR d.location_id=$1 OR d.location_id IS NULL) AND ($2='' OR d.document_date>=$2::date) AND ($3='' OR d.document_date<=$3::date) AND ($4='' OR d.document_type_code=$4) AND ($5='' OR COALESCE(d.document_no,'') ILIKE '%'||$5||'%' OR COALESCE(d.content,'') ILIKE '%'||$5||'%') ORDER BY d.document_date DESC,d.id DESC LIMIT 1000`,[loc,from,to,type,q]);res.json(rows)}catch(e){next(e)}});
router.post('/documents',async(req:AuthRequest,res,next)=>{const c=await db.connect();try{const b=req.body||{},amount=money(b.amount),direction=String(b.direction||'expense'),accountId=String(b.account_id||'').trim(),idempotencyKey=requireIdempotencyKey(req,'finance-document');if(!(amount>0)||!accountId)return res.status(400).json({message:'Pozitív összeg és pénztár/számla szükséges.'});await c.query('BEGIN');const acc=await c.query(`SELECT * FROM financial_accounts WHERE id=$1::uuid FOR UPDATE`,[accountId]);if(!acc.rows[0])throw Object.assign(new Error('Pénztár nem található.'),{status:404});const loc=String(acc.rows[0].location_id||requestedLocation(req)||'').trim()||null;const existing=(await c.query(`SELECT d.* FROM finance_documents d JOIN financial_movements m ON m.id=d.movement_id WHERE m.location_id IS NOT DISTINCT FROM $1::uuid AND m.idempotency_key=$2 FOR UPDATE`,[loc,idempotencyKey])).rows[0];if(existing){await c.query('COMMIT');return res.json({...existing,idempotent:true})}const mv=await c.query(`INSERT INTO financial_movements(location_id,account_id,direction,amount,occurred_at,reference_type,counterparty,note,created_by,partner_id,payment_method_code,document_type_code,employee_id,client_id,service_id,product_id,payment_status,posting_group_id,idempotency_key) VALUES($1,$2::uuid,$3,$4,COALESCE($5::timestamptz,now()),'finance_document',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'posted',gen_random_uuid(),$16) RETURNING *`,[loc,accountId,direction,amount,b.document_date||null,b.counterparty||null,b.note||null,actor(req),b.partner_id||null,b.payment_method_code||null,b.document_type_code||'other_expense',b.employee_id||null,b.client_id||null,b.service_id||null,b.product_id||null,idempotencyKey]);const doc=await c.query(`INSERT INTO finance_documents(location_id,document_no,document_type_code,document_date,status,partner_id,account_id,direction,amount,currency,content,note,reference_type,reference_id,movement_id,created_by) VALUES($1,$2,$3,COALESCE($4::date,CURRENT_DATE),'posted',$5,$6::uuid,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,[loc,b.document_no||null,b.document_type_code||'other_expense',b.document_date||null,b.partner_id||null,accountId,direction,amount,b.currency||'HUF',b.content||null,b.note||null,b.reference_type||'manual',b.reference_id||null,mv.rows[0].id,actor(req)]);await c.query('COMMIT');res.status(201).json(doc.rows[0])}catch(e:any){await c.query('ROLLBACK').catch(()=>undefined);if(e?.status)return res.status(e.status).json({message:e.message});next(e)}finally{c.release()}});

router.get('/operations',async(req:AuthRequest,res,next)=>{try{const loc=requestedLocation(req),from=String(req.query.from||''),to=String(req.query.to||''),account=String(req.query.account_id||''),partner=String(req.query.partner_id||''),method=String(req.query.payment_method||''),direction=String(req.query.direction||''),status=String(req.query.status||'active');const {rows}=await db.query(`SELECT m.*,a.name account_name,c.name category_name,p.name partner_name,pm.name payment_method_name FROM financial_movements m JOIN financial_accounts a ON a.id=m.account_id LEFT JOIN financial_categories c ON c.id=m.category_id LEFT JOIN finance_partners p ON p.id=m.partner_id LEFT JOIN finance_payment_methods pm ON pm.code=m.payment_method_code AND (pm.location_id=m.location_id OR pm.location_id IS NULL) WHERE ($1::text IS NULL OR m.location_id::text=$1 OR m.location_id IS NULL) AND ($2='' OR m.occurred_at>=$2::date) AND ($3='' OR m.occurred_at<($3::date+1)) AND ($4='' OR m.account_id::text=$4) AND ($5='' OR m.partner_id::text=$5) AND ($6='' OR m.payment_method_code=$6) AND ($7='' OR m.direction=$7) AND ($8='all' OR ($8='cancelled' AND m.cancelled_at IS NOT NULL) OR ($8='active' AND m.cancelled_at IS NULL)) ORDER BY m.occurred_at DESC,m.created_at DESC LIMIT 1500`,[loc,from,to,account,partner,method,direction,status]);res.json(rows)}catch(e){next(e)}});
router.post('/operations/:id/cancel',async(req:AuthRequest,res,next)=>{const client=await db.connect();try{await client.query('BEGIN');const result=await reverseFinancialMovement(client,{movementId:req.params.id,actor:actor(req),reason:String(req.body?.reason||''),locationId:isGlobal(req)?null:ownLocation(req),includeFees:true});await client.query('COMMIT');res.status(result.idempotent?200:201).json({ok:true,reversal_id:result.reversal.id,fee_reversal_ids:result.fee_reversals.map((x:any)=>x.id),idempotent:result.idempotent})}catch(e:any){await client.query('ROLLBACK').catch(()=>undefined);if(e?.status)return res.status(e.status).json({message:e.message,code:e.publicCode});next(e)}finally{client.release()}});

router.get('/reports/summary',async(req:AuthRequest,res,next)=>{try{const loc=requestedLocation(req),from=String(req.query.from||new Date(new Date().getFullYear(),0,1).toISOString().slice(0,10)),to=String(req.query.to||new Date().toISOString().slice(0,10));const {rows}=await db.query(`SELECT m.direction,COALESCE(c.name,m.document_type_code,m.reference_type,'Egyéb') category,COALESCE(SUM(m.amount),0)::numeric amount FROM financial_movements m LEFT JOIN financial_categories c ON c.id=m.category_id WHERE ($1::text IS NULL OR m.location_id::text=$1 OR m.location_id IS NULL) AND m.occurred_at>=$2::date AND m.occurred_at<($3::date+1) GROUP BY 1,2 ORDER BY 1,amount DESC`,[loc,from,to]);const totals=rows.reduce((a:any,r:any)=>{a[r.direction]=(a[r.direction]||0)+num(r.amount);return a},{income:0,expense:0});res.json({from,to,rows,totals,profit:money(totals.income-totals.expense)})}catch(e){next(e)}});
router.get('/reports/pnl',async(req:AuthRequest,res,next)=>{try{const loc=requestedLocation(req),year=Math.max(2020,Math.min(2100,Number(req.query.year||new Date().getFullYear())));const {rows}=await db.query(`SELECT extract(month from m.occurred_at)::int month,COALESCE(SUM(m.amount) FILTER(WHERE m.direction='income'),0)::numeric income,COALESCE(SUM(m.amount) FILTER(WHERE m.direction='expense'),0)::numeric expense FROM financial_movements m WHERE ($1::text IS NULL OR m.location_id::text=$1 OR m.location_id IS NULL) AND extract(year from m.occurred_at)=$2 GROUP BY 1 ORDER BY 1`,[loc,year]);res.json({year,rows:rows.map((r:any)=>({...r,profit:money(num(r.income)-num(r.expense))}))})}catch(e){next(e)}});
router.get('/reports/partner-balances',async(req:AuthRequest,res,next)=>{try{const loc=requestedLocation(req);const {rows}=await db.query(`SELECT p.id,p.name,p.partner_type,p.tax_number,COALESCE(SUM(CASE WHEN m.direction='income' THEN m.amount ELSE -m.amount END),0)::numeric balance FROM finance_partners p LEFT JOIN financial_movements m ON m.partner_id=p.id WHERE ($1::text IS NULL OR p.location_id=$1 OR p.location_id IS NULL) GROUP BY p.id ORDER BY p.name`,[loc]);res.json(rows)}catch(e){next(e)}});

router.get('/online-settings',async(req:AuthRequest,res,next)=>{try{const loc=requestedLocation(req),key=loc||'__global__';await db.query(`INSERT INTO finance_online_settings(location_key) VALUES($1) ON CONFLICT DO NOTHING`,[key]);const {rows}=await db.query(`SELECT * FROM finance_online_settings WHERE location_key=$1`,[key]);res.json(rows[0])}catch(e){next(e)}});
router.put('/online-settings',async(req:AuthRequest,res,next)=>{try{const loc=requestedLocation(req),key=loc||'__global__',b=req.body||{};const {rows}=await db.query(`INSERT INTO finance_online_settings(location_key,payment_link_enabled,booking_prepayment_enabled,membership_gift_enabled,provider,provider_status,prepayment_percent,payment_expiry_minutes,invoice_provider,invoice_connection_status,vat_rate,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(location_key) DO UPDATE SET payment_link_enabled=EXCLUDED.payment_link_enabled,booking_prepayment_enabled=EXCLUDED.booking_prepayment_enabled,membership_gift_enabled=EXCLUDED.membership_gift_enabled,provider=EXCLUDED.provider,provider_status=EXCLUDED.provider_status,prepayment_percent=EXCLUDED.prepayment_percent,payment_expiry_minutes=EXCLUDED.payment_expiry_minutes,invoice_provider=EXCLUDED.invoice_provider,invoice_connection_status=EXCLUDED.invoice_connection_status,vat_rate=EXCLUDED.vat_rate,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING *`,[key,Boolean(b.payment_link_enabled),Boolean(b.booking_prepayment_enabled),Boolean(b.membership_gift_enabled),b.provider||null,String(b.provider_status||'not_connected'),money(b.prepayment_percent),Number(b.payment_expiry_minutes||60),b.invoice_provider||null,String(b.invoice_connection_status||'not_connected'),money(b.vat_rate||27),actor(req)]);res.json(rows[0])}catch(e){next(e)}});

export default router;
