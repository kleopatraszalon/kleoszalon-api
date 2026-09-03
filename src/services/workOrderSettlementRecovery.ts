import {createHash} from 'node:crypto';
import db from '../db';
import {ensureOtherPaymentCompatibility} from '../finance/ensureOtherPaymentCompatibility';
import {recordProtectedWorkOrderPayment} from '../finance/workOrderPaymentIntegrity';

const PAYMENT_METHODS=new Set(['cash','card','transfer','voucher','other']);
const money=(v:any)=>{const n=Number(v??0);return Number.isFinite(n)?Math.round(n*100)/100:0};
const textLike=(t:string|undefined)=>['text','character varying','character'].includes(String(t||''));
const timestampLike=(t:string|undefined)=>t==='timestamp with time zone'||t==='timestamp without time zone';
const paymentMethod=(v:any)=>{
 const raw=String(v||'').trim().toLowerCase();
 if(raw==='bank_card'||raw==='bankcard')return 'card';
 if(raw==='bank_transfer'||raw==='banktransfer')return 'transfer';
 return raw;
};

async function columnTypes(c:any,table:string){
 const q=await c.query(`SELECT column_name,data_type FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,[table]);
 return new Map<string,string>(q.rows.map((r:any)=>[String(r.column_name),String(r.data_type)]));
}

async function resolveOpenCashierShift(c:any,workOrder:any,supplied:any){
 const requested=String(supplied??'').trim();
 if(requested)return requested;
 const exists=(await c.query(`SELECT to_regclass('public.cash_register_shifts') IS NOT NULL ok`)).rows[0]?.ok;
 if(!exists)return null;
 const locationId=String(workOrder?.location_id||'').trim();
 if(!locationId)return null;
 const shift=(await c.query(`SELECT id FROM cash_register_shifts WHERE location_id::text=$1 AND status='open' ORDER BY opened_at DESC LIMIT 1 FOR UPDATE`,[locationId])).rows[0];
 return shift?.id??null;
}

const fallbackSettlementKey=(workOrderId:string,body:any)=>{
 const digest=createHash('sha256').update(`${workOrderId}:${JSON.stringify(body||{})}`).digest('hex').slice(0,32);
 return `workorder-settlement-recovery:${digest}`;
};

export async function settleWorkOrderWithoutShift(workOrderId:string,body:any,actor:string,settlementKey?:string){
 await ensureOtherPaymentCompatibility();
 const c=await db.connect();
 try{
  await c.query('BEGIN');
  const [woTypes,itemTypes,paymentTypes]=await Promise.all([
   columnTypes(c,'work_orders'),columnTypes(c,'work_order_items'),columnTypes(c,'work_order_payments')
  ]);
  const woCols=new Set(woTypes.keys()),itemCols=new Set(itemTypes.keys()),paymentCols=new Set(paymentTypes.keys());
  const paymentAmountColumns=['amount','amount_huf'].filter(column=>paymentCols.has(column));
  if(!woCols.has('payment_status')||!woCols.has('financial_closed_at')){
   await c.query('ROLLBACK');
   return{status:503,body:{message:'A munkalap pénzügyi lezárási sémája hiányos. A pénzügyi adatbázis-migráció szükséges.',error_code:'WORK_ORDER_SCHEMA_INCOMPLETE'}};
  }
  if(!itemCols.has('work_order_id')||!itemCols.has('line_total')||!paymentCols.has('work_order_id')||!paymentCols.has('payment_method')||!paymentCols.has('amount')){
   await c.query('ROLLBACK');
   return{status:503,body:{message:'A munkalap tétel- vagy fizetési sémája hiányos. Az adatbázis-migráció szükséges.',error_code:'WORK_ORDER_PAYMENT_SCHEMA_INCOMPLETE'}};
  }

  const wo=(await c.query(`SELECT w.*,to_jsonb(w) _json FROM work_orders w WHERE w.id::text=$1 FOR UPDATE`,[workOrderId])).rows[0];
  if(!wo){await c.query('ROLLBACK');return{status:404,body:{message:'A munkalap nem található.'}}}
  const j=wo._json||wo;
  if(j.locked_at||j.archived_at||String(wo.status||'')==='completed'){await c.query('ROLLBACK');return{status:409,body:{message:'A munkalap már lezárt vagy archivált.'}}}
  if(j.financial_closed_at){await c.query('COMMIT');return{status:200,body:{...wo,idempotent:true,recovery:true}}}

  const gross=money((await c.query(`SELECT COALESCE(SUM(line_total),0)::numeric total FROM work_order_items WHERE work_order_id::text=$1`,[workOrderId])).rows[0]?.total);
  const requestedDiscount=Math.max(0,money(body?.discount_amount)),storedDiscount=Math.max(0,money(j.discount_amount));
  const requestedTip=Math.max(0,money(body?.tip_amount)),storedTip=Math.max(0,money(j.tip_amount));
  const discount=Math.max(requestedDiscount,storedDiscount),tip=Math.max(requestedTip,storedTip),due=Math.max(0,money(gross-discount+tip));
  const paymentAmountExpression=paymentCols.has('amount')&&paymentCols.has('amount_huf')?'COALESCE(amount,amount_huf)':paymentAmountColumns[0];
  let existingPaid=money((await c.query(`SELECT COALESCE(SUM(${paymentAmountExpression}),0)::numeric total FROM work_order_payments WHERE work_order_id::text=$1`,[workOrderId])).rows[0]?.total);
  let remaining=Math.max(0,money(due-existingPaid));
  const protectedSettlementKey=String(settlementKey||'').trim()||fallbackSettlementKey(workOrderId,body);

  for(const [sequence,p] of (Array.isArray(body?.payments)?body.payments:[]).entries()){
   if(remaining<=.009)break;
   const method=paymentMethod(p?.payment_method),requestedAmount=money(p?.amount??p?.amount_huf);
   if(!PAYMENT_METHODS.has(method)){await c.query('ROLLBACK');return{status:400,body:{message:`Érvénytelen fizetési mód: ${method}`}}}
   if(!(requestedAmount>0)){await c.query('ROLLBACK');return{status:400,body:{message:'A fizetési összegnek pozitívnak kell lennie.'}}}
   const amount=Math.min(requestedAmount,remaining);
   const cashierShiftId=method==='cash'?await resolveOpenCashierShift(c,wo,p?.cashier_shift_id):p?.cashier_shift_id||null;
   if(method==='cash'&&!cashierShiftId){
    await c.query('ROLLBACK');
    return{status:409,body:{message:'Készpénzes munkalapfizetéshez nyitott pénztári műszak szükséges. Nyisd meg a kasszát, majd indítsd újra a fizetést.',error_code:'CASHIER_SHIFT_REQUIRED'}};
   }
   await recordProtectedWorkOrderPayment(c,{
    workOrder:wo,
    method,
    amount,
    note:[p?.note||'','Automatikus pénzügyi helyreállítás'].filter(Boolean).join(' · '),
    actor,
    settlementKey:protectedSettlementKey,
    sequence,
    financeAccountId:p?.finance_account_id||null,
    paymentMethodCode:p?.payment_method_code||method,
    cashierShiftId,
    feeAmount:money(p?.fee_amount),
   });
   existingPaid=money(existingPaid+amount);
   remaining=Math.max(0,money(due-existingPaid));
  }

  const paid=money((await c.query(`SELECT COALESCE(SUM(${paymentAmountExpression}),0)::numeric total FROM work_order_payments WHERE work_order_id::text=$1`,[workOrderId])).rows[0]?.total);
  if(paid+.009<due){await c.query('ROLLBACK');return{status:400,body:{message:`A munkalap nem zárható pénzügyileg: még ${money(due-paid).toLocaleString('hu-HU')} Ft fizetendő.`}}}

  const sets:string[]=[],params:any[]=[workOrderId];
  const add=(column:string,value:any)=>{if(!woCols.has(column))return;params.push(value);sets.push(`${column}=$${params.length}`)};
  add('gross_total',gross);
  add('discount_amount',discount);
  add('tip_amount',tip);
  add('amount_due',due);
  add('amount_paid',paid);
  add('payment_status','paid');
  add('fully_paid',true);
  sets.push('financial_closed_at=COALESCE(financial_closed_at,now())');
  if(woCols.has('financial_closed_by')&&textLike(woTypes.get('financial_closed_by'))){params.push(actor);sets.push(`financial_closed_by=COALESCE(financial_closed_by,$${params.length})`)}
  if(timestampLike(woTypes.get('updated_at')))sets.push('updated_at=now()');

  const updated=(await c.query(`UPDATE work_orders SET ${sets.join(',')} WHERE id::text=$1 RETURNING *`,params)).rows[0];
  await c.query('COMMIT');
  return{status:200,body:{...updated,recovery:true,protected_payment_recovery:true,idempotent_payment_recovery:remaining<=.009}}
 }catch(error:any){
  await c.query('ROLLBACK').catch(()=>undefined);
  const code=String(error?.code||'');
  const diagnostic={code:code||null,table:error?.table?String(error.table):null,column:error?.column?String(error.column):null,constraint:error?.constraint?String(error.constraint):null};
  const diagnosticTarget=diagnostic.constraint||[diagnostic.table,diagnostic.column].filter(Boolean).join('.');
  console.error('[workorder-settlement-recovery] failed',workOrderId,code,error?.table||'',error?.column||'',error?.constraint||'',error?.message||error);
  if(code==='P0001')return{status:409,body:{message:String(error?.message||'A pénzügyi helyreállítást üzleti szabály akadályozza.'),error_code:'CASHIER_SETTLEMENT_RULE_CONFLICT',diagnostic}};
  if(['23502','23503','23514'].includes(code))return{status:409,body:{message:`A munkalap pénzügyi helyreállítását egy adatkonzisztencia-feltétel akadályozza${diagnosticTarget?` (${diagnosticTarget})`:''}.`,error_code:'CASHIER_SETTLEMENT_RECOVERY_CONSTRAINT',diagnostic}};
  if(['57014','55P03','40P01'].includes(code))return{status:503,body:{message:'A pénzügyi helyreállítást adatbázis-zárolás vagy timeout akadályozta. Próbáld újra.',error_code:'CASHIER_SETTLEMENT_RETRYABLE_DB',diagnostic}};
  return{status:500,body:{message:'A munkalap pénzügyi helyreállítása sikertelen.',error_code:'CASHIER_SETTLEMENT_RECOVERY_FAILED',diagnostic}};
 }finally{c.release()}
}
