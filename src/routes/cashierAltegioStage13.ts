import {Router} from 'express';
import db from '../db';
import {requireAuth,type AuthRequest} from '../middleware/auth';
import {requireFeature} from '../middleware/featureAccess';

const router=Router();
router.use(requireAuth);
router.use(requireFeature('finance'));

const DENOMINATIONS=[20000,10000,5000,2000,1000,500,200,100,50,20,10,5];
const money=(value:any)=>{const n=Number(value??0);return Number.isFinite(n)?Math.round(n*100)/100:0};
const actor=(req:AuthRequest)=>req.user?.email||String(req.user?.id||'');
const locationFrom=(req:AuthRequest)=>String(req.body?.location_id||req.query.location_id||req.user?.location_id||'').trim();
const businessDate=(value:any)=>{const s=String(value||'').trim();return /^\d{4}-\d{2}-\d{2}$/.test(s)?s:new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Budapest',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())};

function denominationCount(raw:any){
  const denominations:Record<string,number>={};let total=0;
  for(const value of DENOMINATIONS){const quantity=Math.max(0,Math.floor(Number(raw?.[String(value)]||0)));denominations[String(value)]=quantity;total+=value*quantity}
  return{denominations,total:money(total)};
}

async function ensureDefaultRegister(client:any,locationId:string){
  const existing=(await client.query(`SELECT * FROM cash_registers WHERE location_id=$1 AND is_active=true ORDER BY sort_order,id LIMIT 1`,[locationId])).rows[0];
  if(existing)return existing;
  return (await client.query(`INSERT INTO cash_registers(location_id,name,register_type,opening_balance,comment,is_active) VALUES($1,'Főpénztár','cash',0,'Automatikusan létrehozott főpénztár',true) RETURNING *`,[locationId])).rows[0];
}

async function openSessions(client:any,locationId:string){
  return (await client.query(`SELECT s.*,r.name register_name,r.register_type,r.financial_account_id FROM cash_register_sessions s JOIN cash_registers r ON r.id=s.register_id WHERE s.location_id=$1 AND s.status='open' ORDER BY r.sort_order,r.id`,[locationId])).rows;
}

async function sessionTotals(client:any,session:any){
  const payment=(await client.query(`SELECT COALESCE(SUM(amount-COALESCE(refunded_amount,0)-COALESCE(fee_amount,0)),0)::numeric turnover FROM work_order_payments WHERE register_session_id=$1`,[session.id])).rows[0]||{};
  const movement=(await client.query(`SELECT COALESCE(SUM(amount) FILTER(WHERE direction='in'),0)::numeric cash_in,COALESCE(SUM(amount) FILTER(WHERE direction='out'),0)::numeric cash_out FROM cash_movements WHERE session_id=$1`,[session.id])).rows[0]||{};
  const turnover=money(payment.turnover),cash_in=money(movement.cash_in),cash_out=money(movement.cash_out);
  return{cash_sales:turnover,cash_in,cash_out,expected_cash:money(money(session.opening_cash)+turnover+cash_in-cash_out)};
}

async function resolvePaymentMethod(client:any,codeRaw:any){
  const code=String(codeRaw||'').trim().toLowerCase();
  const builtin:Record<string,string>={cash:'cash',card:'card',transfer:'transfer',voucher:'voucher',other:'other'};
  if(builtin[code])return{code,base:builtin[code],config:null};
  try{
    const config=(await client.query(`SELECT * FROM finance_payment_methods WHERE lower(code)=lower($1) AND active=true ORDER BY location_id NULLS LAST LIMIT 1`,[code])).rows[0];
    if(!config)return null;
    const type=String(config.method_type||'custom');
    const base=type==='cash'?'cash':type==='card'||type==='online_card'?'card':type==='bank_transfer'?'transfer':type==='voucher'?'voucher':'other';
    return{code,base,config};
  }catch(error:any){if(error?.code==='42P01')return null;throw error}
}

async function resolveRegisterSession(client:any,locationId:string,registerId:any,methodConfig:any,requireOpen:boolean){
  let id=String(registerId||'').trim();
  if(!id&&methodConfig?.account_id){
    const mapped=(await client.query(`SELECT id FROM cash_registers WHERE location_id=$1 AND financial_account_id=$2::uuid AND is_active=true LIMIT 1`,[locationId,methodConfig.account_id])).rows[0];
    if(mapped)id=String(mapped.id);
  }
  const sessions=await openSessions(client,locationId);
  if(id){
    const open=sessions.find((s:any)=>String(s.register_id)===id);
    if(open)return open;
    if(requireOpen)throw Object.assign(new Error('A kiválasztott pénztár nincs megnyitva.'),{status:409});
    return{register_id:id,id:null};
  }
  if(!requireOpen)return null;
  if(!sessions.length)throw Object.assign(new Error('Készpénzes fizetés előtt nyissa meg a pénztárt.'),{status:409});
  if(sessions.length>1)throw Object.assign(new Error('Több nyitott pénztár van. Válassza ki a fizetéshez használt kasszát.'),{status:409});
  return sessions[0];
}

router.get('/payment-methods',async(req:AuthRequest,res,next)=>{try{
  const locationId=locationFrom(req);
  try{
    const rows=(await db.query(`SELECT pm.*,r.id default_register_id,r.name default_register_name FROM finance_payment_methods pm LEFT JOIN cash_registers r ON r.financial_account_id=pm.account_id AND r.location_id=$1 WHERE pm.active=true AND (pm.location_id IS NULL OR pm.location_id=$1) ORDER BY pm.sort_order,pm.name`,[locationId])).rows;
    return res.json(rows);
  }catch(error:any){
    if(error?.code!=='42P01')throw error;
    return res.json([
      {code:'cash',name:'Készpénz',method_type:'cash'},
      {code:'card',name:'Bankkártya',method_type:'card'},
      {code:'transfer',name:'Átutalás',method_type:'bank_transfer'},
      {code:'voucher',name:'Utalvány',method_type:'voucher'},
      {code:'other',name:'Egyéb',method_type:'custom'},
    ]);
  }
}catch(error){next(error)}});

router.get('/registers',async(req:AuthRequest,res,next)=>{try{
  const locationId=locationFrom(req);if(!locationId)return res.status(400).json({message:'Válasszon telephelyet.'});
  const rows=(await db.query(`SELECT r.*,s.id open_session_id,s.opened_at,s.opened_by,s.business_date,s.opening_cash,s.shift_no FROM cash_registers r LEFT JOIN cash_register_sessions s ON s.register_id=r.id AND s.status='open' WHERE r.location_id=$1 ORDER BY r.is_active DESC,r.sort_order,r.name`,[locationId])).rows;
  res.json(rows);
}catch(error){next(error)}});

router.post('/registers',async(req:AuthRequest,res,next)=>{try{
  const locationId=locationFrom(req),name=String(req.body?.name||'').trim(),registerType=String(req.body?.register_type||'cash').trim();
  if(!locationId||!name)return res.status(400).json({message:'Telephely és pénztárnév szükséges.'});
  if(!['cash','cashless'].includes(registerType))return res.status(400).json({message:'A pénztár típusa cash vagy cashless lehet.'});
  const row=(await db.query(`INSERT INTO cash_registers(location_id,name,register_type,opening_balance,comment,external_code,sort_order,financial_account_id,is_active) VALUES($1,$2,$3,$4,$5,$6,$7,$8::uuid,true) RETURNING *`,[locationId,name,registerType,Math.max(0,money(req.body?.opening_balance)),req.body?.comment||null,req.body?.external_code||null,Number(req.body?.sort_order||100),req.body?.financial_account_id||null])).rows[0];
  res.status(201).json(row);
}catch(error){next(error)}});

router.patch('/registers/:id',async(req:AuthRequest,res,next)=>{try{
  const locationId=locationFrom(req);
  const row=(await db.query(`UPDATE cash_registers SET name=COALESCE(NULLIF($3,''),name),register_type=COALESCE(NULLIF($4,''),register_type),opening_balance=COALESCE($5,opening_balance),comment=COALESCE($6,comment),external_code=COALESCE($7,external_code),sort_order=COALESCE($8,sort_order),financial_account_id=COALESCE($9::uuid,financial_account_id),is_active=COALESCE($10,is_active),updated_at=now() WHERE id=$1 AND location_id=$2 RETURNING *`,[req.params.id,locationId,String(req.body?.name||''),String(req.body?.register_type||''),req.body?.opening_balance==null?null:money(req.body.opening_balance),req.body?.comment??null,req.body?.external_code??null,req.body?.sort_order==null?null:Number(req.body.sort_order),req.body?.financial_account_id||null,req.body?.is_active==null?null:Boolean(req.body.is_active)])).rows[0];
  if(!row)return res.status(404).json({message:'Pénztár nem található.'});res.json(row);
}catch(error){next(error)}});

router.get('/register-state',async(req:AuthRequest,res,next)=>{const client=await db.connect();try{
  const locationId=locationFrom(req);if(!locationId)return res.status(400).json({message:'A pénztár használatához válasszon telephelyet.'});
  await client.query('BEGIN');
  const register=req.query.register_id?(await client.query(`SELECT * FROM cash_registers WHERE id=$1 AND location_id=$2`,[req.query.register_id,locationId])).rows[0]:await ensureDefaultRegister(client,locationId);
  if(!register){await client.query('ROLLBACK');return res.status(404).json({message:'Pénztár nem található.'})}
  const session=(await client.query(`SELECT * FROM cash_register_sessions WHERE register_id=$1 AND status='open' ORDER BY opened_at DESC LIMIT 1`,[register.id])).rows[0]||null;
  const registers=(await client.query(`SELECT r.*,s.id open_session_id,s.opened_at,s.opened_by,s.shift_no FROM cash_registers r LEFT JOIN cash_register_sessions s ON s.register_id=r.id AND s.status='open' WHERE r.location_id=$1 AND r.is_active=true ORDER BY r.sort_order,r.name`,[locationId])).rows;
  const movements=session?(await client.query(`SELECT * FROM cash_movements WHERE session_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100`,[session.id])).rows:[];
  const counts=session?(await client.query(`SELECT * FROM cash_register_counts WHERE session_id=$1 ORDER BY created_at DESC,id DESC LIMIT 50`,[session.id])).rows:[];
  const totals=session?await sessionTotals(client,session):{cash_sales:0,cash_in:0,cash_out:0,expected_cash:money(register.opening_balance)};
  await client.query('COMMIT');res.json({location_id:locationId,business_date:businessDate(req.query.date),register,registers,session,movements,counts,...totals});
}catch(error){await client.query('ROLLBACK').catch(()=>undefined);next(error)}finally{client.release()}});

router.post('/sessions/open',async(req:AuthRequest,res,next)=>{const client=await db.connect();try{
  const locationId=locationFrom(req),date=businessDate(req.body?.business_date);if(!locationId)return res.status(400).json({message:'A pénztárnyitáshoz válasszon telephelyet.'});
  await client.query('BEGIN');
  const register=req.body?.register_id?(await client.query(`SELECT * FROM cash_registers WHERE id=$1 AND location_id=$2 AND is_active=true FOR UPDATE`,[req.body.register_id,locationId])).rows[0]:await ensureDefaultRegister(client,locationId);
  if(!register){await client.query('ROLLBACK');return res.status(404).json({message:'Pénztár nem található.'})}
  if((await client.query(`SELECT 1 FROM cash_register_sessions WHERE register_id=$1 AND status='open'`,[register.id])).rows[0]){await client.query('ROLLBACK');return res.status(409).json({message:'Ez a pénztár már nyitva van.'})}
  const denomination=denominationCount(req.body?.denominations);
  const opening=req.body?.opening_cash==null?(denomination.total||money(register.opening_balance)):Math.max(0,money(req.body.opening_cash));
  const shiftNo=Number((await client.query(`SELECT COALESCE(MAX(shift_no),0)+1 n FROM cash_register_sessions WHERE register_id=$1 AND business_date=$2::date`,[register.id,date])).rows[0]?.n||1);
  const session=(await client.query(`INSERT INTO cash_register_sessions(register_id,location_id,business_date,opening_cash,status,opened_by,note,shift_no) VALUES($1,$2,$3,$4,'open',$5,$6,$7) RETURNING *`,[register.id,locationId,date,opening,actor(req),req.body?.note||null,shiftNo])).rows[0];
  await client.query(`INSERT INTO cash_register_counts(register_id,session_id,location_id,business_date,count_type,denominations,counted_cash,expected_cash,difference,note,created_by) VALUES($1,$2,$3,$4,'opening',$5::jsonb,$6,$6,0,$7,$8)`,[register.id,session.id,locationId,date,JSON.stringify(denomination.denominations),opening,req.body?.note||null,actor(req)]);
  await client.query('COMMIT');res.status(201).json({register,session});
}catch(error){await client.query('ROLLBACK').catch(()=>undefined);next(error)}finally{client.release()}});

router.post('/cash-movements',async(req:AuthRequest,res,next)=>{const client=await db.connect();try{
  const locationId=locationFrom(req),sessionId=String(req.body?.session_id||'').trim(),direction=String(req.body?.direction||'').trim().toLowerCase(),amount=money(req.body?.amount),reason=String(req.body?.reason||'').trim();
  if(!locationId||!sessionId||!['in','out'].includes(direction)||!(amount>0)||reason.length<3)return res.status(400).json({message:'Érvényes pénztárműszak, irány, pozitív összeg és indok szükséges.'});
  await client.query('BEGIN');
  const session=(await client.query(`SELECT * FROM cash_register_sessions WHERE id=$1 AND location_id=$2 FOR UPDATE`,[sessionId,locationId])).rows[0];
  if(!session||session.status!=='open'){await client.query('ROLLBACK');return res.status(409).json({message:'A pénztárműszak nem nyitott.'})}
  const row=(await client.query(`INSERT INTO cash_movements(session_id,location_id,register_id,direction,amount,reason,movement_type,reference_no,partner_id,employee_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,[session.id,locationId,session.register_id,direction,amount,reason,String(req.body?.movement_type||'manual'),req.body?.reference_no||null,req.body?.partner_id||null,req.body?.employee_id||null,actor(req)])).rows[0];
  await client.query('COMMIT');res.status(201).json(row);
}catch(error){await client.query('ROLLBACK').catch(()=>undefined);next(error)}finally{client.release()}});

router.post('/sessions/:id/check',async(req:AuthRequest,res,next)=>{const client=await db.connect();try{
  const locationId=locationFrom(req),countType=String(req.body?.count_type||'check');
  if(!['check','handover'].includes(countType))return res.status(400).json({message:'Az ellenőrzés típusa check vagy handover lehet.'});
  await client.query('BEGIN');
  const session=(await client.query(`SELECT * FROM cash_register_sessions WHERE id=$1 AND location_id=$2 FOR UPDATE`,[req.params.id,locationId])).rows[0];
  if(!session||session.status!=='open'){await client.query('ROLLBACK');return res.status(409).json({message:'A pénztárműszak nem nyitott.'})}
  const totals=await sessionTotals(client,session),denomination=denominationCount(req.body?.denominations);
  const counted=req.body?.counted_cash==null?denomination.total:Math.max(0,money(req.body.counted_cash)),difference=money(counted-totals.expected_cash),handedTo=String(req.body?.handed_to||'').trim()||null;
  if(countType==='handover'&&!handedTo){await client.query('ROLLBACK');return res.status(400).json({message:'Pénztárátadásnál adja meg az átvevő pénztárost.'})}
  const check=(await client.query(`INSERT INTO cash_register_counts(register_id,session_id,location_id,business_date,count_type,denominations,counted_cash,expected_cash,difference,note,handed_to,created_by) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12) RETURNING *`,[session.register_id,session.id,locationId,session.business_date,countType,JSON.stringify(denomination.denominations),counted,totals.expected_cash,difference,req.body?.note||null,handedTo,actor(req)])).rows[0];
  let nextSession=null;
  if(countType==='handover'){
    await client.query(`UPDATE cash_register_sessions SET status='closed',counted_cash=$2,expected_cash=$3,difference=$4,closed_by=$5,closed_at=now(),handed_to=$6 WHERE id=$1`,[session.id,counted,totals.expected_cash,difference,actor(req),handedTo]);
    nextSession=(await client.query(`INSERT INTO cash_register_sessions(register_id,location_id,business_date,opening_cash,status,opened_by,note,shift_no,handover_from_session_id) VALUES($1,$2,$3,$4,'open',$5,$6,$7,$8) RETURNING *`,[session.register_id,locationId,session.business_date,counted,handedTo,`Pénztárátadás: ${actor(req)} → ${handedTo}`,Number(session.shift_no||1)+1,session.id])).rows[0];
  }
  await client.query('COMMIT');res.status(201).json({check,next_session:nextSession,...totals});
}catch(error){await client.query('ROLLBACK').catch(()=>undefined);next(error)}finally{client.release()}});

router.post('/transfers',async(req:AuthRequest,res,next)=>{const client=await db.connect();try{
  const locationId=locationFrom(req),fromId=String(req.body?.from_register_id||''),toId=String(req.body?.to_register_id||''),amount=money(req.body?.amount);
  if(!locationId||!fromId||!toId||fromId===toId||!(amount>0))return res.status(400).json({message:'Két külön pénztár és pozitív összeg szükséges.'});
  await client.query('BEGIN');const sessions=await openSessions(client,locationId),from=sessions.find((x:any)=>String(x.register_id)===fromId),to=sessions.find((x:any)=>String(x.register_id)===toId);
  if(!from||!to){await client.query('ROLLBACK');return res.status(409).json({message:'Átvezetéshez mindkét pénztárnak nyitva kell lennie.'})}
  const transfer=(await client.query(`INSERT INTO cash_register_transfers(location_id,from_register_id,to_register_id,amount,reference_no,note,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[locationId,fromId,toId,amount,req.body?.reference_no||null,req.body?.note||null,actor(req)])).rows[0];
  const reason=req.body?.note||'Pénztárközi átvezetés';
  await client.query(`INSERT INTO cash_movements(session_id,location_id,register_id,direction,amount,reason,movement_type,reference_no,transfer_id,created_by) VALUES($1,$2,$3,'out',$4,$5,'transfer',$6,$7,$8),($9,$2,$10,'in',$4,$5,'transfer',$6,$7,$8)`,[from.id,locationId,fromId,amount,reason,req.body?.reference_no||null,transfer.id,actor(req),to.id,toId]);
  await client.query('COMMIT');res.status(201).json(transfer);
}catch(error){await client.query('ROLLBACK').catch(()=>undefined);next(error)}finally{client.release()}});

// Register-level close deliberately does not replace the existing location/day
// aggregate cash_register_closings record used by the current main cashier route.
router.post('/register-daily-close',async(req:AuthRequest,res,next)=>{const client=await db.connect();try{
  const locationId=locationFrom(req),registerId=String(req.body?.register_id||'').trim();
  if(!locationId||!registerId)return res.status(400).json({message:'A lezárandó pénztár kiválasztása kötelező.'});
  await client.query('BEGIN');
  const session=(await client.query(`SELECT * FROM cash_register_sessions WHERE register_id=$1 AND location_id=$2 AND status='open' FOR UPDATE`,[registerId,locationId])).rows[0];
  if(!session){await client.query('ROLLBACK');return res.status(409).json({message:'A kiválasztott pénztár nincs nyitva.'})}
  const totals=await sessionTotals(client,session),denomination=denominationCount(req.body?.denominations);
  const counted=req.body?.counted_cash==null?denomination.total:Math.max(0,money(req.body.counted_cash)),difference=money(counted-totals.expected_cash);
  const closing=(await client.query(`INSERT INTO cash_register_counts(register_id,session_id,location_id,business_date,count_type,denominations,counted_cash,expected_cash,difference,note,created_by) VALUES($1,$2,$3,$4,'closing',$5::jsonb,$6,$7,$8,$9,$10) RETURNING *`,[session.register_id,session.id,locationId,session.business_date,JSON.stringify(denomination.denominations),counted,totals.expected_cash,difference,req.body?.note||null,actor(req)])).rows[0];
  const closed=(await client.query(`UPDATE cash_register_sessions SET status='closed',counted_cash=$2,expected_cash=$3,difference=$4,note=COALESCE($5,note),closed_by=$6,closed_at=now() WHERE id=$1 RETURNING *`,[session.id,counted,totals.expected_cash,difference,req.body?.note||null,actor(req)])).rows[0];
  await client.query('COMMIT');res.status(201).json({closing,session:closed,...totals});
}catch(error){await client.query('ROLLBACK').catch(()=>undefined);next(error)}finally{client.release()}});

router.get('/workorders/:id/payments',async(req:AuthRequest,res,next)=>{try{
  const rows=(await db.query(`SELECT wp.*,COALESCE((SELECT json_agg(r ORDER BY r.created_at) FROM work_order_payment_refunds r WHERE r.payment_id=wp.id),'[]'::json)::json refunds FROM work_order_payments wp WHERE wp.work_order_id::text=$1 ORDER BY wp.paid_at,wp.id`,[req.params.id])).rows;
  res.json(rows);
}catch(error){next(error)}});

router.post('/payments/:paymentId/refund',async(req:AuthRequest,res,next)=>{const client=await db.connect();try{
  const reason=String(req.body?.reason||'').trim(),requested=money(req.body?.amount);if(reason.length<3)return res.status(400).json({message:'A visszatérítés indoka kötelező.'});
  await client.query('BEGIN');
  const payment=(await client.query(`SELECT wp.*,wo.location_id,wo.gross_total,wo.discount_amount,wo.tip_amount FROM work_order_payments wp JOIN work_orders wo ON wo.id=wp.work_order_id WHERE wp.id=$1::uuid FOR UPDATE`,[req.params.paymentId])).rows[0];
  if(!payment){await client.query('ROLLBACK');return res.status(404).json({message:'A fizetés nem található.'})}
  const available=money(Number(payment.amount)-Number(payment.refunded_amount||0)),amount=requested>0?Math.min(requested,available):available;
  if(!(amount>0)){await client.query('ROLLBACK');return res.status(409).json({message:'Ezt a fizetést már teljes egészében visszatérítették.'})}
  let session:any=null;
  if(String(payment.payment_method)==='cash')session=await resolveRegisterSession(client,String(payment.location_id),req.body?.register_id||payment.register_id,null,true);
  const refund=(await client.query(`INSERT INTO work_order_payment_refunds(payment_id,work_order_id,location_id,register_id,register_session_id,amount,reason,refund_method,created_by) VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[payment.id,String(payment.work_order_id),String(payment.location_id),session?.register_id||payment.register_id||null,session?.id||null,amount,reason,String(payment.payment_method),actor(req)])).rows[0];
  await client.query(`UPDATE work_order_payments SET refunded_amount=refunded_amount+$2 WHERE id=$1::uuid`,[payment.id,amount]);
  if(session)await client.query(`INSERT INTO cash_movements(session_id,location_id,register_id,direction,amount,reason,movement_type,work_order_id,payment_id,created_by) VALUES($1,$2,$3,'out',$4,$5,'refund',$6,$7::uuid,$8)`,[session.id,String(payment.location_id),session.register_id,amount,reason,String(payment.work_order_id),payment.id,actor(req)]);
  const paid=money((await client.query(`SELECT COALESCE(SUM(amount-refunded_amount),0)::numeric paid FROM work_order_payments WHERE work_order_id=$1`,[payment.work_order_id])).rows[0]?.paid);
  const due=Math.max(0,money(Number(payment.gross_total||0)-Number(payment.discount_amount||0)+Number(payment.tip_amount||0)));
  const refundCount=Number((await client.query(`SELECT count(*) n FROM work_order_payment_refunds WHERE work_order_id=$1`,[String(payment.work_order_id)])).rows[0]?.n||0);
  const paymentStatus=paid<=0&&refundCount>0?'refunded':paid<=0?'unpaid':paid+.009<due?'partial':'paid';
  await client.query(`UPDATE work_orders SET amount_paid=$2,payment_status=$3,fully_paid=($3='paid'),updated_at=now() WHERE id=$1`,[payment.work_order_id,paid,paymentStatus]);
  await client.query('COMMIT');res.status(201).json({refund,amount_paid:paid,payment_status:paymentStatus});
}catch(error:any){await client.query('ROLLBACK').catch(()=>undefined);if(error?.status)return res.status(error.status).json({message:error.message});next(error)}finally{client.release()}});

// Pre-process checkout: custom Altegio-style methods are normalized to the
// work-order core methods, while retaining the configured code, register and fee.
router.post('/workorders/:id/settle',async(req:AuthRequest,res,next)=>{const client=await db.connect();try{
  const payments=Array.isArray(req.body?.payments)?req.body.payments:[];if(!payments.length)return next();
  const order=(await client.query(`SELECT location_id FROM work_orders WHERE id::text=$1`,[req.params.id])).rows[0];if(!order)return next();
  const locationId=String(order.location_id||locationFrom(req));
  for(const payment of payments){
    const resolved=await resolvePaymentMethod(client,payment?.payment_method_code||payment?.payment_method);
    if(!resolved)throw Object.assign(new Error(`Ismeretlen fizetési mód: ${payment?.payment_method_code||payment?.payment_method}`),{status:400});
    payment.payment_method_code=resolved.code;payment.payment_method=resolved.base;
    const requiresOpen=resolved.base==='cash';
    const session=await resolveRegisterSession(client,locationId,payment.register_id, resolved.config,requiresOpen);
    if(session?.register_id){payment.register_id=session.register_id;if(session.id)payment.register_session_id=session.id}
    if(resolved.config){
      const brand=String(payment.card_brand||'');
      const feeRate=brand&&resolved.config.brand_fees?.[brand]!=null?Number(resolved.config.brand_fees[brand]):Number(resolved.config.fee_percent||0);
      payment.fee_amount=money(Number(payment.amount||0)*feeRate/100+Number(resolved.config.fee_fixed||0));
    }
  }
  next();
}catch(error:any){if(error?.status)return res.status(error.status).json({message:error.message});next(error)}finally{client.release()}});

export default router;
