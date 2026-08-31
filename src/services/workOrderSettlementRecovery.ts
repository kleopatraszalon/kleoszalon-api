import db from '../db';

const PAYMENT_METHODS=new Set(['cash','card','transfer','voucher','other']);
const money=(v:any)=>{const n=Number(v??0);return Number.isFinite(n)?Math.round(n*100)/100:0};
const textLike=(t:string|undefined)=>['text','character varying','character'].includes(String(t||''));
const timestampLike=(t:string|undefined)=>t==='timestamp with time zone'||t==='timestamp without time zone';

async function columnTypes(c:any,table:string){
 const q=await c.query(`SELECT column_name,data_type FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,[table]);
 return new Map<string,string>(q.rows.map((r:any)=>[String(r.column_name),String(r.data_type)]));
}

export async function settleWorkOrderWithoutShift(workOrderId:string,body:any,actor:string){
 const c=await db.connect();
 try{
  await c.query('BEGIN');
  const [woTypes,itemTypes,paymentTypes]=await Promise.all([
   columnTypes(c,'work_orders'),columnTypes(c,'work_order_items'),columnTypes(c,'work_order_payments')
  ]);
  const woCols=new Set(woTypes.keys()),itemCols=new Set(itemTypes.keys()),paymentCols=new Set(paymentTypes.keys());
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
  let existingPaid=money((await c.query(`SELECT COALESCE(SUM(amount),0)::numeric total FROM work_order_payments WHERE work_order_id::text=$1`,[workOrderId])).rows[0]?.total);
  let remaining=Math.max(0,money(due-existingPaid));

  const paymentWorkOrderCast=paymentTypes.get('work_order_id')==='uuid'?'::uuid':'';
  for(const p of Array.isArray(body?.payments)?body.payments:[]){
   if(remaining<=.009)break;
   const method=String(p?.payment_method||'').toLowerCase(),requestedAmount=money(p?.amount);
   if(!PAYMENT_METHODS.has(method)){await c.query('ROLLBACK');return{status:400,body:{message:`Érvénytelen fizetési mód: ${method}`}}}
   if(!(requestedAmount>0)){await c.query('ROLLBACK');return{status:400,body:{message:'A fizetési összegnek pozitívnak kell lennie.'}}}
   const amount=Math.min(requestedAmount,remaining);
   const names=['work_order_id','payment_method','amount'],vals=[`$1${paymentWorkOrderCast}`,'$2','$3'],params:any[]=[workOrderId,method,amount];
   if(timestampLike(paymentTypes.get('paid_at'))){names.push('paid_at');vals.push('now()')}
   if(paymentCols.has('note')){names.push('note');params.push([p?.note||'', 'Műszak nélküli lezárási recovery'].filter(Boolean).join(' · '));vals.push(`$${params.length}`)}
   await c.query(`INSERT INTO work_order_payments(${names.join(',')}) VALUES(${vals.join(',')})`,params);
   existingPaid=money(existingPaid+amount);
   remaining=Math.max(0,money(due-existingPaid));
  }

  const paid=money((await c.query(`SELECT COALESCE(SUM(amount),0)::numeric total FROM work_order_payments WHERE work_order_id::text=$1`,[workOrderId])).rows[0]?.total);
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
  add('invoice_status',String(body?.invoice_status||j.invoice_status||'not_requested'));
  sets.push('financial_closed_at=COALESCE(financial_closed_at,now())');
  if(woCols.has('financial_closed_by')&&textLike(woTypes.get('financial_closed_by'))){params.push(actor);sets.push(`financial_closed_by=COALESCE(financial_closed_by,$${params.length})`)}
  if(timestampLike(woTypes.get('updated_at')))sets.push('updated_at=now()');

  const updated=(await c.query(`UPDATE work_orders SET ${sets.join(',')} WHERE id::text=$1 RETURNING *`,params)).rows[0];
  await c.query('COMMIT');
  return{status:200,body:{...updated,recovery:true,cashier_shift_id:null,idempotent_payment_recovery:remaining<=.009}}
 }catch(error:any){
  await c.query('ROLLBACK').catch(()=>undefined);
  console.error('[workorder-settlement-recovery] failed',workOrderId,error?.code||'',error?.table||'',error?.column||'',error?.constraint||'',error?.message||error);
  throw error;
 }finally{c.release()}
}
