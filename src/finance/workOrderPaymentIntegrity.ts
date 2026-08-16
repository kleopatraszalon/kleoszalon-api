import type { PoolClient } from 'pg';

type Recognition = 'ledger_income' | 'voucher_redemption' | 'prepaid_redemption';

type PaymentInput = {
  workOrder: any;
  method: string;
  amount: number;
  note?: string | null;
  actor: string;
  settlementKey: string;
  sequence: number;
  financeAccountId?: string | null;
  paymentMethodCode?: string | null;
  cashierShiftId?: string | number | null;
  feeAmount?: number;
  recognition?: Recognition;
};

const accountType=(method:string)=>method==='cash'?'cash':method==='card'?'card':method==='transfer'?'bank':'other';
const accountName=(method:string)=>method==='cash'?'Készpénz pénztár':method==='card'?'Bankkártya terminál':method==='transfer'?'Bankszámla':'Egyéb fizetési számla';
const money=(value:unknown)=>Math.round(Number(value||0)*100)/100;

async function resolveAccount(client:PoolClient,workOrder:any,method:string,supplied?:string|null){
  const requested=String(supplied||'').trim();
  if(requested){
    const account=(await client.query(`SELECT * FROM financial_accounts WHERE id=$1::uuid AND active=true AND (location_id IS NOT DISTINCT FROM $2::uuid OR location_id IS NULL) FOR UPDATE`,[requested,workOrder.location_id||null])).rows[0];
    if(!account)throw Object.assign(new Error('A fizetéshez választott pénzügyi számla nem található vagy másik telephelyhez tartozik.'),{status:409});
    return account;
  }
  const type=accountType(method);
  let account=(await client.query(`SELECT * FROM financial_accounts WHERE active=true AND account_type=$1 AND (location_id IS NOT DISTINCT FROM $2::uuid OR location_id IS NULL) ORDER BY CASE WHEN location_id IS NOT DISTINCT FROM $2::uuid THEN 0 ELSE 1 END,is_default DESC,sort_order,name FOR UPDATE LIMIT 1`,[type,workOrder.location_id||null])).rows[0];
  if(account)return account;
  const name=accountName(method);
  await client.query(`INSERT INTO financial_accounts(location_id,name,account_type,currency,opening_balance,active,note) SELECT $1::uuid,$2,$3,'HUF',0,true,'Automatikusan létrehozva munkalapfizetéshez' WHERE NOT EXISTS(SELECT 1 FROM financial_accounts WHERE location_id IS NOT DISTINCT FROM $1::uuid AND lower(name)=lower($2))`,[workOrder.location_id||null,name,type]);
  account=(await client.query(`SELECT * FROM financial_accounts WHERE active=true AND location_id IS NOT DISTINCT FROM $1::uuid AND lower(name)=lower($2) FOR UPDATE`,[workOrder.location_id||null,name])).rows[0];
  if(!account)throw Object.assign(new Error(`Nem hozható létre pénzügyi számla ehhez a fizetéshez: ${method}`),{status:409});
  return account;
}

export async function recordProtectedWorkOrderPayment(client:PoolClient,input:PaymentInput){
  const method=String(input.method||'').toLowerCase();
  const amount=money(input.amount);
  const recognition:Recognition=input.recognition||(method==='voucher'?'voucher_redemption':'ledger_income');
  const payment=(await client.query(`INSERT INTO work_order_payments(
      work_order_id,payment_method,amount,paid_at,note,payment_method_code,finance_account_id,
      financial_account_id,cashier_shift_id,fee_amount,settlement_key,payment_sequence,
      integrity_required,revenue_recognition)
    VALUES($1::uuid,$2,$3,now(),$4,$5,$6::uuid,$6::uuid,$7,$8,$9,$10,true,$11)
    RETURNING *`,[
      input.workOrder.id,method,amount,input.note||null,input.paymentMethodCode||method,
      input.financeAccountId||null,input.cashierShiftId||null,money(input.feeAmount),
      input.settlementKey,input.sequence,recognition,
    ])).rows[0];

  if(recognition!=='ledger_income'){
    await client.query(`INSERT INTO finance_integrity_events(event_type,location_key,subject_type,subject_id,actor,reason,evidence)
      VALUES('prepaid_value_redeemed',$1,'work_order_payment',$2,$3,$4,$5::jsonb)`,[
      String(input.workOrder.location_id||'__global__'),String(payment.id),input.actor,
      recognition==='voucher_redemption'?'Az utalvány beváltása nem új árbevétel.':'Az előre feltöltött vendégegyenleg felhasználása nem új árbevétel.',
      JSON.stringify({work_order_id:String(input.workOrder.id),amount,recognition,payment_method_code:input.paymentMethodCode||method}),
    ]);
    return payment;
  }

  const account=await resolveAccount(client,input.workOrder,method,input.financeAccountId);
  const postingGroupId=(await client.query(`SELECT gen_random_uuid() id`)).rows[0].id;
  const category=(await client.query(`SELECT id FROM financial_categories WHERE system_key='service_sales' LIMIT 1`)).rows[0];
  const movement=(await client.query(`INSERT INTO financial_movements(
      location_id,account_id,category_id,direction,amount,occurred_at,reference_type,reference_id,
      note,created_by,payment_method_code,work_order_id,payment_status,posting_group_id,idempotency_key)
    VALUES($1::uuid,$2::uuid,$3::uuid,'income',$4,now(),'work_order_payment',$5,$6,$7,$8,$9,
           'posted',$10::uuid,$11) RETURNING *`,[
      input.workOrder.location_id,account.id,category?.id||null,amount,String(payment.id),
      `Munkalapfizetés · ${method}`,input.actor,input.paymentMethodCode||method,String(input.workOrder.id),
      postingGroupId,`${input.settlementKey}:payment:${input.sequence}`,
    ])).rows[0];
  const fee=money(input.feeAmount);
  if(fee>0){
    const feeCategory=(await client.query(`SELECT id FROM financial_categories WHERE system_key='acquiring_fee' LIMIT 1`)).rows[0];
    await client.query(`INSERT INTO financial_movements(
        location_id,account_id,category_id,direction,amount,occurred_at,reference_type,reference_id,
        note,created_by,payment_method_code,work_order_id,payment_status,fee_for_movement_id,
        posting_group_id,idempotency_key)
      VALUES($1::uuid,$2::uuid,$3::uuid,'expense',$4,now(),'acquiring_fee',$5,
             'Automatikus elfogadói díj',$6,$7,$8,'posted',$5::uuid,$9::uuid,$10)`,[
      input.workOrder.location_id,account.id,feeCategory?.id||null,fee,movement.id,input.actor,
      input.paymentMethodCode||method,String(input.workOrder.id),postingGroupId,
      `${input.settlementKey}:payment:${input.sequence}:fee`,
    ]);
  }
  await client.query(`UPDATE work_order_payments SET finance_account_id=$2::uuid,
    financial_account_id=$2::uuid,financial_movement_id=$3::uuid WHERE id=$1`,[
    payment.id,account.id,movement.id,
  ]);
  return {...payment,finance_account_id:account.id,financial_account_id:account.id,financial_movement_id:movement.id};
}
