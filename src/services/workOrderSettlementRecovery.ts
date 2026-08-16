import db from '../db';

const PAYMENT_METHODS=new Set(['cash','card','transfer','voucher','other']);
const money=(v:any)=>{const n=Number(v??0);return Number.isFinite(n)?Math.round(n*100)/100:0};

export async function settleWorkOrderWithoutShift(workOrderId:string,body:any,actor:string){
 const c=await db.connect();
 try{
  await c.query('BEGIN');
  const wo=(await c.query(`SELECT w.*,to_jsonb(w) _json FROM work_orders w WHERE w.id::text=$1 FOR UPDATE`,[workOrderId])).rows[0];
  if(!wo){await c.query('ROLLBACK');return{status:404,body:{message:'A munkalap nem található.'}}}
  const j=wo._json||wo;
  if(j.locked_at||j.archived_at||String(wo.status||'')==='completed'){await c.query('ROLLBACK');return{status:409,body:{message:'A munkalap már lezárt vagy archivált.'}}}
  if(j.financial_closed_at){await c.query('COMMIT');return{status:200,body:{...wo,idempotent:true,recovery:true}}}
  const paymentCols=new Set((await c.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='work_order_payments'`)).rows.map((r:any)=>String(r.column_name)));
  for(const p of Array.isArray(body?.payments)?body.payments:[]){
   const method=String(p?.payment_method||'').toLowerCase(),amount=money(p?.amount);
   if(!PAYMENT_METHODS.has(method)){await c.query('ROLLBACK');return{status:400,body:{message:`Érvénytelen fizetési mód: ${method}`}}}
   if(!(amount>0)){await c.query('ROLLBACK');return{status:400,body:{message:'A fizetési összegnek pozitívnak kell lennie.'}}}
   const names=['work_order_id','payment_method','amount'],vals=['$1::uuid','$2','$3'],params:any[]=[workOrderId,method,amount];
   if(paymentCols.has('paid_at')){names.push('paid_at');vals.push('now()')}
   if(paymentCols.has('note')){names.push('note');params.push([p?.note||'', 'Műszak nélküli lezárási recovery'].filter(Boolean).join(' · '));vals.push(`$${params.length}`)}
   await c.query(`INSERT INTO work_order_payments(${names.join(',')}) VALUES(${vals.join(',')})`,params);
  }
  const gross=money((await c.query(`SELECT COALESCE(SUM(line_total),0)::numeric total FROM work_order_items WHERE work_order_id::text=$1`,[workOrderId])).rows[0]?.total);
  const paid=money((await c.query(`SELECT COALESCE(SUM(amount),0)::numeric total FROM work_order_payments WHERE work_order_id::text=$1`,[workOrderId])).rows[0]?.total);
  const discount=Math.max(0,money(body?.discount_amount)),tip=Math.max(0,money(body?.tip_amount)),due=Math.max(0,money(gross-discount+tip));
  if(paid+.009<due){await c.query('ROLLBACK');return{status:400,body:{message:`A munkalap nem zárható pénzügyileg: még ${money(due-paid).toLocaleString('hu-HU')} Ft fizetendő.`}}}
  const updated=(await c.query(`UPDATE work_orders SET gross_total=$2,discount_amount=$3,tip_amount=$4,amount_due=$5,amount_paid=$6,payment_status='paid',fully_paid=true,invoice_status=$7,financial_closed_at=COALESCE(financial_closed_at,now()),financial_closed_by=COALESCE(financial_closed_by,$8),updated_at=now() WHERE id::text=$1 RETURNING *`,[workOrderId,gross,discount,tip,due,paid,String(body?.invoice_status||'not_requested'),actor])).rows[0];
  await c.query('COMMIT');return{status:200,body:{...updated,recovery:true,cashier_shift_id:null}}
 }catch(error){await c.query('ROLLBACK').catch(()=>undefined);throw error}finally{c.release()}
}
