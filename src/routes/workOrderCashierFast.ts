import {Router} from 'express';
import db from '../db';
import {requireAuth,AuthRequest} from '../middleware/auth';
import {ensureLoyaltyProgram,loyaltyDiscountForWorkOrder} from '../loyalty/loyaltyProgramService';
import {requireIdempotencyKey} from '../finance/financialIntegrity';
import {recordProtectedWorkOrderPayment} from '../finance/workOrderPaymentIntegrity';
import {recordFranchiseRevenueIfApplicable} from '../franchise/franchiseRevenueLedger';

const router=Router();
router.use(requireAuth);

const PAYMENT_METHODS=new Set(['cash','card','transfer','voucher','other']);
const money=(v:any)=>{const n=Number(v??0);return Number.isFinite(n)?Math.round(n*100)/100:0};
const actor=(req:AuthRequest)=>req.user?.email||String(req.user?.id||'');

async function tableExists(name:string){const q=await db.query(`SELECT to_regclass($1) IS NOT NULL ok`,[`public.${name}`]);return Boolean(q.rows[0]?.ok)}
async function columnTypes(table:string){const q=await db.query(`SELECT column_name,data_type FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,[table]);return new Map<string,string>(q.rows.map((r:any)=>[String(r.column_name),String(r.data_type)]))}
const textLike=(t:string|undefined)=>['text','character varying','character'].includes(String(t||''));
function hasActualLoyalty(body:any){return Boolean(Number(body?.wallet_amount||0)>0||Number(body?.points_to_spend||0)>0||String(body?.coupon_code||'').trim()||String(body?.voucher_code||'').trim()||Number(body?.voucher_amount||0)>0||(Array.isArray(body?.pass_usages)&&body.pass_usages.length))}

async function ensureRetailSchema(){
  await db.query(`
    CREATE TABLE IF NOT EXISTS retail_sales(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      location_id text NOT NULL,
      client_id text,
      customer_name text,
      customer_email text,
      customer_phone text,
      payment_method text NOT NULL,
      gross_total numeric(14,2) NOT NULL DEFAULT 0,
      invoice_requested boolean NOT NULL DEFAULT false,
      finance_invoice_id uuid,
      status text NOT NULL DEFAULT 'paid',
      created_by text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS retail_sale_items(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      sale_id uuid NOT NULL REFERENCES retail_sales(id) ON DELETE CASCADE,
      product_id text NOT NULL,
      product_name text NOT NULL,
      quantity numeric(14,3) NOT NULL,
      unit_price_gross numeric(14,2) NOT NULL,
      gross_amount numeric(14,2) NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS retail_sales_location_created_idx ON retail_sales(location_id,created_at DESC);
  `);
}

router.get('/retail/products',async(req:AuthRequest,res)=>{
 try{
  const locationId=String(req.query.location_id||'').trim();
  const q=String(req.query.q||'').trim().slice(0,120);
  const groupId=String(req.query.group_id||'').trim();
  const [productCols,hasBalances,hasGroups,hasCategories]=await Promise.all([
    columnTypes('products'),tableExists('product_stock_balances'),tableExists('product_groups'),tableExists('product_categories')
  ]);
  const balanceCols=hasBalances?await columnTypes('product_stock_balances'):new Map<string,string>();
  const stockCapable=hasBalances&&balanceCols.has('product_id')&&balanceCols.has('quantity');
  const locationCapable=stockCapable&&balanceCols.has('location_id');
  const stockJoin=stockCapable?`LEFT JOIN (
    SELECT product_id::text product_id,SUM(COALESCE(quantity,0))::numeric available_stock
    FROM product_stock_balances
    WHERE ($1::text='' OR ${locationCapable?'location_id::text=$1':'TRUE'})
    GROUP BY product_id::text
  ) b ON b.product_id=p.id::text`:'';
  const groupJoin=hasGroups&&productCols.has('product_group_id')?`LEFT JOIN product_groups g ON g.id::text=p.product_group_id::text`:'';
  const categoryJoin=hasCategories&&productCols.has('product_category_id')?`LEFT JOIN product_categories c ON c.id::text=p.product_category_id::text`:'';
  const groupSelect=groupJoin?`,p.product_group_id::text group_id,COALESCE(g.name,'Nincs csoport') group_name`:` ,NULL::text group_id,'Nincs csoport'::text group_name`;
  const categorySelect=categoryJoin?`,p.product_category_id::text category_id,COALESCE(c.name,'Nincs kategória') category_name`:` ,NULL::text category_id,'Nincs kategória'::text group_name`;
  const stockSelect=stockCapable?`COALESCE(b.available_stock,0)::numeric`:`0::numeric`;
  const filters=[`COALESCE(NULLIF(to_jsonb(p)->>'is_active','')::boolean,true)=true`];
  const params:any[]=[locationId];
  if(q){params.push(`%${q}%`);const p=`$${params.length}`;filters.push(`(COALESCE(p.name,'') ILIKE ${p} OR COALESCE(to_jsonb(p)->>'barcode','') ILIKE ${p} OR COALESCE(to_jsonb(p)->>'internal_code','') ILIKE ${p}${groupJoin?` OR COALESCE(g.name,'') ILIKE ${p}`:''}${categoryJoin?` OR COALESCE(c.name,'') ILIKE ${p}`:''})`)}
  if(groupId&&productCols.has('product_group_id')){params.push(groupId);filters.push(`p.product_group_id::text=$${params.length}`)}
  const products=(await db.query(`SELECT p.id::text id,p.name,
    COALESCE(NULLIF(to_jsonb(p)->>'retail_price_gross','')::numeric,NULLIF(to_jsonb(p)->>'sale_price','')::numeric,NULLIF(to_jsonb(p)->>'price','')::numeric,0)::numeric price,
    ${stockSelect} available_stock,
    COALESCE(NULLIF(to_jsonb(p)->>'vat_rate','')::numeric,0.27)::numeric vat_rate
    ${groupSelect}${categorySelect}
    FROM products p
    ${groupJoin}
    ${categoryJoin}
    ${stockJoin}
    WHERE ${filters.join(' AND ')}
    ORDER BY group_name,category_name,p.name
    LIMIT 500`,params)).rows;
  return res.json(products)
 }catch(e:any){console.error('[retail-products] failed',e?.code||'',e?.message||e);return res.status(500).json({message:'A terméklista nem tölthető be.',code:e?.code||'RETAIL_PRODUCTS_FAILED'})}
});

router.post('/retail/sales',async(req:AuthRequest,res,next)=>{
 const c=await db.connect();
 try{
  await ensureRetailSchema();
  const locationId=String(req.body?.location_id||req.query.location_id||'').trim();
  if(!locationId)return res.status(400).json({message:'A termékeladáshoz telephely szükséges.'});
  const method=String(req.body?.payment_method||'cash').toLowerCase();
  if(!PAYMENT_METHODS.has(method))return res.status(400).json({message:'Érvénytelen fizetési mód.'});
  const requestedItems=Array.isArray(req.body?.items)?req.body.items:[];
  if(!requestedItems.length)return res.status(400).json({message:'Legalább egy terméket válasszon.'});
  await c.query('BEGIN');
  const normalized:any[]=[];
  for(const item of requestedItems){
    const id=String(item?.product_id||item?.id||'').trim(),qty=Math.max(0,Number(item?.quantity||0));
    if(!id||!(qty>0)){await c.query('ROLLBACK');return res.status(400).json({message:'A termék és a pozitív mennyiség kötelező.'})}
    const p=(await c.query(`SELECT p.id::text id,p.name,
      COALESCE(NULLIF(to_jsonb(p)->>'retail_price_gross','')::numeric,NULLIF(to_jsonb(p)->>'sale_price','')::numeric,NULLIF(to_jsonb(p)->>'price','')::numeric,0)::numeric price,
      COALESCE(NULLIF(to_jsonb(p)->>'vat_rate','')::numeric,0.27)::numeric vat_rate
      FROM products p WHERE p.id::text=$1 AND COALESCE(NULLIF(to_jsonb(p)->>'is_active','')::boolean,true)=true LIMIT 1`,[id])).rows[0];
    if(!p){await c.query('ROLLBACK');return res.status(400).json({message:'Egy kiválasztott termék nem található vagy inaktív.'})}
    const price=money(item?.unit_price??p.price),gross=money(price*qty);
    normalized.push({...p,quantity:qty,price,gross});
  }
  const total=money(normalized.reduce((n,x)=>n+x.gross,0));
  const netTotal=money(normalized.reduce((n,x)=>n+x.gross/(1+Number(x.vat_rate||0.27)),0));
  const sale=(await c.query(`INSERT INTO retail_sales(location_id,client_id,customer_name,customer_email,customer_phone,payment_method,gross_total,invoice_requested,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[locationId,String(req.body?.client_id||'')||null,String(req.body?.customer_name||'')||null,String(req.body?.customer_email||'')||null,String(req.body?.customer_phone||'')||null,method,total,Boolean(req.body?.invoice_requested),actor(req)])).rows[0];
  for(const item of normalized){
    await c.query(`INSERT INTO retail_sale_items(sale_id,product_id,product_name,quantity,unit_price_gross,gross_amount) VALUES($1,$2,$3,$4,$5,$6)`,[sale.id,item.id,item.name,item.quantity,item.price,item.gross]);
    const balanceExists=await tableExists('product_stock_balances');
    if(balanceExists)await c.query(`UPDATE product_stock_balances SET quantity=GREATEST(0,COALESCE(quantity,0)-$3) WHERE product_id::text=$1 AND location_id::text=$2`,[item.id,locationId,item.quantity]);
  }

  let invoice:any=null;
  if(Boolean(req.body?.invoice_requested)&&await tableExists('finance_invoices')&&await tableExists('finance_invoice_lines')){
    const fn=(await c.query(`SELECT to_regprocedure('next_internal_invoice_number()') IS NOT NULL ok`)).rows[0]?.ok;
    const invoiceNo=fn?String((await c.query(`SELECT next_internal_invoice_number() invoice_no`)).rows[0]?.invoice_no||''):`KLEO-TERM-${new Date().getFullYear()}-${String(sale.id).replace(/-/g,'').slice(0,10).toUpperCase()}`;
    const name=String(req.body?.billing_name||req.body?.customer_name||'Magánszemély').trim()||'Magánszemély';
    const tax=String(req.body?.billing_tax_number||'').replace(/\D/g,'')||null;
    const country=String(req.body?.billing_country_code||'HU').toUpperCase();
    const postal=String(req.body?.billing_postal_code||'').trim()||null,city=String(req.body?.billing_city||'').trim()||null,address=String(req.body?.billing_address||'').trim()||null;
    const net=money(normalized.reduce((n,x)=>n+x.gross/(1+Number(x.vat_rate||.27)),0)),vat=money(total-net);
    invoice=(await c.query(`INSERT INTO finance_invoices(location_id,direction,invoice_no,partner_name,customer_name,partner_tax_no,customer_tax_number,customer_vat_status,customer_country_code,customer_postal_code,customer_city,customer_address,issue_date,performance_date,due_date,currency,net_total,vat_total,gross_total,status,note,created_by,document_kind,invoice_type,nav_status,nav_validation_status,payment_method,payment_date)
      VALUES($1,'outgoing',$2,$3,$3,$4,$4,$5,$6,$7,$8,$9,CURRENT_DATE,CURRENT_DATE,CURRENT_DATE,'HUF',$10,$11,$12,'draft',$13,$14,'internal_draft','NORMAL','not_submitted','not_validated',$15,CURRENT_DATE) RETURNING *`,[locationId,invoiceNo,name,tax,tax?'DOMESTIC':'PRIVATE_PERSON',country,postal,city,address,net,vat,total,`Termékeladás ${sale.id}`,actor(req),method.toUpperCase()])).rows[0];
    let line=0;
    for(const item of normalized){line++;const rate=Number(item.vat_rate||.27),lineNet=money(item.gross/(1+rate)),lineVat=money(item.gross-lineNet);await c.query(`INSERT INTO finance_invoice_lines(invoice_id,line_number,description,quantity,unit_of_measure,unit_price_net,vat_rate,net_amount,vat_amount,gross_amount,product_id) VALUES($1,$2,$3,$4,'PIECE',$5,$6,$7,$8,$9,$10)`,[invoice.id,line,item.name,item.quantity,Number((lineNet/item.quantity).toFixed(4)),rate,lineNet,lineVat,item.gross,item.id])}
    await c.query(`UPDATE retail_sales SET finance_invoice_id=$2 WHERE id=$1`,[sale.id,invoice.id]);
  }
  const franchiseRevenue=await recordFranchiseRevenueIfApplicable(c,{locationId,occurredAt:sale.created_at,currency:'HUF',netRevenue:netTotal,sourceType:'retail_sale',sourceId:String(sale.id),sourcePayload:{gross_total:total,payment_method:method,finance_invoice_id:invoice?.id||null}});
  await c.query('COMMIT');
  return res.status(201).json({ok:true,sale:{...sale,finance_invoice_id:invoice?.id||null},invoice,items:normalized,total,net_total:netTotal,franchise_revenue_posted:franchiseRevenue.posted});
 }catch(e:any){await c.query('ROLLBACK').catch(()=>undefined);console.error('[retail-sale] failed',e?.code||'',e?.message||e);return next(e)}finally{c.release()}
});

router.post('/workorders/:id/settle',async(req:AuthRequest,res,next)=>{
  if(String(req.baseUrl||'').includes('loyalty-cashier')&&hasActualLoyalty(req.body))return next();
  const c=await db.connect();
  try{
    const [hasOrders,hasItems,hasPayments,hasRefunds]=await Promise.all([tableExists('work_orders'),tableExists('work_order_items'),tableExists('work_order_payments'),tableExists('work_order_payment_refunds')]);
    if(!hasOrders||!hasItems||!hasPayments)return next();
    await ensureLoyaltyProgram(c);
    const [woTypes,paymentTypes]=await Promise.all([columnTypes('work_orders'),columnTypes('work_order_payments')]);
    const woCols=new Set(woTypes.keys()),paymentCols=new Set(paymentTypes.keys());
    if(['payment_status','financial_closed_at'].some(x=>!woCols.has(x)))return next();
    if(!paymentCols.has('work_order_id')||!paymentCols.has('payment_method')||!paymentCols.has('amount'))return next();

    const settlementKey=requireIdempotencyKey(req,'workorder-settlement');
    const requestedDiscount=Math.max(0,money(req.body?.discount_amount)),tip=Math.max(0,money(req.body?.tip_amount)),invoiceStatus=String(req.body?.invoice_status||'not_requested'),closeFinancially=Boolean(req.body?.close_financially),incoming=Array.isArray(req.body?.payments)?req.body.payments:[];
    const requestPayload=JSON.stringify(req.body||{});
    await c.query('BEGIN');
    const wo=(await c.query(`SELECT w.*,to_jsonb(w) _json FROM work_orders w WHERE w.id::text=$1 FOR UPDATE`,[req.params.id])).rows[0];
    if(!wo){await c.query('ROLLBACK');return res.status(404).json({message:'A munkalap nem található.'})}
    const j=wo._json||{};
    if(j.locked_at||j.archived_at){await c.query('ROLLBACK');return res.status(409).json({message:'A lezárt és archivált munkalaphoz újabb fizetés nem rögzíthető.'})}
    if(['cancelled','no_show','completed'].includes(String(wo.status||''))){await c.query('ROLLBACK');return res.status(409).json({message:'Megszakított vagy lezárt munkalap pénzügyileg nem módosítható.'})}
    const previous=(await c.query(`SELECT *,request_payload=$2::jsonb AS same_payload FROM work_order_settlements WHERE settlement_key=$1 FOR UPDATE`,[settlementKey,requestPayload])).rows[0];
    if(previous){
      if(String(previous.work_order_id)!==String(req.params.id)||!previous.same_payload){await c.query('ROLLBACK');return res.status(409).json({message:'Az Idempotency-Key már más munkalaphoz vagy eltérő tartalmú pénzügyi záráshoz lett felhasználva.'})}
      await c.query('COMMIT');return res.json({...wo,idempotent:true,fast:true});
    }
    if(j.financial_closed_at){await c.query('ROLLBACK');return res.status(409).json({message:'A munkalap már pénzügyileg le van zárva; új műveleti kulccsal nem módosítható.'})}
    await c.query(`INSERT INTO work_order_settlements(work_order_id,settlement_key,request_payload,created_by) VALUES($1,$2,$3::jsonb,$4)`,[req.params.id,settlementKey,requestPayload,actor(req)]);

    for(const [paymentSequence,p] of incoming.entries()){
      const method=String(p?.payment_method||'').toLowerCase(),amount=money(p?.amount);
      if(!PAYMENT_METHODS.has(method)){await c.query('ROLLBACK');return res.status(400).json({message:`Érvénytelen fizetési mód: ${method}`})}
      if(!(amount>0)){await c.query('ROLLBACK');return res.status(400).json({message:'A fizetési összegnek pozitívnak kell lennie.'})}
      await recordProtectedWorkOrderPayment(c,{workOrder:wo,method,amount,note:p?.note||null,actor:actor(req),settlementKey,sequence:paymentSequence,financeAccountId:p?.finance_account_id||null,paymentMethodCode:p?.payment_method_code||method,cashierShiftId:p?.cashier_shift_id||null,feeAmount:money(p?.fee_amount)});
    }

    const paidExpr=paymentCols.has('refunded_amount')
      ? hasRefunds
        ? `wp.amount-GREATEST(COALESCE(wp.refunded_amount,0),COALESCE((SELECT SUM(r.amount) FROM work_order_payment_refunds r WHERE r.payment_id=wp.id),0))`
        : 'wp.amount-COALESCE(wp.refunded_amount,0)'
      : 'wp.amount';
    const [grossQ,paidQ]=await Promise.all([
      c.query(`SELECT COALESCE(SUM(line_total),0)::numeric gross FROM work_order_items WHERE work_order_id::text=$1`,[req.params.id]),
      c.query(`SELECT COALESCE(SUM(${paidExpr}),0)::numeric paid FROM work_order_payments wp WHERE wp.work_order_id::text=$1`,[req.params.id]),
    ]);
    const gross=money(grossQ.rows[0]?.gross),paid=money(paidQ.rows[0]?.paid),loyalty=await loyaltyDiscountForWorkOrder(c,req.params.id,gross),discount=Math.max(requestedDiscount,money(loyalty.amount)),due=Math.max(0,money(gross-discount+tip)),paymentStatus=paid<=0?'unpaid':paid+.009<due?'partial':'paid';
    if(closeFinancially&&paymentStatus!=='paid'){await c.query('ROLLBACK');return res.status(400).json({message:`A munkalap nem zárható pénzügyileg: még ${money(due-paid).toLocaleString('hu-HU')} Ft fizetendő.`})}

    const sets:string[]=[],params:any[]=[req.params.id],add=(col:string,val:any)=>{if(!woCols.has(col))return;params.push(val);sets.push(`${col}=$${params.length}`)};
    add('gross_total',gross);add('discount_amount',discount);add('tip_amount',tip);add('amount_due',due);add('amount_paid',paid);add('payment_status',paymentStatus);add('fully_paid',paymentStatus==='paid');add('invoice_status',invoiceStatus);add('loyalty_tier_code',loyalty.tier_code);add('loyalty_discount_percent',loyalty.percent);add('loyalty_discount_amount',loyalty.amount);
    if(closeFinancially){if(woCols.has('financial_closed_at'))sets.push('financial_closed_at=COALESCE(financial_closed_at,now())');if(woCols.has('financial_closed_by')&&textLike(woTypes.get('financial_closed_by'))){params.push(req.user?.email||String(req.user?.id||''));sets.push(`financial_closed_by=COALESCE(financial_closed_by,$${params.length})`)}}
    if(woCols.has('updated_at'))sets.push('updated_at=now()');
    if(!sets.length){await c.query('ROLLBACK');return next()}
    const updated=(await c.query(`UPDATE work_orders SET ${sets.join(',')} WHERE id::text=$1 RETURNING *`,params)).rows[0];
    await c.query(`UPDATE work_order_settlements SET completed_at=now(),result_snapshot=$2::jsonb WHERE settlement_key=$1`,[settlementKey,JSON.stringify({work_order_id:req.params.id,payment_status:updated.payment_status,amount_paid:updated.amount_paid,financial_closed_at:updated.financial_closed_at||null})]);
    await c.query('COMMIT');return res.json({...updated,fast:true,loyalty_passthrough:false,lifecycle_required:false});
  }catch(e:any){
    await c.query('ROLLBACK').catch(()=>undefined);console.error('[workorder-cashier-fast] failed',e?.code||'',e?.message||e);
    if(e?.code==='22P02')return res.status(400).json({message:'Érvénytelen munkalapazonosító.',code:e.code});
    if(e?.code==='57014'||e?.code==='55P03')return res.status(503).json({message:'A pénzügyi zárást adatbázis-zárolás vagy timeout akadályozta.',code:e.code});
    if(e?.status)return res.status(e.status).json({message:e.message,code:e.publicCode||'FINANCIAL_SETTLEMENT_FAILED'});
    return next(e);
  }finally{c.release()}
});

export default router;