import {Router} from 'express';
import db from '../db';
import {evaluateClient} from '../loyalty/loyaltyProgramService';
import {requireAuth,AuthRequest} from '../middleware/auth';
import {generateAndDeliverClosedWorkOrder,loadWorkOrderArchive,renderClosedWorkOrderPdf} from '../workorders/workOrderDocument';

const router=Router();
router.use(requireAuth);

const actor=(r:AuthRequest)=>r.user?.email||String(r.user?.id||'');
const money=(v:any)=>Math.round(Number(v||0)*100)/100;
const REGULAR_METHODS=new Set(['cash','card','transfer','other']);
const accountType=(method:string)=>method==='cash'?'cash':method==='card'?'card':method==='transfer'?'bank':'other';
const accountName=(method:string)=>method==='cash'?'Készpénz pénztár':method==='card'?'Bankkártya terminál':method==='transfer'?'Bankszámla':'Egyéb fizetési számla';

let runtimeReady=false;
let runtimePromise:Promise<void>|null=null;

async function ensureRuntimeSchema(c:any){
 if(runtimeReady)return;
 if(runtimePromise)return runtimePromise;
 runtimePromise=(async()=>{
  await c.query(`
   CREATE EXTENSION IF NOT EXISTS pgcrypto;

   ALTER TABLE work_order_items ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
   ALTER TABLE work_order_payments ADD COLUMN IF NOT EXISTS paid_at timestamptz NOT NULL DEFAULT now();
   ALTER TABLE work_order_payments ADD COLUMN IF NOT EXISTS financial_account_id uuid;
   ALTER TABLE work_order_payments ADD COLUMN IF NOT EXISTS financial_movement_id uuid;

   ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS work_order_number text;
   ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS stock_consumed_at timestamptz;
   ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS document_status varchar(24) NOT NULL DEFAULT 'draft';
   ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS started_at timestamptz;
   ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS completed_at timestamptz;
   ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
   ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS status_updated_at timestamptz NOT NULL DEFAULT now();
   ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS closed_at timestamptz;
   ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS closed_by text;
   ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS locked_at timestamptz;
   ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS locked_reason text;
   ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS archived_at timestamptz;
   ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS archive_hash text;
   ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS gross_total numeric(14,2) NOT NULL DEFAULT 0;
   ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS discount_amount numeric(14,2) NOT NULL DEFAULT 0;
   ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS tip_amount numeric(14,2) NOT NULL DEFAULT 0;
   ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS amount_due numeric(14,2) NOT NULL DEFAULT 0;
   ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS amount_paid numeric(14,2) NOT NULL DEFAULT 0;
   ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS payment_status varchar(20) NOT NULL DEFAULT 'unpaid';
   ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS financial_closed_at timestamptz;
   ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS financial_closed_by text;

   DO $$ BEGIN
    IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='work_orders' AND column_name='closed_by' AND data_type<>'text') THEN
     ALTER TABLE work_orders ALTER COLUMN closed_by TYPE text USING closed_by::text;
    END IF;
   END $$;

   CREATE TABLE IF NOT EXISTS financial_accounts(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),location_id uuid REFERENCES locations(id) ON DELETE CASCADE,
    name text NOT NULL,account_type text NOT NULL DEFAULT 'cash',currency text NOT NULL DEFAULT 'HUF',
    opening_balance numeric(14,2) NOT NULL DEFAULT 0,active boolean NOT NULL DEFAULT true,note text,
    created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
   CREATE UNIQUE INDEX IF NOT EXISTS financial_accounts_location_name_uq
    ON financial_accounts(COALESCE(location_id,'00000000-0000-0000-0000-000000000000'::uuid),lower(name));

   CREATE TABLE IF NOT EXISTS financial_movements(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
    account_id uuid NOT NULL REFERENCES financial_accounts(id) ON DELETE RESTRICT,direction text NOT NULL,
    amount numeric(14,2) NOT NULL,occurred_at timestamptz NOT NULL DEFAULT now(),reference_type text,reference_id text,
    counterparty text,note text,created_by text,created_at timestamptz NOT NULL DEFAULT now());
   CREATE INDEX IF NOT EXISTS financial_movements_account_date_idx ON financial_movements(account_id,occurred_at DESC);

   CREATE TABLE IF NOT EXISTS invoice_number_counters(year integer PRIMARY KEY,last_value bigint NOT NULL DEFAULT 0,updated_at timestamptz NOT NULL DEFAULT now());
   CREATE OR REPLACE FUNCTION next_internal_invoice_number() RETURNS text LANGUAGE plpgsql AS $$
   DECLARE y integer:=EXTRACT(YEAR FROM CURRENT_DATE)::integer; n bigint;
   BEGIN
    INSERT INTO invoice_number_counters(year,last_value) VALUES(y,1)
    ON CONFLICT(year) DO UPDATE SET last_value=invoice_number_counters.last_value+1,updated_at=now()
    RETURNING last_value INTO n;
    RETURN format('KLEO-SZ-%s-%s',y,lpad(n::text,6,'0'));
   END $$;

   CREATE TABLE IF NOT EXISTS finance_invoices(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
    direction text NOT NULL,invoice_no text,partner_name text,issue_date date NOT NULL DEFAULT CURRENT_DATE,
    performance_date date NOT NULL DEFAULT CURRENT_DATE,due_date date NOT NULL DEFAULT CURRENT_DATE,currency text NOT NULL DEFAULT 'HUF',
    net_total numeric(14,2) NOT NULL DEFAULT 0,vat_total numeric(14,2) NOT NULL DEFAULT 0,gross_total numeric(14,2) NOT NULL DEFAULT 0,
    status text NOT NULL DEFAULT 'draft',work_order_id text,note text,created_by text,document_kind text NOT NULL DEFAULT 'internal_draft',
    created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
   ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS document_kind text NOT NULL DEFAULT 'internal_draft';
   CREATE UNIQUE INDEX IF NOT EXISTS finance_invoices_work_order_outgoing_uq ON finance_invoices(work_order_id) WHERE direction='outgoing' AND work_order_id IS NOT NULL;

   CREATE TABLE IF NOT EXISTS work_order_commission_events(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),work_order_id uuid NOT NULL REFERENCES work_orders(id),employee_id uuid NOT NULL REFERENCES employees(id),
    base_amount numeric(14,2) NOT NULL DEFAULT 0,tip_amount numeric(14,2) NOT NULL DEFAULT 0,source_type text NOT NULL DEFAULT 'work_order_finalization',
    status text NOT NULL DEFAULT 'open',note text,created_at timestamptz NOT NULL DEFAULT now(),created_by text,UNIQUE(work_order_id,employee_id,source_type));

   CREATE TABLE IF NOT EXISTS product_stock_balances(
    id bigserial PRIMARY KEY,product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,location_id uuid,
    quantity numeric(14,3) NOT NULL DEFAULT 0,unit_cost numeric(14,4) NOT NULL DEFAULT 0,min_quantity numeric(14,3) NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now());
   ALTER TABLE product_stock_balances ADD COLUMN IF NOT EXISTS unit_cost numeric(14,4) NOT NULL DEFAULT 0;
   ALTER TABLE product_stock_balances ADD COLUMN IF NOT EXISTS min_quantity numeric(14,3) NOT NULL DEFAULT 0;
   CREATE UNIQUE INDEX IF NOT EXISTS product_stock_balances_product_location_uq ON product_stock_balances(product_id,location_id) WHERE location_id IS NOT NULL;
   CREATE UNIQUE INDEX IF NOT EXISTS product_stock_balances_product_global_uq ON product_stock_balances(product_id) WHERE location_id IS NULL;

   CREATE TABLE IF NOT EXISTS inventory_movements(
    id bigserial PRIMARY KEY,product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,location_id uuid,
    work_order_id uuid REFERENCES work_orders(id) ON DELETE SET NULL,movement_type varchar(32) NOT NULL,quantity numeric(14,3) NOT NULL,
    balance_after numeric(14,3),unit_cost numeric(14,4) NOT NULL DEFAULT 0,stock_value_after numeric(16,2) NOT NULL DEFAULT 0,
    note text,created_by text,created_at timestamptz NOT NULL DEFAULT now());
   ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS unit_cost numeric(14,4) NOT NULL DEFAULT 0;
   ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS stock_value_after numeric(16,2) NOT NULL DEFAULT 0;
   CREATE UNIQUE INDEX IF NOT EXISTS inventory_movements_workorder_product_location_consumption_uq
    ON inventory_movements(work_order_id,product_id,location_id) WHERE movement_type='work_order_consumption' AND location_id IS NOT NULL;
   CREATE UNIQUE INDEX IF NOT EXISTS inventory_movements_workorder_product_global_consumption_uq
    ON inventory_movements(work_order_id,product_id) WHERE movement_type='work_order_consumption' AND location_id IS NULL;

   CREATE TABLE IF NOT EXISTS service_material_requirements(
    id bigserial PRIMARY KEY,service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    default_quantity numeric(14,3) NOT NULL DEFAULT 1,unit text NOT NULL DEFAULT 'db',required boolean NOT NULL DEFAULT true,active boolean NOT NULL DEFAULT true,
    note text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(service_id,product_id));

   CREATE TABLE IF NOT EXISTS salon_stock_requests(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),location_id uuid NOT NULL REFERENCES locations(id),product_id uuid NOT NULL REFERENCES products(id),
    requested_quantity numeric(14,3) NOT NULL CHECK(requested_quantity>0),approved_quantity numeric(14,3),supplied_quantity numeric(14,3) NOT NULL DEFAULT 0,
    status text NOT NULL DEFAULT 'requested',source text NOT NULL DEFAULT 'manual',source_work_order_id uuid,note text,created_by text,approved_by text,
    created_at timestamptz NOT NULL DEFAULT now(),approved_at timestamptz,updated_at timestamptz NOT NULL DEFAULT now());
   ALTER TABLE salon_stock_requests ADD COLUMN IF NOT EXISTS purchase_order_id bigint;

   CREATE TABLE IF NOT EXISTS work_order_status_history(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),work_order_id uuid NOT NULL REFERENCES work_orders(id) ON DELETE RESTRICT,
    status_kind text NOT NULL,from_status text,to_status text NOT NULL,changed_at timestamptz NOT NULL DEFAULT now(),changed_by text,
    reason text,note text,metadata jsonb NOT NULL DEFAULT '{}'::jsonb);

   CREATE TABLE IF NOT EXISTS work_order_archive(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),work_order_id uuid NOT NULL,work_order_number text NOT NULL,
    archived_at timestamptz NOT NULL DEFAULT now(),terminal_status text NOT NULL,snapshot jsonb NOT NULL,snapshot_hash text NOT NULL,
    pdf_generated_at timestamptz,email_sent_at timestamptz,email_status text,email_recipients jsonb,email_error text,UNIQUE(work_order_id));
   ALTER TABLE work_order_archive ADD COLUMN IF NOT EXISTS pdf_generated_at timestamptz;
   ALTER TABLE work_order_archive ADD COLUMN IF NOT EXISTS email_sent_at timestamptz;
   ALTER TABLE work_order_archive ADD COLUMN IF NOT EXISTS email_status text;
   ALTER TABLE work_order_archive ADD COLUMN IF NOT EXISTS email_recipients jsonb;
   ALTER TABLE work_order_archive ADD COLUMN IF NOT EXISTS email_error text;

   DO $$ BEGIN IF to_regclass('public.loyalty_checkout_settlements') IS NOT NULL THEN
    ALTER TABLE loyalty_checkout_settlements ADD COLUMN IF NOT EXISTS finalized_at timestamptz;
    ALTER TABLE loyalty_checkout_settlements ADD COLUMN IF NOT EXISTS finalization_payload jsonb;
   END IF; END $$;
  `);
  runtimeReady=true;
 })().catch(err=>{runtimePromise=null;throw err});
 return runtimePromise;
}

async function resolveAccount(c:any,wo:any,method:string,supplied:string){
 if(supplied){const q=await c.query(`SELECT * FROM financial_accounts WHERE id=$1::uuid AND active=true FOR UPDATE`,[supplied]);if(!q.rows[0])throw new Error(`A pénzügyi számla nem található: ${supplied}`);return q.rows[0]}
 const type=accountType(method);
 let q=await c.query(`SELECT * FROM financial_accounts WHERE active=true AND account_type=$1 AND (location_id IS NOT DISTINCT FROM $2::uuid OR location_id IS NULL) ORDER BY CASE WHEN location_id IS NOT DISTINCT FROM $2::uuid THEN 0 ELSE 1 END,created_at LIMIT 1 FOR UPDATE`,[type,wo.location_id||null]);
 if(q.rows[0])return q.rows[0];
 const name=accountName(method);
 await c.query(`INSERT INTO financial_accounts(location_id,name,account_type,currency,opening_balance,active,note) SELECT $1::uuid,$2,$3,'HUF',0,true,'Automatikusan létrehozva munkalap-véglegesítéshez' WHERE NOT EXISTS(SELECT 1 FROM financial_accounts WHERE location_id IS NOT DISTINCT FROM $1::uuid AND lower(name)=lower($2))`,[wo.location_id||null,name,type]);
 q=await c.query(`SELECT * FROM financial_accounts WHERE active=true AND location_id IS NOT DISTINCT FROM $1::uuid AND lower(name)=lower($2) ORDER BY created_at LIMIT 1 FOR UPDATE`,[wo.location_id||null,name]);
 if(!q.rows[0])throw new Error(`Nem hozható létre pénzügyi számla ehhez a fizetéshez: ${method}`);
 return q.rows[0];
}

async function consumeStock(c:any,workOrder:any,by:string){
 if(workOrder.stock_consumed_at)return{consumed:[],replenishment_requests:[],idempotent:true};
 const direct=(await c.query(`SELECT product_id,SUM(quantity)::numeric quantity FROM work_order_items WHERE work_order_id=$1 AND item_type='product' AND product_id IS NOT NULL GROUP BY product_id`,[workOrder.id])).rows;
 const material=(await c.query(`SELECT r.product_id,SUM(COALESCE(wi.quantity,1)*r.default_quantity)::numeric quantity FROM work_order_items wi JOIN service_material_requirements r ON r.service_id=wi.service_id AND r.active=true WHERE wi.work_order_id=$1 AND wi.item_type='service' AND wi.service_id IS NOT NULL GROUP BY r.product_id`,[workOrder.id])).rows;
 const totals=new Map<string,{quantity:number,direct:number,material:number}>();
 for(const row of direct){const id=String(row.product_id),q=Number(row.quantity||0);if(!(q>0))continue;const old=totals.get(id)||{quantity:0,direct:0,material:0};old.quantity+=q;old.direct+=q;totals.set(id,old)}
 for(const row of material){const id=String(row.product_id),q=Number(row.quantity||0);if(!(q>0))continue;const old=totals.get(id)||{quantity:0,direct:0,material:0};old.quantity+=q;old.material+=q;totals.set(id,old)}
 const consumed:any[]=[];const replenishment:any[]=[];
 for(const [productId,item] of totals.entries()){
  await c.query(`INSERT INTO product_stock_balances(product_id,location_id,quantity,unit_cost,min_quantity) SELECT $1,$2::uuid,0,0,0 WHERE NOT EXISTS(SELECT 1 FROM product_stock_balances WHERE product_id=$1 AND location_id IS NOT DISTINCT FROM $2::uuid)`,[productId,workOrder.location_id||null]);
  const balance=(await c.query(`SELECT id,quantity::numeric,COALESCE(unit_cost,0)::numeric unit_cost,COALESCE(min_quantity,0)::numeric min_quantity FROM product_stock_balances WHERE product_id=$1 AND location_id IS NOT DISTINCT FROM $2::uuid FOR UPDATE`,[productId,workOrder.location_id||null])).rows[0];
  const current=Number(balance?.quantity||0),qty=item.quantity;
  if(current+1e-9<qty){const p=await c.query(`SELECT name FROM products WHERE id=$1`,[productId]);throw new Error(`Nincs elegendő készlet: ${p.rows[0]?.name||productId}. Szükséges: ${qty}, elérhető: ${current}.`)}
  const after=current-qty,unitCost=Number(balance?.unit_cost||0),stockValue=money(after*unitCost);
  await c.query(`UPDATE product_stock_balances SET quantity=$2,updated_at=now() WHERE id=$1`,[balance.id,after]);
  await c.query(`INSERT INTO inventory_movements(product_id,location_id,work_order_id,movement_type,quantity,balance_after,unit_cost,stock_value_after,note,created_by) VALUES($1,$2::uuid,$3,'work_order_consumption',$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,[productId,workOrder.location_id||null,workOrder.id,-qty,after,unitCost,stockValue,`Automatikus munkalap-fogyás · közvetlen termék: ${item.direct.toFixed(3)} · szolgáltatási anyagnorma: ${item.material.toFixed(3)}`,by]);
  consumed.push({product_id:productId,quantity:qty,direct_quantity:item.direct,service_material_quantity:item.material,balance_after:after,unit_cost:unitCost,stock_value_after:stockValue});
  const minQty=Number(balance?.min_quantity||0);
  if(workOrder.location_id&&minQty>0&&after<=minQty){
   const open=(await c.query(`SELECT id::text,status,requested_quantity::numeric FROM salon_stock_requests WHERE location_id=$1::uuid AND product_id=$2::uuid AND status IN('requested','approved','partially_supplied') ORDER BY created_at DESC LIMIT 1`,[workOrder.location_id,productId])).rows[0];
   if(open)replenishment.push({...open,product_id:productId,existing:true});
   else{
    const target=Math.max(minQty*2,minQty+qty),requested=Math.max(0.01,target-after);
    const created=(await c.query(`INSERT INTO salon_stock_requests(location_id,product_id,requested_quantity,status,source,source_work_order_id,note,created_by) VALUES($1::uuid,$2::uuid,$3,'requested','workorder_auto',$4::uuid,$5,$6) RETURNING id::text,status,requested_quantity::numeric`,[workOrder.location_id,productId,requested,workOrder.id,'Automatikus készletfeltöltési igény: munkalap-zárás után a készlet elérte vagy alulmúlta a minimumszintet.',by])).rows[0];
    replenishment.push({...created,product_id:productId,existing:false});
   }
  }
 }
 return{consumed,replenishment_requests:replenishment,idempotent:false};
}

async function ensureInvoiceDraft(c:any,wo:any,by:string){
 const old=(await c.query(`SELECT * FROM finance_invoices WHERE work_order_id=$1 AND direction='outgoing' LIMIT 1`,[wo.id])).rows[0];
 if(old)return old;
 const gross=money(wo.amount_due||wo.gross_total||0),vatRate=27,net=money(gross/(1+vatRate/100)),vat=money(gross-net);
 const invoiceNo=(await c.query(`SELECT next_internal_invoice_number() invoice_no`)).rows[0].invoice_no;
 return (await c.query(`INSERT INTO finance_invoices(location_id,direction,invoice_no,partner_name,issue_date,performance_date,due_date,currency,net_total,vat_total,gross_total,status,work_order_id,note,created_by,document_kind) VALUES($1,'outgoing',$2,$3,CURRENT_DATE,CURRENT_DATE,CURRENT_DATE,'HUF',$4,$5,$6,'draft',$7,$8,$9,'internal_draft') RETURNING *`,[wo.location_id||null,invoiceNo,wo.client_name||'Magánszemély',net,vat,gross,wo.id,`Automatikus belső számlatervezet a ${wo.work_order_number||wo.id} munkalaphoz.`,by])).rows[0];
}

async function ensureArchive(c:any,wo:any){
 const old=(await c.query(`SELECT * FROM work_order_archive WHERE work_order_id=$1::uuid LIMIT 1`,[wo.id])).rows[0];
 if(old)return old;
 const items=(await c.query(`SELECT * FROM work_order_items WHERE work_order_id=$1::uuid ORDER BY created_at,id`,[wo.id])).rows;
 const payments=(await c.query(`SELECT * FROM work_order_payments WHERE work_order_id=$1::uuid ORDER BY paid_at,id`,[wo.id])).rows;
 const snapshot={header:wo,items,payments};
 const hash=(await c.query(`SELECT encode(digest(convert_to($1::text,'UTF8'),'sha256'),'hex') hash`,[JSON.stringify(snapshot)])).rows[0].hash;
 return (await c.query(`INSERT INTO work_order_archive(work_order_id,work_order_number,archived_at,terminal_status,snapshot,snapshot_hash) VALUES($1::uuid,$2,COALESCE($3::timestamptz,now()),$4,$5::jsonb,$6) ON CONFLICT(work_order_id) DO UPDATE SET work_order_number=EXCLUDED.work_order_number,terminal_status=EXCLUDED.terminal_status,snapshot=EXCLUDED.snapshot,snapshot_hash=EXCLUDED.snapshot_hash RETURNING *`,[wo.id,wo.work_order_number||`KLEO-ML-${String(wo.id).slice(0,8)}`,wo.archived_at||wo.locked_at||new Date().toISOString(),wo.status||'completed',JSON.stringify(snapshot),hash])).rows[0];
}

async function finalizeTransaction(req:AuthRequest){
 const c=await db.connect();
 try{
  await ensureRuntimeSchema(c);
  await c.query('BEGIN');
  const wo=(await c.query(`SELECT * FROM work_orders WHERE id=$1::uuid FOR UPDATE`,[req.params.id])).rows[0];
  if(!wo){await c.query('ROLLBACK');return{status:404,body:{message:'A munkalap nem található.'}}}
  if(wo.locked_at||wo.archived_at){
   const archive=await ensureArchive(c,wo);await c.query('COMMIT');return{status:200,body:{idempotent:true,work_order:wo,archive,message:'A munkalap már lezárt és archivált.'}}
  }
  if(String(wo.status||'')!=='in_progress')throw new Error('A munkalap csak Folyamatban állapotból zárható véglegesen.');
  if(String(wo.payment_status||'')!=='paid'||!wo.financial_closed_at)throw new Error('A munkalap csak teljesen kifizetett és pénzügyileg lezárt állapotban véglegesíthető.');

  const hasSettlementTable=(await c.query(`SELECT to_regclass('public.loyalty_checkout_settlements') IS NOT NULL ok`)).rows[0]?.ok;
  const settlement=hasSettlementTable?(await c.query(`SELECT * FROM loyalty_checkout_settlements WHERE work_order_id=$1 FOR UPDATE`,[req.params.id])).rows[0]||null:null;
  const defaultAccount=String(req.body?.financial_account_id||'').trim();
  const mappings=req.body?.payment_accounts||{};
  const payments=(await c.query(`SELECT * FROM work_order_payments WHERE work_order_id=$1 ORDER BY paid_at,id`,[req.params.id])).rows;
  for(const p of payments){
   const method=String(p.payment_method||'').toLowerCase();
   if(!REGULAR_METHODS.has(method)||String(p.note||'').toLowerCase().includes('hűség wallet')||p.financial_movement_id)continue;
   const preferred=String(mappings?.[method]||defaultAccount||'').trim();
   const account=await resolveAccount(c,wo,method,preferred);
   const movement=(await c.query(`INSERT INTO financial_movements(location_id,account_id,direction,amount,occurred_at,reference_type,reference_id,counterparty,note,created_by) VALUES($1,$2::uuid,'income',$3,COALESCE($4,now()),'work_order_payment',$5,$6,$7,$8) RETURNING id`,[wo.location_id||account.location_id,account.id,money(p.amount),p.paid_at||null,String(p.id),wo.client_name||null,`Munkalap ${wo.work_order_number||wo.id} · ${method}`,actor(req)])).rows[0];
   await c.query(`UPDATE work_order_payments SET financial_account_id=$2::uuid,financial_movement_id=$3::uuid WHERE id=$1`,[p.id,account.id,movement.id]);
  }

  const inventory=await consumeStock(c,wo,actor(req));
  const commissionBase=Math.max(0,money(Number(wo.amount_due||0)-Number(wo.tip_amount||0)));
  if(wo.employee_id&&commissionBase>0)await c.query(`INSERT INTO work_order_commission_events(work_order_id,employee_id,base_amount,tip_amount,source_type,status,note,created_by) VALUES($1,$2,$3,$4,'work_order_finalization','open',$5,$6) ON CONFLICT(work_order_id,employee_id,source_type) DO UPDATE SET base_amount=EXCLUDED.base_amount,tip_amount=EXCLUDED.tip_amount,note=EXCLUDED.note`,[wo.id,wo.employee_id,commissionBase,money(wo.tip_amount),`Jutalékalap a(z) ${wo.work_order_number||wo.id} végleges lezárásából`,actor(req)]);

  if(wo.appointment_id)await c.query(`UPDATE appointments SET status='completed',work_order_id=COALESCE(work_order_id,$2::uuid),work_order_number=COALESCE(work_order_number,$3) WHERE id=$1::uuid`,[wo.appointment_id,wo.id,wo.work_order_number||null]);

  const previousDocumentStatus=String(wo.document_status||'open');
  const hasArchiveTrigger=(await c.query(`SELECT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='trg_work_orders_lock_before_update' AND NOT tgisinternal) ok`)).rows[0]?.ok;
  const lockSql=hasArchiveTrigger?'':`,locked_at=COALESCE(locked_at,now()),locked_reason=COALESCE(locked_reason,'TERMINAL_STATUS:COMPLETED'),archived_at=COALESCE(archived_at,now())`;
  const updated=(await c.query(`UPDATE work_orders SET stock_consumed_at=COALESCE(stock_consumed_at,now()),status='completed',document_status='completed',completed_at=COALESCE(completed_at,now()),closed_at=COALESCE(closed_at,now()),closed_by=COALESCE(closed_by,$2),status_updated_at=now(),updated_at=now()${lockSql} WHERE id=$1::uuid RETURNING *`,[wo.id,actor(req)])).rows[0];

  const archive=await ensureArchive(c,updated);
  if(!hasArchiveTrigger&&!updated.archive_hash)await c.query(`UPDATE work_orders SET archive_hash=$2 WHERE id=$1::uuid`,[wo.id,archive.snapshot_hash]);

  await c.query(`INSERT INTO work_order_status_history(work_order_id,status_kind,from_status,to_status,changed_by,reason,note,metadata) VALUES($1,'document',$2,'completed',$3,'FINALIZATION',$4,$5::jsonb)`,[wo.id,previousDocumentStatus,actor(req),'Végleges lezárás: fizetés, készlet, pénzügy, jutalék és archiválás lezárva.',JSON.stringify({service_status_from:wo.status,service_status_to:'completed',inventory_consumed:inventory.consumed.length,replenishment_requests:inventory.replenishment_requests.length})]).catch(()=>undefined);

  const invoice=await ensureInvoiceDraft(c,{...wo,...updated},actor(req));
  if(settlement)await c.query(`UPDATE loyalty_checkout_settlements SET finalized_at=COALESCE(finalized_at,now()),finalization_payload=$2::jsonb WHERE work_order_id=$1`,[wo.id,JSON.stringify({financial_account_id:defaultAccount||null,payment_accounts:mappings,finalized_by:actor(req),invoice_id:invoice.id,invoice_no:invoice.invoice_no,inventory})]);
  if(wo.client_id)await evaluateClient(c,String(wo.client_id),'workorder_finalized',actor(req));
  await c.query('COMMIT');
  return{status:200,body:{work_order:updated,archive,invoice,inventory,finalized:true,appointment_completed:Boolean(wo.appointment_id),loyalty_settlement:Boolean(settlement)}};
 }catch(e:any){
  await c.query('ROLLBACK').catch(()=>undefined);
  throw e;
 }finally{c.release()}
}

router.post('/workorders/:id/finalize',async(req:AuthRequest,res,next)=>{
 try{
  const result=await finalizeTransaction(req);
  if(result.status!==200)return res.status(result.status).json(result.body);
  let delivery:any=null;
  try{
   delivery=await generateAndDeliverClosedWorkOrder(req.params.id,{sendMail:true,forceMail:false});
  }catch(e:any){
   delivery={pdf_generated:false,mail:{sent:false,error:String(e?.message||e)}};
   console.error('[workorder-finalization] post-commit PDF/email delivery failed',e?.message||e);
  }
  const {pdf,...deliveryMeta}=delivery||{};
  res.json({...result.body,delivery:deliveryMeta});
 }catch(e:any){
  const m=String(e?.message||'A munkalap végleges lezárása nem sikerült.');
  if(/Folyamatban|pénztári|kifizetett|pénzügyi|készlet|anyag|számla|fizetéshez/i.test(m))return res.status(409).json({message:m});
  next(e);
 }
});

router.get('/workorders/:id/pdf',async(req,res,next)=>{
 try{
  const c=await db.connect();try{await ensureRuntimeSchema(c)}finally{c.release()}
  const archive=await loadWorkOrderArchive(req.params.id);
  if(!archive)return res.status(404).json({message:'A lezárt munkalap PDF-je még nem készíthető el, mert nincs archív snapshot.'});
  const pdf=await renderClosedWorkOrderPdf(archive);
  await db.query(`UPDATE work_order_archive SET pdf_generated_at=now() WHERE work_order_id=$1::uuid`,[req.params.id]).catch(()=>undefined);
  const filename=`${archive.work_order_number||'lezart-munkalap'}.pdf`.replace(/[^A-Za-z0-9._-]/g,'_');
  res.setHeader('Content-Type','application/pdf');
  res.setHeader('Content-Disposition',`attachment; filename="${filename}"`);
  res.setHeader('Content-Length',String(pdf.length));
  res.send(pdf);
 }catch(e){next(e)}
});

router.post('/workorders/:id/email',async(req,res,next)=>{
 try{
  const c=await db.connect();try{await ensureRuntimeSchema(c)}finally{c.release()}
  const delivery=await generateAndDeliverClosedWorkOrder(req.params.id,{sendMail:true,forceMail:true});
  const {pdf,...meta}=delivery;res.json(meta);
 }catch(e){next(e)}
});

export default router;
