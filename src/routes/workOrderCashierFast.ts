import {Router} from 'express';
import db from '../db';
import {requireAuth,AuthRequest} from '../middleware/auth';
import {ensureLoyaltyProgram,loyaltyDiscountForWorkOrder} from '../loyalty/loyaltyProgramService';

const router=Router();
router.use(requireAuth);

const PAYMENT_METHODS=new Set(['cash','card','transfer','voucher','other']);
const money=(v:any)=>{const n=Number(v??0);return Number.isFinite(n)?Math.round(n*100)/100:0};

async function tableExists(name:string){
  const q=await db.query(`SELECT to_regclass($1) IS NOT NULL ok`,[`public.${name}`]);
  return Boolean(q.rows[0]?.ok);
}
async function columnTypes(table:string){
  const q=await db.query(`SELECT column_name,data_type FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,[table]);
  return new Map<string,string>(q.rows.map((r:any)=>[String(r.column_name),String(r.data_type)]));
}
const textLike=(t:string|undefined)=>['text','character varying','character'].includes(String(t||''));
function hasActualLoyalty(body:any){
  return Boolean(Number(body?.wallet_amount||0)>0||Number(body?.points_to_spend||0)>0||String(body?.coupon_code||'').trim()||String(body?.voucher_code||'').trim()||Number(body?.voucher_amount||0)>0||(Array.isArray(body?.pass_usages)&&body.pass_usages.length));
}

router.post('/workorders/:id/settle',async(req:AuthRequest,res,next)=>{
  if(String(req.baseUrl||'').includes('loyalty-cashier')&&hasActualLoyalty(req.body))return next();
  const c=await db.connect();
  try{
    const [hasOrders,hasItems,hasPayments]=await Promise.all([tableExists('work_orders'),tableExists('work_order_items'),tableExists('work_order_payments')]);
    if(!hasOrders||!hasItems||!hasPayments)return next();
    await ensureLoyaltyProgram(c);
    const [woTypes,paymentTypes]=await Promise.all([columnTypes('work_orders'),columnTypes('work_order_payments')]);
    const woCols=new Set(woTypes.keys());const paymentCols=new Set(paymentTypes.keys());
    const required=['payment_status','financial_closed_at'];
    if(required.some(x=>!woCols.has(x)))return next();
    if(!paymentCols.has('work_order_id')||!paymentCols.has('payment_method')||!paymentCols.has('amount'))return next();

    const requestedDiscount=Math.max(0,money(req.body?.discount_amount));
    const tip=Math.max(0,money(req.body?.tip_amount));
    const invoiceStatus=String(req.body?.invoice_status||'not_requested');
    const closeFinancially=Boolean(req.body?.close_financially);
    const incoming=Array.isArray(req.body?.payments)?req.body.payments:[];

    await c.query('BEGIN');
    const wo=(await c.query(`SELECT w.*,to_jsonb(w) _json FROM work_orders w WHERE w.id::text=$1 FOR UPDATE`,[req.params.id])).rows[0];
    if(!wo){await c.query('ROLLBACK');return res.status(404).json({message:'A munkalap nem található.'})}
    const j=wo._json||{};
    if(j.locked_at||j.archived_at){await c.query('ROLLBACK');return res.status(409).json({message:'A lezárt és archivált munkalaphoz újabb fizetés nem rögzíthető.'})}
    if(['cancelled','no_show','completed'].includes(String(wo.status||''))){await c.query('ROLLBACK');return res.status(409).json({message:'Megszakított vagy lezárt munkalap pénzügyileg nem módosítható.'})}
    if(j.financial_closed_at){await c.query('COMMIT');return res.json({...wo,idempotent:true,fast:true})}

    for(const p of incoming){
      const method=String(p?.payment_method||'').toLowerCase();const amount=money(p?.amount);
      if(!PAYMENT_METHODS.has(method)){await c.query('ROLLBACK');return res.status(400).json({message:`Érvénytelen fizetési mód: ${method}`})}
      if(!(amount>0)){await c.query('ROLLBACK');return res.status(400).json({message:'A fizetési összegnek pozitívnak kell lennie.'})}
      const names=['work_order_id','payment_method','amount'];const values=['$1::uuid','$2','$3'];const params:any[]=[req.params.id,method,amount];
      if(paymentCols.has('paid_at')){names.push('paid_at');values.push('now()')}
      if(paymentCols.has('note')){names.push('note');params.push(p?.note||null);values.push(`$${params.length}`)}
      await c.query(`INSERT INTO work_order_payments(${names.join(',')}) VALUES(${values.join(',')})`,params);
    }

    const [grossQ,paidQ]=await Promise.all([
      c.query(`SELECT COALESCE(SUM(line_total),0)::numeric gross FROM work_order_items WHERE work_order_id::text=$1`,[req.params.id]),
      c.query(`SELECT COALESCE(SUM(amount),0)::numeric paid FROM work_order_payments WHERE work_order_id::text=$1`,[req.params.id]),
    ]);
    const gross=money(grossQ.rows[0]?.gross),paid=money(paidQ.rows[0]?.paid);
    const loyalty=await loyaltyDiscountForWorkOrder(c,req.params.id,gross);
    const discount=Math.max(requestedDiscount,money(loyalty.amount)),due=Math.max(0,money(gross-discount+tip));
    const paymentStatus=paid<=0?'unpaid':paid+.009<due?'partial':'paid';
    if(closeFinancially&&paymentStatus!=='paid'){await c.query('ROLLBACK');return res.status(400).json({message:`A munkalap nem zárható pénzügyileg: még ${money(due-paid).toLocaleString('hu-HU')} Ft fizetendő.`})}

    const sets:string[]=[];const params:any[]=[req.params.id];
    const add=(col:string,val:any)=>{if(!woCols.has(col))return;params.push(val);sets.push(`${col}=$${params.length}`)};
    add('gross_total',gross);add('discount_amount',discount);add('tip_amount',tip);add('amount_due',due);add('amount_paid',paid);add('payment_status',paymentStatus);add('fully_paid',paymentStatus==='paid');add('invoice_status',invoiceStatus);add('loyalty_tier_code',loyalty.tier_code);add('loyalty_discount_percent',loyalty.percent);add('loyalty_discount_amount',loyalty.amount);
    if(closeFinancially){
      if(woCols.has('financial_closed_at'))sets.push('financial_closed_at=COALESCE(financial_closed_at,now())');
      if(woCols.has('financial_closed_by')&&textLike(woTypes.get('financial_closed_by'))){params.push(req.user?.email||String(req.user?.id||''));sets.push(`financial_closed_by=COALESCE(financial_closed_by,$${params.length})`)}
    }
    if(woCols.has('updated_at'))sets.push('updated_at=now()');
    if(!sets.length){await c.query('ROLLBACK');return next()}
    const updated=(await c.query(`UPDATE work_orders SET ${sets.join(',')} WHERE id::text=$1 RETURNING *`,params)).rows[0];
    await c.query('COMMIT');
    return res.json({...updated,fast:true,loyalty_passthrough:false,lifecycle_required:false});
  }catch(e:any){
    await c.query('ROLLBACK').catch(()=>undefined);
    console.error('[workorder-cashier-fast] failed',e?.code||'',e?.message||e);
    if(e?.code==='22P02')return res.status(400).json({message:'Érvénytelen munkalapazonosító.',code:e.code});
    if(e?.code==='57014'||e?.code==='55P03')return res.status(503).json({message:'A pénzügyi zárást adatbázis-zárolás vagy timeout akadályozta.',code:e.code});
    return next(e);
  }finally{c.release()}
});

export default router;
