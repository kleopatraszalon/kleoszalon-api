import {Router} from 'express';
import db from '../db';
import {requireAuth,AuthRequest} from '../middleware/auth';

const router=Router();router.use(requireAuth);
const actor=(r:AuthRequest)=>r.user?.email||String(r.user?.id||'');
const money=(v:any)=>Math.round(Number(v||0)*100)/100;
const REGULAR_METHODS=new Set(['cash','card','transfer','other']);
const accountType=(method:string)=>method==='cash'?'cash':method==='card'?'card':method==='transfer'?'bank':'other';
const accountName=(method:string)=>method==='cash'?'Készpénz pénztár':method==='card'?'Bankkártya terminál':method==='transfer'?'Bankszámla':'Egyéb fizetési számla';
let runtimeReady=false;
async function ensureRuntimeSchema(c:any){if(runtimeReady)return;await c.query(`
 CREATE EXTENSION IF NOT EXISTS pgcrypto;
 ALTER TABLE work_order_payments ADD COLUMN IF NOT EXISTS financial_account_id uuid;
 ALTER TABLE work_order_payments ADD COLUMN IF NOT EXISTS financial_movement_id uuid;
 ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS stock_consumed_at timestamptz;
 ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS document_status varchar(24) NOT NULL DEFAULT 'draft';
 ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS closed_at timestamptz;
 ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS closed_by text;
 DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='work_orders' AND column_name='closed_by' AND data_type<>'text') THEN
   ALTER TABLE work_orders ALTER COLUMN closed_by TYPE text USING closed_by::text;
  END IF;
  IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='work_order_status_history' AND column_name='changed_by' AND data_type<>'text') THEN
   ALTER TABLE work_order_status_history ALTER COLUMN changed_by TYPE text USING changed_by::text;
  END IF;
 END $$;
 CREATE TABLE IF NOT EXISTS work_order_commission_events(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),work_order_id uuid NOT NULL REFERENCES work_orders(id),employee_id uuid NOT NULL REFERENCES employees(id),
  base_amount numeric(14,2) NOT NULL DEFAULT 0,tip_amount numeric(14,2) NOT NULL DEFAULT 0,source_type text NOT NULL DEFAULT 'work_order_finalization',
  status text NOT NULL DEFAULT 'open',note text,created_at timestamptz NOT NULL DEFAULT now(),created_by text,UNIQUE(work_order_id,employee_id,source_type));
 CREATE INDEX IF NOT EXISTS work_order_commission_events_employee_idx ON work_order_commission_events(employee_id,created_at DESC);
 CREATE INDEX IF NOT EXISTS work_order_commission_events_work_order_idx ON work_order_commission_events(work_order_id);
 CREATE TABLE IF NOT EXISTS product_stock_balances(
  id bigserial PRIMARY KEY,product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,location_id uuid,quantity numeric(14,3) NOT NULL DEFAULT 0,
  unit_cost numeric(14,4) NOT NULL DEFAULT 0,min_quantity numeric(14,3) NOT NULL DEFAULT 0,updated_at timestamptz NOT NULL DEFAULT now());
 ALTER TABLE product_stock_balances ADD COLUMN IF NOT EXISTS unit_cost numeric(14,4) NOT NULL DEFAULT 0;
 ALTER TABLE product_stock_balances ADD COLUMN IF NOT EXISTS min_quantity numeric(14,3) NOT NULL DEFAULT 0;
 CREATE UNIQUE INDEX IF NOT EXISTS product_stock_balances_product_location_uq ON product_stock_balances(product_id,location_id) WHERE location_id IS NOT NULL;
 CREATE UNIQUE INDEX IF NOT EXISTS product_stock_balances_product_global_uq ON product_stock_balances(product_id) WHERE location_id IS NULL;
 CREATE TABLE IF NOT EXISTS inventory_movements(
  id bigserial PRIMARY KEY,product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,location_id uuid,work_order_id uuid REFERENCES work_orders(id) ON DELETE SET NULL,
  movement_type varchar(32) NOT NULL,quantity numeric(14,3) NOT NULL,balance_after numeric(14,3),unit_cost numeric(14,4) NOT NULL DEFAULT 0,
  stock_value_after numeric(16,2) NOT NULL DEFAULT 0,note text,created_by text,created_at timestamptz NOT NULL DEFAULT now());
 ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS unit_cost numeric(14,4) NOT NULL DEFAULT 0;
 ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS stock_value_after numeric(16,2) NOT NULL DEFAULT 0;
 DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='inventory_movements' AND column_name='created_by' AND data_type<>'text') THEN
   ALTER TABLE inventory_movements ALTER COLUMN created_by TYPE text USING created_by::text;
  END IF;
 END $$;
 CREATE UNIQUE INDEX IF NOT EXISTS inventory_movements_workorder_product_location_consumption_uq ON inventory_movements(work_order_id,product_id,location_id) WHERE movement_type='work_order_consumption' AND location_id IS NOT NULL;
 CREATE UNIQUE INDEX IF NOT EXISTS inventory_movements_workorder_product_global_consumption_uq ON inventory_movements(work_order_id,product_id) WHERE movement_type='work_order_consumption' AND location_id IS NULL;
 CREATE TABLE IF NOT EXISTS service_material_requirements(
  id bigserial PRIMARY KEY,service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  default_quantity numeric(14,3) NOT NULL DEFAULT 1,unit text NOT NULL DEFAULT 'db',required boolean NOT NULL DEFAULT true,active boolean NOT NULL DEFAULT true,
  note text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(service_id,product_id));
 CREATE TABLE IF NOT EXISTS salon_stock_requests(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),location_id uuid NOT NULL REFERENCES locations(id),product_id uuid NOT NULL REFERENCES products(id),
  requested_quantity numeric(14,3) NOT NULL CHECK(requested_quantity>0),approved_quantity numeric(14,3),supplied_quantity numeric(14,3) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'requested' CHECK(status IN('requested','approved','partially_supplied','supplied','cancelled')),
  source text NOT NULL DEFAULT 'manual',source_work_order_id uuid,note text,created_by text,approved_by text,
  created_at timestamptz NOT NULL DEFAULT now(),approved_at timestamptz,updated_at timestamptz NOT NULL DEFAULT now());
 ALTER TABLE salon_stock_requests ADD COLUMN IF NOT EXISTS purchase_order_id bigint;
 CREATE INDEX IF NOT EXISTS salon_stock_requests_status_idx ON salon_stock_requests(status,location_id,created_at);
 DO $$ BEGIN IF to_regclass('public.loyalty_checkout_settlements') IS NOT NULL THEN
  ALTER TABLE loyalty_checkout_settlements ADD COLUMN IF NOT EXISTS finalized_at timestamptz;
  ALTER TABLE loyalty_checkout_settlements ADD COLUMN IF NOT EXISTS finalization_payload jsonb;
 END IF; END $$;
 `);runtimeReady=true}

async function resolveAccount(c:any,wo:any,method:string,supplied:string){
 if(supplied){const q=await c.query(`SELECT * FROM financial_accounts WHERE id=$1::uuid AND active=true FOR UPDATE`,[supplied]);if(!q.rows[0])throw new Error(`A pénzügyi számla nem található: ${supplied}`);return q.rows[0]}
 const type=accountType(method);let q=await c.query(`SELECT * FROM financial_accounts WHERE active=true AND account_type=$1 AND (location_id IS NOT DISTINCT FROM $2::uuid OR location_id IS NULL) ORDER BY CASE WHEN location_id IS NOT DISTINCT FROM $2::uuid THEN 0 ELSE 1 END,created_at LIMIT 1 FOR UPDATE`,[type,wo.location_id||null]);if(q.rows[0])return q.rows[0];
 const name=accountName(method);await c.query(`INSERT INTO financial_accounts(location_id,name,account_type,currency,opening_balance,active,note) SELECT $1::uuid,$2,$3,'HUF',0,true,'Automatikusan létrehozva munkalap-véglegesítéshez' WHERE NOT EXISTS(SELECT 1 FROM financial_accounts WHERE location_id IS NOT DISTINCT FROM $1::uuid AND lower(name)=lower($2))`,[wo.location_id||null,name,type]);q=await c.query(`SELECT * FROM financial_accounts WHERE active=true AND location_id IS NOT DISTINCT FROM $1::uuid AND lower(name)=lower($2) ORDER BY created_at LIMIT 1 FOR UPDATE`,[wo.location_id||null,name]);if(!q.rows[0])throw new Error(`Nem hozható létre pénzügyi számla ehhez a fizetéshez: ${method}`);return q.rows[0];
}

async function consumeStock(c:any,workOrder:any,by:string){
 if(workOrder.stock_consumed_at)return{consumed:[],replenishment_requests:[],idempotent:true};
 const direct=(await c.query(`SELECT product_id,SUM(quantity)::numeric quantity FROM work_order_items WHERE work_order_id=$1 AND item_type='product' AND product_id IS NOT NULL GROUP BY product_id`,[workOrder.id])).rows;
 const material=(await c.query(`SELECT r.product_id,SUM(COALESCE(wi.quantity,1)*r.default_quantity)::numeric quantity
   FROM work_order_items wi JOIN service_material_requirements r ON r.service_id=wi.service_id AND r.active=true
   WHERE wi.work_order_id=$1 AND wi.item_type='service' AND wi.service_id IS NOT NULL GROUP BY r.product_id`,[workOrder.id])).rows;
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
  await c.query(`INSERT INTO inventory_movements(product_id,location_id,work_order_id,movement_type,quantity,balance_after,unit_cost,stock_value_after,note,created_by)
    VALUES($1,$2::uuid,$3,'work_order_consumption',$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,[productId,workOrder.location_id||null,workOrder.id,-qty,after,unitCost,stockValue,`Automatikus munkalap-fogyás · közvetlen termék: ${item.direct.toFixed(3)} · szolgáltatási anyagnorma: ${item.material.toFixed(3)}`,by]);
  consumed.push({product_id:productId,quantity:qty,direct_quantity:item.direct,service_material_quantity:item.material,balance_after:after,unit_cost:unitCost,stock_value_after:stockValue});
  const minQty=Number(balance?.min_quantity||0);
  if(workOrder.location_id&&minQty>0&&after<=minQty){
   const open=(await c.query(`SELECT id::text,status,requested_quantity::numeric FROM salon_stock_requests WHERE location_id=$1::uuid AND product_id=$2::uuid AND status IN('requested','approved','partially_supplied') ORDER BY created_at DESC LIMIT 1`,[workOrder.location_id,productId])).rows[0];
   if(open)replenishment.push({...open,product_id:productId,existing:true});
   else{
    const target=Math.max(minQty*2,minQty+qty),requested=Math.max(0.01,target-after);
    const created=(await c.query(`INSERT INTO salon_stock_requests(location_id,product_id,requested_quantity,status,source,source_work_order_id,note,created_by)
      VALUES($1::uuid,$2::uuid,$3,'requested','workorder_auto',$4::uuid,$5,$6) RETURNING id::text,status,requested_quantity::numeric`,[workOrder.location_id,productId,requested,workOrder.id,'Automatikus készletfeltöltési igény: munkalap-zárás után a készlet elérte vagy alulmúlta a minimumszintet.',by])).rows[0];
    replenishment.push({...created,product_id:productId,existing:false});
   }
  }
 }
 return{consumed,replenishment_requests:replenishment,idempotent:false};
}

async function ensureInvoiceDraft(c:any,wo:any,by:string){const old=(await c.query(`SELECT * FROM finance_invoices WHERE work_order_id=$1 AND direction='outgoing' LIMIT 1`,[wo.id])).rows[0];if(old)return old;const gross=money(wo.amount_due||wo.gross_total||0),vatRate=27,net=money(gross/(1+vatRate/100)),vat=money(gross-net);const invoiceNo=(await c.query(`SELECT next_internal_invoice_number() invoice_no`)).rows[0].invoice_no;return (await c.query(`INSERT INTO finance_invoices(location_id,direction,invoice_no,partner_name,issue_date,performance_date,due_date,currency,net_total,vat_total,gross_total,status,work_order_id,note,created_by,document_kind) VALUES($1,'outgoing',$2,$3,CURRENT_DATE,CURRENT_DATE,CURRENT_DATE,'HUF',$4,$5,$6,'draft',$7,$8,$9,'internal_draft') RETURNING *`,[wo.location_id||null,invoiceNo,wo.client_name||'Magánszemély',net,vat,gross,wo.id,`Automatikus belső számlatervezet a ${wo.work_order_number||wo.id} munkalaphoz. Hivatalos adóügyi számla kiállításához NAV-kompatibilis számlázási integráció szükséges.`,by])).rows[0];}

router.post('/workorders/:id/finalize',async(req:AuthRequest,res,next)=>{const c=await db.connect();try{await ensureRuntimeSchema(c);await c.query('BEGIN');const wo=(await c.query(`SELECT * FROM work_orders WHERE id=$1 FOR UPDATE`,[req.params.id])).rows[0];if(!wo){await c.query('ROLLBACK');return res.status(404).json({message:'A munkalap nem található.'})}if(wo.locked_at){await c.query('COMMIT');return res.json({idempotent:true,work_order:wo,message:'A munkalap már lezárt és archivált.'})}if(String(wo.status||'')!=='in_progress')throw new Error('A munkalap csak Folyamatban állapotból zárható véglegesen.');if(String(wo.payment_status||'')!=='paid'||!wo.financial_closed_at)throw new Error('A munkalap csak teljesen kifizetett és pénzügyileg lezárt állapotban véglegesíthető.');
 const hasSettlementTable=(await c.query(`SELECT to_regclass('public.loyalty_checkout_settlements') IS NOT NULL ok`)).rows[0]?.ok;const settlement=hasSettlementTable?(await c.query(`SELECT * FROM loyalty_checkout_settlements WHERE work_order_id=$1 FOR UPDATE`,[req.params.id])).rows[0]||null:null;const defaultAccount=String(req.body?.financial_account_id||'').trim();const mappings=req.body?.payment_accounts||{};const payments=(await c.query(`SELECT * FROM work_order_payments WHERE work_order_id=$1 ORDER BY paid_at,id`,[req.params.id])).rows;for(const p of payments){const method=String(p.payment_method||'').toLowerCase();if(!REGULAR_METHODS.has(method))continue;if(String(p.note||'').toLowerCase().includes('hűség wallet'))continue;if(p.financial_movement_id)continue;const preferred=String(mappings?.[method]||defaultAccount||'').trim();const account=await resolveAccount(c,wo,method,preferred);const movement=(await c.query(`INSERT INTO financial_movements(location_id,account_id,direction,amount,occurred_at,reference_type,reference_id,counterparty,note,created_by) VALUES($1,$2::uuid,'income',$3,COALESCE($4,now()),'work_order_payment',$5,$6,$7,$8) RETURNING id`,[wo.location_id||account.location_id,account.id,money(p.amount),p.paid_at||null,String(p.id),wo.client_name||null,`Munkalap ${wo.work_order_number||wo.id} · ${method}`,actor(req)])).rows[0];await c.query(`UPDATE work_order_payments SET financial_account_id=$2::uuid,financial_movement_id=$3::uuid WHERE id=$1`,[p.id,account.id,movement.id]);}
 const inventory=await consumeStock(c,wo,actor(req));const commissionBase=Math.max(0,money(Number(wo.amount_due||0)-Number(wo.tip_amount||0)));if(wo.employee_id&&commissionBase>0){await c.query(`INSERT INTO work_order_commission_events(work_order_id,employee_id,base_amount,tip_amount,source_type,status,note,created_by) VALUES($1,$2,$3,$4,'work_order_finalization','open',$5,$6) ON CONFLICT(work_order_id,employee_id,source_type) DO UPDATE SET base_amount=EXCLUDED.base_amount,tip_amount=EXCLUDED.tip_amount,note=EXCLUDED.note`,[wo.id,wo.employee_id,commissionBase,money(wo.tip_amount),`Jutalékalap a(z) ${wo.work_order_number||wo.id} végleges lezárásából`,actor(req)])}
 if(wo.appointment_id){await c.query(`UPDATE appointments SET status='completed',work_order_id=COALESCE(work_order_id,$2::uuid),work_order_number=COALESCE(work_order_number,$3) WHERE id=$1::uuid`,[wo.appointment_id,wo.id,wo.work_order_number||null]);}
 const previousDocumentStatus=String(wo.document_status||'open');
 const updated=(await c.query(`UPDATE work_orders SET stock_consumed_at=COALESCE(stock_consumed_at,now()),status='completed',document_status='completed',completed_at=COALESCE(completed_at,now()),closed_at=COALESCE(closed_at,now()),closed_by=COALESCE(closed_by,$2),status_updated_at=now(),updated_at=now() WHERE id=$1 RETURNING *`,[wo.id,actor(req)])).rows[0];
 const hasHistory=(await c.query(`SELECT to_regclass('public.work_order_status_history') IS NOT NULL ok`)).rows[0]?.ok;if(hasHistory){await c.query(`INSERT INTO work_order_status_history(work_order_id,status_kind,from_status,to_status,changed_by,reason,note,metadata) VALUES($1,'document',$2,'completed',$3,'FINALIZATION',$4,$5::jsonb)`,[wo.id,previousDocumentStatus,actor(req),'Végleges lezárás: fizetés, készlet, pénzügy, jutalék és archiválás lezárva.',JSON.stringify({service_status_from:wo.status,service_status_to:'completed',inventory_consumed:inventory.consumed.length,replenishment_requests:inventory.replenishment_requests.length})])}
 const invoice=await ensureInvoiceDraft(c,{...wo,...updated},actor(req));if(settlement)await c.query(`UPDATE loyalty_checkout_settlements SET finalized_at=COALESCE(finalized_at,now()),finalization_payload=$2::jsonb WHERE work_order_id=$1`,[wo.id,JSON.stringify({financial_account_id:defaultAccount||null,payment_accounts:mappings,finalized_by:actor(req),invoice_id:invoice.id,invoice_no:invoice.invoice_no,inventory})]);await c.query('COMMIT');const archive=(await db.query(`SELECT work_order_number,archived_at,terminal_status,snapshot_hash FROM work_order_archive WHERE work_order_id=$1`,[wo.id])).rows[0]||null;res.json({work_order:updated,archive,invoice,inventory,finalized:true,appointment_completed:Boolean(wo.appointment_id),loyalty_settlement:Boolean(settlement)});
 }catch(e:any){await c.query('ROLLBACK').catch(()=>undefined);const m=String(e?.message||'A munkalap végleges lezárása nem sikerült.');if(/Folyamatban|pénztári|kifizetett|pénzügyi|készlet|anyag|számla|fizetéshez/i.test(m))return res.status(409).json({message:m});next(e)}finally{c.release()}});
export default router;
