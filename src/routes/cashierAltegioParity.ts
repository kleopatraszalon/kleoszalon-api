import {Router} from 'express';
import db from '../db';
import type {AuthRequest} from '../middleware/auth';

const router=Router();
const money=(v:any)=>{const n=Number(v??0);return Number.isFinite(n)?Math.round(n*100)/100:0};
const actor=(req:AuthRequest)=>req.user?.email||String(req.user?.id||'');
const locationFrom=(req:AuthRequest)=>String(req.query.location_id??req.body?.location_id??req.user?.location_id??'').trim();
const DENOMINATIONS=[20000,10000,5000,2000,1000,500,200,100,50,20,10,5];
function denominationCount(raw:any){const denominations:Record<string,number>={};let total=0;for(const value of DENOMINATIONS){const qty=Math.max(0,Math.floor(Number(raw?.[String(value)]||0)));denominations[String(value)]=qty;total+=value*qty}return{denominations,total:money(total)}}

async function ensureSchema(){
 await db.query(`
  CREATE TABLE IF NOT EXISTS finance_payment_methods(
    id bigserial PRIMARY KEY,location_id text,code text NOT NULL,name text NOT NULL,method_type text NOT NULL DEFAULT 'custom',
    account_id uuid,fee_percent numeric(9,4) NOT NULL DEFAULT 0,fee_fixed numeric(14,2) NOT NULL DEFAULT 0,
    processing_days integer NOT NULL DEFAULT 0,brand_fees jsonb NOT NULL DEFAULT '{}'::jsonb,allow_installments boolean NOT NULL DEFAULT false,
    active boolean NOT NULL DEFAULT true,sort_order integer NOT NULL DEFAULT 100,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS uq_finance_payment_methods_scope ON finance_payment_methods(COALESCE(location_id,''),code);

  CREATE TABLE IF NOT EXISTS finance_partners(
    id bigserial PRIMARY KEY,location_id text,partner_type text NOT NULL DEFAULT 'company',name text NOT NULL,
    tax_number text,email text,phone text,address text,contact_name text,note text,supplier_id text,
    active boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS finance_document_types(
    id bigserial PRIMARY KEY,location_id text,code text NOT NULL,name text NOT NULL,direction text NOT NULL DEFAULT 'both',
    group_key text NOT NULL DEFAULT 'other',system boolean NOT NULL DEFAULT false,active boolean NOT NULL DEFAULT true,
    sort_order integer NOT NULL DEFAULT 100,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
  );

  ALTER TABLE work_order_payments ADD COLUMN IF NOT EXISTS payment_method_code text;
  ALTER TABLE work_order_payments ADD COLUMN IF NOT EXISTS finance_account_id uuid;
  ALTER TABLE work_order_payments ADD COLUMN IF NOT EXISTS cashier_shift_id bigint;
  ALTER TABLE work_order_payments ADD COLUMN IF NOT EXISTS refunded_amount numeric(14,2) NOT NULL DEFAULT 0;
  ALTER TABLE work_order_payments ADD COLUMN IF NOT EXISTS card_brand text;
  ALTER TABLE work_order_payments ADD COLUMN IF NOT EXISTS fee_amount numeric(14,2) NOT NULL DEFAULT 0;

  ALTER TABLE cash_register_movements ADD COLUMN IF NOT EXISTS transaction_type_code text;
  ALTER TABLE cash_register_movements ADD COLUMN IF NOT EXISTS reference_no text;
  ALTER TABLE cash_register_movements ADD COLUMN IF NOT EXISTS partner_id bigint;
  ALTER TABLE cash_register_movements ADD COLUMN IF NOT EXISTS employee_id text;
  ALTER TABLE cash_register_movements ADD COLUMN IF NOT EXISTS finance_account_id uuid;
  ALTER TABLE cash_register_movements ADD COLUMN IF NOT EXISTS cashier_shift_id bigint;

  CREATE TABLE IF NOT EXISTS cashier_shift_counts(
    id bigserial PRIMARY KEY,shift_id bigint NOT NULL,location_id text NOT NULL,business_date date NOT NULL,
    count_type varchar(20) NOT NULL CHECK(count_type IN('opening','check','handover','accept','closing')),
    handover_id bigint,denominations jsonb NOT NULL DEFAULT '{}'::jsonb,counted_cash numeric(14,2) NOT NULL DEFAULT 0,
    expected_cash numeric(14,2) NOT NULL DEFAULT 0,difference numeric(14,2) NOT NULL DEFAULT 0,note text,
    created_by text,created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS cashier_shift_counts_shift_idx ON cashier_shift_counts(shift_id,created_at DESC);
  CREATE INDEX IF NOT EXISTS cashier_shift_counts_location_date_idx ON cashier_shift_counts(location_id,business_date DESC,created_at DESC);

  CREATE TABLE IF NOT EXISTS cashier_payment_context(
    id bigserial PRIMARY KEY,work_order_id text NOT NULL,sequence_no integer NOT NULL DEFAULT 0,base_method text NOT NULL,
    amount numeric(14,2) NOT NULL,payment_method_code text,finance_account_id uuid,cashier_shift_id bigint,card_brand text,
    fee_amount numeric(14,2) NOT NULL DEFAULT 0,expires_at timestamptz NOT NULL DEFAULT(now()+interval '5 minutes'),
    consumed_at timestamptz,created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS cashier_payment_context_lookup_idx ON cashier_payment_context(work_order_id,consumed_at,expires_at,sequence_no);

  CREATE TABLE IF NOT EXISTS work_order_payment_refunds(
    id bigserial PRIMARY KEY,payment_id uuid NOT NULL REFERENCES work_order_payments(id),work_order_id text NOT NULL,
    location_id text,finance_account_id uuid,cashier_shift_id bigint,amount numeric(14,2) NOT NULL CHECK(amount>0),
    reason text NOT NULL,refund_method text NOT NULL,created_by text,created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS work_order_payment_refunds_payment_idx ON work_order_payment_refunds(payment_id,created_at DESC);

  CREATE OR REPLACE FUNCTION cashier_enrich_work_order_payment()
  RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE v_location text;v_shift bigint;v_ctx cashier_payment_context%ROWTYPE;
  BEGIN
    SELECT location_id::text INTO v_location FROM work_orders WHERE id=NEW.work_order_id;
    SELECT id INTO v_shift FROM cash_register_shifts WHERE location_id=v_location AND status='open' ORDER BY opened_at DESC LIMIT 1;
    IF NEW.payment_method='cash' AND v_shift IS NULL THEN
      RAISE EXCEPTION 'Készpénzes fizetés előtt nyissa meg a pénztári műszakot.' USING ERRCODE='P0001';
    END IF;
    NEW.cashier_shift_id:=COALESCE(NEW.cashier_shift_id,v_shift);
    SELECT * INTO v_ctx FROM cashier_payment_context
      WHERE work_order_id=NEW.work_order_id::text AND consumed_at IS NULL AND expires_at>now()
        AND base_method=NEW.payment_method AND abs(amount-NEW.amount)<0.01
      ORDER BY sequence_no,id LIMIT 1 FOR UPDATE SKIP LOCKED;
    IF v_ctx.id IS NOT NULL THEN
      NEW.payment_method_code:=COALESCE(NEW.payment_method_code,v_ctx.payment_method_code,NEW.payment_method);
      NEW.finance_account_id:=COALESCE(NEW.finance_account_id,v_ctx.finance_account_id);
      NEW.cashier_shift_id:=COALESCE(NEW.cashier_shift_id,v_ctx.cashier_shift_id);
      NEW.card_brand:=COALESCE(NEW.card_brand,v_ctx.card_brand);
      NEW.fee_amount:=COALESCE(NULLIF(NEW.fee_amount,0),v_ctx.fee_amount,0);
      UPDATE cashier_payment_context SET consumed_at=now() WHERE id=v_ctx.id;
    ELSE
      NEW.payment_method_code:=COALESCE(NEW.payment_method_code,NEW.payment_method);
    END IF;
    RETURN NEW;
  END $$;
  DROP TRIGGER IF EXISTS trg_cashier_enrich_work_order_payment ON work_order_payments;
  CREATE TRIGGER trg_cashier_enrich_work_order_payment BEFORE INSERT ON work_order_payments
    FOR EACH ROW EXECUTE FUNCTION cashier_enrich_work_order_payment();
 `);
 const methods=[['cash','Készpénz','cash'],['card','Bankkártya','card'],['transfer','Átutalás','bank_transfer'],['voucher','Utalvány','voucher'],['online','Online bankkártya','online_card']];
 for(const m of methods)await db.query(`INSERT INTO finance_payment_methods(location_id,code,name,method_type) VALUES(NULL,$1,$2,$3) ON CONFLICT DO NOTHING`,m);
}

router.use(async(_req,_res,next)=>{try{await ensureSchema();next()}catch(error){next(error)}});

async function currentShift(locationId:string){return (await db.query(`SELECT * FROM cash_register_shifts WHERE location_id=$1 AND status='open' ORDER BY opened_at DESC LIMIT 1`,[locationId])).rows[0]||null}
async function shiftExpected(shift:any){
 const payments=await db.query(`SELECT COALESCE(SUM(wp.amount-COALESCE(wp.refunded_amount,0)) FILTER(WHERE wp.payment_method='cash'),0)::numeric cash_sales FROM work_order_payments wp JOIN work_orders wo ON wo.id=wp.work_order_id WHERE wo.location_id::text=$1 AND wp.paid_at>=COALESCE($2::timestamptz,date_trunc('day',now())) AND ($3::timestamptz IS NULL OR wp.paid_at<=$3::timestamptz)`,[String(shift.location_id),shift.opened_at,shift.closed_at||null]);
 const movements=await db.query(`SELECT COALESCE(SUM(amount) FILTER(WHERE direction='in' AND voided_at IS NULL),0)::numeric cash_in,COALESCE(SUM(amount) FILTER(WHERE direction='out' AND voided_at IS NULL),0)::numeric cash_out FROM cash_register_movements WHERE location_id=$1 AND created_at>=COALESCE($2::timestamptz,date_trunc('day',now())) AND ($3::timestamptz IS NULL OR created_at<=$3::timestamptz)`,[String(shift.location_id),shift.opened_at,shift.closed_at||null]);
 const cashSales=money(payments.rows[0]?.cash_sales),cashIn=money(movements.rows[0]?.cash_in),cashOut=money(movements.rows[0]?.cash_out);
 return{cash_sales:cashSales,cash_in:cashIn,cash_out:cashOut,expected_cash:money(Number(shift.opening_cash||0)+cashSales+cashIn-cashOut)};
}

router.get('/altegio/payment-methods',async(req:AuthRequest,res,next)=>{try{const loc=locationFrom(req);const {rows}=await db.query(`SELECT pm.*,a.name account_name,a.account_type,a.allow_cash,a.allow_cashless FROM finance_payment_methods pm LEFT JOIN financial_accounts a ON a.id=pm.account_id WHERE pm.active=true AND ($1='' OR pm.location_id=$1 OR pm.location_id IS NULL) ORDER BY pm.sort_order,pm.name`,[loc]);res.json(rows)}catch(e){next(e)}});
router.get('/altegio/accounts',async(req:AuthRequest,res,next)=>{try{const loc=locationFrom(req);const {rows}=await db.query(`SELECT a.*,a.opening_balance+COALESCE(SUM(CASE WHEN m.cancelled_at IS NULL AND m.direction='income' THEN m.amount WHEN m.cancelled_at IS NULL THEN -m.amount ELSE 0 END),0)::numeric current_balance FROM financial_accounts a LEFT JOIN financial_movements m ON m.account_id=a.id WHERE a.active=true AND ($1='' OR a.location_id::text=$1 OR a.location_id IS NULL) GROUP BY a.id ORDER BY a.sort_order,a.name`,[loc]);res.json(rows)}catch(e){next(e)}});
router.get('/altegio/document-types',async(req:AuthRequest,res,next)=>{try{const loc=locationFrom(req);res.json((await db.query(`SELECT * FROM finance_document_types WHERE active=true AND ($1='' OR location_id=$1 OR location_id IS NULL) ORDER BY sort_order,name`,[loc])).rows)}catch(e){next(e)}});
router.get('/altegio/partners',async(req:AuthRequest,res,next)=>{try{const loc=locationFrom(req),q=String(req.query.q||'').trim();res.json((await db.query(`SELECT * FROM finance_partners WHERE active=true AND ($1='' OR location_id=$1 OR location_id IS NULL) AND ($2='' OR name ILIKE '%'||$2||'%') ORDER BY name LIMIT 250`,[loc,q])).rows)}catch(e){next(e)}});

router.post('/workorders/:id/settle',async(req:AuthRequest,res,next)=>{const client=await db.connect();try{
 const payments=Array.isArray(req.body?.payments)?req.body.payments:[];if(!payments.length)return next();
 const order=(await client.query(`SELECT location_id FROM work_orders WHERE id::text=$1`,[req.params.id])).rows[0];if(!order)return next();const locationId=String(order.location_id),shift=await currentShift(locationId);if(!shift)return res.status(409).json({message:'A fizetéshez nyitott pénztári műszak szükséges.'});
 await client.query('BEGIN');await client.query(`DELETE FROM cashier_payment_context WHERE work_order_id=$1 AND (consumed_at IS NOT NULL OR expires_at<=now())`,[req.params.id]);
 for(let i=0;i<payments.length;i++){
  const p=payments[i],code=String(p?.payment_method_code||p?.payment_method||'').trim().toLowerCase();
  const builtin:Record<string,string>={cash:'cash',card:'card',transfer:'transfer',voucher:'voucher',other:'other'};
  let config:any=null,base=builtin[code]||'';
  if(!base){config=(await client.query(`SELECT * FROM finance_payment_methods WHERE lower(code)=lower($1) AND active=true AND (location_id=$2 OR location_id IS NULL) ORDER BY location_id NULLS LAST LIMIT 1`,[code,locationId])).rows[0];if(!config){await client.query('ROLLBACK');return res.status(400).json({message:`Ismeretlen fizetési mód: ${code}`})}const t=String(config.method_type||'custom');base=t==='cash'?'cash':t==='card'||t==='online_card'?'card':t==='bank_transfer'?'transfer':t==='voucher'?'voucher':'other'}
  if(!config)config=(await client.query(`SELECT * FROM finance_payment_methods WHERE lower(code)=lower($1) AND active=true AND (location_id=$2 OR location_id IS NULL) ORDER BY location_id NULLS LAST LIMIT 1`,[code,locationId])).rows[0]||null;
  const amount=money(p?.amount);if(!(amount>0)){await client.query('ROLLBACK');return res.status(400).json({message:'A fizetési összeg legyen pozitív.'})}
  const brand=String(p?.card_brand||''),brandRate=brand&&config?.brand_fees?.[brand]!=null?Number(config.brand_fees[brand]):Number(config?.fee_percent||0),fee=money(amount*brandRate/100+Number(config?.fee_fixed||0));
  p.payment_method=base;p.payment_method_code=code;p.finance_account_id=p.finance_account_id||config?.account_id||null;p.cashier_shift_id=shift.id;p.fee_amount=fee;
  await client.query(`INSERT INTO cashier_payment_context(work_order_id,sequence_no,base_method,amount,payment_method_code,finance_account_id,cashier_shift_id,card_brand,fee_amount) VALUES($1,$2,$3,$4,$5,$6::uuid,$7,$8,$9)`,[req.params.id,i,base,amount,code,p.finance_account_id||null,shift.id,brand||null,fee]);
 }
 await client.query('COMMIT');next();
}catch(e){await client.query('ROLLBACK').catch(()=>undefined);next(e)}finally{client.release()}});

router.get('/workorders/:id/payments',async(req,res,next)=>{try{res.json((await db.query(`SELECT wp.*,a.name account_name,COALESCE((SELECT json_agg(r ORDER BY r.created_at) FROM work_order_payment_refunds r WHERE r.payment_id=wp.id),'[]'::json)::json refunds FROM work_order_payments wp LEFT JOIN financial_accounts a ON a.id=wp.finance_account_id WHERE wp.work_order_id::text=$1 ORDER BY wp.paid_at,wp.id`,[req.params.id])).rows)}catch(e){next(e)}});

router.post('/payments/:id/refund',async(req:AuthRequest,res,next)=>{const client=await db.connect();try{
 const reason=String(req.body?.reason||'').trim(),requested=money(req.body?.amount);if(reason.length<3)return res.status(400).json({message:'A visszatérítés indoka kötelező.'});await client.query('BEGIN');
 const payment=(await client.query(`SELECT wp.*,wo.location_id,wo.gross_total,wo.discount_amount,wo.tip_amount FROM work_order_payments wp JOIN work_orders wo ON wo.id=wp.work_order_id WHERE wp.id=$1::uuid FOR UPDATE`,[req.params.id])).rows[0];if(!payment){await client.query('ROLLBACK');return res.status(404).json({message:'A fizetés nem található.'})}
 const available=money(Number(payment.amount)-Number(payment.refunded_amount||0)),amount=requested>0?Math.min(requested,available):available;if(!(amount>0)){await client.query('ROLLBACK');return res.status(409).json({message:'A fizetés már teljes egészében visszatérített.'})}
 let shift:any=null;if(payment.payment_method==='cash'){shift=(await client.query(`SELECT * FROM cash_register_shifts WHERE location_id=$1 AND status='open' ORDER BY opened_at DESC LIMIT 1`,[String(payment.location_id)])).rows[0];if(!shift){await client.query('ROLLBACK');return res.status(409).json({message:'Készpénzes visszatérítéshez nyitott pénztári műszak szükséges.'})}}
 const accountId=String(req.body?.finance_account_id||payment.finance_account_id||'').trim()||null;
 const refund=(await client.query(`INSERT INTO work_order_payment_refunds(payment_id,work_order_id,location_id,finance_account_id,cashier_shift_id,amount,reason,refund_method,created_by) VALUES($1::uuid,$2,$3,$4::uuid,$5,$6,$7,$8,$9) RETURNING *`,[payment.id,String(payment.work_order_id),String(payment.location_id),accountId,shift?.id||payment.cashier_shift_id||null,amount,reason,String(payment.payment_method_code||payment.payment_method),actor(req)])).rows[0];
 await client.query(`UPDATE work_order_payments SET refunded_amount=refunded_amount+$2 WHERE id=$1::uuid`,[payment.id,amount]);
 if(payment.payment_method==='cash')await client.query(`INSERT INTO cash_register_movements(location_id,business_date,direction,amount,reason_code,note,created_by,transaction_type_code,reference_no,finance_account_id,cashier_shift_id) VALUES($1,CURRENT_DATE,'out',$2,'refund',$3,$4,'refund',$5,$6::uuid,$7)`,[String(payment.location_id),amount,reason,actor(req),String(payment.id),accountId,shift.id]);
 if(accountId){await client.query(`INSERT INTO financial_movements(location_id,account_id,direction,amount,occurred_at,reference_type,reference_id,note,created_by,payment_method_code,document_type_code) VALUES($1,$2::uuid,'expense',$3,now(),'cashier_refund',$4,$5,$6,$7,'refund')`,[payment.location_id,accountId,amount,String(payment.work_order_id),reason,actor(req),String(payment.payment_method_code||payment.payment_method)]).catch(()=>undefined)}
 const paid=money((await client.query(`SELECT COALESCE(SUM(amount-refunded_amount),0)::numeric paid FROM work_order_payments WHERE work_order_id=$1`,[payment.work_order_id])).rows[0]?.paid),due=Math.max(0,money(Number(payment.gross_total||0)-Number(payment.discount_amount||0)+Number(payment.tip_amount||0))),refundCount=Number((await client.query(`SELECT count(*) n FROM work_order_payment_refunds WHERE work_order_id=$1`,[String(payment.work_order_id)])).rows[0]?.n||0),status=paid<=0&&refundCount>0?'refunded':paid<=0?'unpaid':paid+.009<due?'partial':'paid';
 await client.query(`UPDATE work_orders SET amount_paid=$2,payment_status=$3,fully_paid=($3='paid'),updated_at=now() WHERE id=$1`,[payment.work_order_id,paid,status]);await client.query('COMMIT');res.status(201).json({refund,amount_paid:paid,payment_status:status});
}catch(e){await client.query('ROLLBACK').catch(()=>undefined);next(e)}finally{client.release()}});

router.post('/shift/:id/count',async(req:AuthRequest,res,next)=>{try{
 const locationId=locationFrom(req),countType=String(req.body?.count_type||'check');if(!['opening','check','handover','accept','closing'].includes(countType))return res.status(400).json({message:'Érvénytelen pénztárszámolás típus.'});
 const shift=(await db.query(`SELECT * FROM cash_register_shifts WHERE id=$1 AND location_id=$2`,[req.params.id,locationId])).rows[0];if(!shift)return res.status(404).json({message:'A pénztári műszak nem található.'});const totals=await shiftExpected(shift),denom=denominationCount(req.body?.denominations),counted=req.body?.counted_cash==null?denom.total:Math.max(0,money(req.body.counted_cash)),difference=money(counted-totals.expected_cash);
 const row=(await db.query(`INSERT INTO cashier_shift_counts(shift_id,location_id,business_date,count_type,handover_id,denominations,counted_cash,expected_cash,difference,note,created_by) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11) RETURNING *`,[shift.id,locationId,shift.business_date,countType,req.body?.handover_id||null,JSON.stringify(denom.denominations),counted,totals.expected_cash,difference,req.body?.note||null,actor(req)])).rows[0];res.status(201).json({...row,...totals});
}catch(e){next(e)}});
router.get('/shift/:id/counts',async(req:AuthRequest,res,next)=>{try{const loc=locationFrom(req);res.json((await db.query(`SELECT * FROM cashier_shift_counts WHERE shift_id=$1 AND ($2='' OR location_id=$2) ORDER BY created_at DESC,id DESC`,[req.params.id,loc])).rows)}catch(e){next(e)}});
router.get('/shift/previous-count',async(req:AuthRequest,res,next)=>{try{const loc=locationFrom(req),date=String(req.query.date||new Date().toISOString().slice(0,10));res.json((await db.query(`SELECT * FROM cashier_shift_counts WHERE location_id=$1 AND business_date<$2::date AND count_type='closing' ORDER BY business_date DESC,created_at DESC LIMIT 1`,[loc,date])).rows[0]||null)}catch(e){next(e)}});

router.post('/manual-operation',async(req:AuthRequest,res,next)=>{const client=await db.connect();try{
 const locationId=locationFrom(req),accountId=String(req.body?.account_id||'').trim(),direction=String(req.body?.direction||''),amount=money(req.body?.amount),documentType=String(req.body?.document_type_code||'').trim()||'other';if(!locationId||!accountId||!['income','expense'].includes(direction)||!(amount>0))return res.status(400).json({message:'Telephely, pénzügyi számla, irány és pozitív összeg szükséges.'});await client.query('BEGIN');
 const account=(await client.query(`SELECT * FROM financial_accounts WHERE id=$1::uuid AND active=true`,[accountId])).rows[0];if(!account){await client.query('ROLLBACK');return res.status(404).json({message:'A pénzügyi számla nem található.'})}const shift=await currentShift(locationId);if(account.account_type==='cash'&&!shift){await client.query('ROLLBACK');return res.status(409).json({message:'Készpénzes manuális művelethez nyitott pénztári műszak szükséges.'})}
 const movement=(await client.query(`INSERT INTO financial_movements(location_id,account_id,direction,amount,occurred_at,reference_type,reference_id,counterparty,note,created_by,partner_id,payment_method_code,document_type_code,employee_id) VALUES($1,$2::uuid,$3,$4,COALESCE($5::timestamptz,now()),'cashier_manual',$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,[account.location_id||locationId,accountId,direction,amount,req.body?.occurred_at||null,req.body?.reference_no||null,req.body?.counterparty||null,req.body?.note||null,actor(req),req.body?.partner_id||null,req.body?.payment_method_code||null,documentType,req.body?.employee_id||null])).rows[0];
 if(account.account_type==='cash')await client.query(`INSERT INTO cash_register_movements(location_id,business_date,direction,amount,reason_code,note,created_by,transaction_type_code,reference_no,partner_id,employee_id,finance_account_id,cashier_shift_id) VALUES($1,CURRENT_DATE,$2,$3,$4,$5,$6,$4,$7,$8,$9,$10::uuid,$11)`,[locationId,direction==='income'?'in':'out',amount,documentType,req.body?.note||null,actor(req),req.body?.reference_no||null,req.body?.partner_id||null,req.body?.employee_id||null,accountId,shift.id]);
 await client.query('COMMIT');res.status(201).json(movement);
}catch(e){await client.query('ROLLBACK').catch(()=>undefined);next(e)}finally{client.release()}});

router.post('/account-transfer',async(req:AuthRequest,res,next)=>{const client=await db.connect();try{
 const locationId=locationFrom(req),source=String(req.body?.source_account_id||'').trim(),destination=String(req.body?.destination_account_id||'').trim(),amount=money(req.body?.amount);if(!locationId||!source||!destination||source===destination||!(amount>0))return res.status(400).json({message:'Két külön pénzügyi számla és pozitív összeg szükséges.'});await client.query('BEGIN');const accounts=(await client.query(`SELECT * FROM financial_accounts WHERE id=ANY($1::uuid[]) AND active=true`,[[source,destination]])).rows;if(accounts.length!==2){await client.query('ROLLBACK');return res.status(404).json({message:'Az egyik pénzügyi számla nem található.'})}const sourceAccount=accounts.find((a:any)=>String(a.id)===source),destAccount=accounts.find((a:any)=>String(a.id)===destination),shift=await currentShift(locationId);if((sourceAccount.account_type==='cash'||destAccount.account_type==='cash')&&!shift){await client.query('ROLLBACK');return res.status(409).json({message:'Készpénzt érintő átvezetéshez nyitott pénztári műszak szükséges.'})}
 const out=(await client.query(`INSERT INTO financial_movements(location_id,account_id,direction,amount,occurred_at,reference_type,reference_id,note,created_by,document_type_code) VALUES($1,$2::uuid,'expense',$3,now(),'transfer',$4,$5,$6,'transfer') RETURNING id`,[sourceAccount.location_id||locationId,source,amount,req.body?.reference_no||null,req.body?.note||null,actor(req)])).rows[0];const inc=(await client.query(`INSERT INTO financial_movements(location_id,account_id,direction,amount,occurred_at,reference_type,reference_id,note,created_by,document_type_code) VALUES($1,$2::uuid,'income',$3,now(),'transfer',$4,$5,$6,'transfer') RETURNING id`,[destAccount.location_id||locationId,destination,amount,req.body?.reference_no||null,req.body?.note||null,actor(req)])).rows[0];
 if(shift&&sourceAccount.account_type==='cash')await client.query(`INSERT INTO cash_register_movements(location_id,business_date,direction,amount,reason_code,note,created_by,transaction_type_code,reference_no,finance_account_id,cashier_shift_id) VALUES($1,CURRENT_DATE,'out',$2,'transfer',$3,$4,'transfer',$5,$6::uuid,$7)`,[locationId,amount,req.body?.note||'Pénztárközi átvezetés',actor(req),req.body?.reference_no||null,source,shift.id]);if(shift&&destAccount.account_type==='cash')await client.query(`INSERT INTO cash_register_movements(location_id,business_date,direction,amount,reason_code,note,created_by,transaction_type_code,reference_no,finance_account_id,cashier_shift_id) VALUES($1,CURRENT_DATE,'in',$2,'transfer',$3,$4,'transfer',$5,$6::uuid,$7)`,[locationId,amount,req.body?.note||'Pénztárközi átvezetés',actor(req),req.body?.reference_no||null,destination,shift.id]);
 await client.query('COMMIT');res.status(201).json({source_movement_id:out.id,destination_movement_id:inc.id,amount});
}catch(e){await client.query('ROLLBACK').catch(()=>undefined);next(e)}finally{client.release()}});

export default router;
