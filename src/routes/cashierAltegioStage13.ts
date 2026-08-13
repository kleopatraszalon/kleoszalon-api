import {Router} from 'express';
import db from '../db';
import {requireAuth,type AuthRequest} from '../middleware/auth';
import {requireFeature} from '../middleware/featureAccess';

const router=Router();
router.use(requireAuth);
router.use(requireFeature('finance'));

const money=(v:any)=>{const n=Number(v??0);return Number.isFinite(n)?Math.round(n*100)/100:0};
const actor=(req:AuthRequest)=>req.user?.email||String(req.user?.id||'');
const businessDate=(v:any)=>{const s=String(v||'').trim();return /^\d{4}-\d{2}-\d{2}$/.test(s)?s:new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Budapest',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())};
const locationFrom=(req:AuthRequest)=>String(req.body?.location_id||req.query.location_id||req.user?.location_id||'').trim();
const denominations=[20000,10000,5000,2000,1000,500,200,100,50,20,10,5];
function countDenominations(raw:any){const d:any={};let total=0;for(const value of denominations){const qty=Math.max(0,Math.floor(Number(raw?.[String(value)]||0)));d[String(value)]=qty;total+=qty*value}return{denominations:d,total:money(total)}}

async function ensureDefaultRegister(client:any,locationId:string){
 const existing=(await client.query(`SELECT * FROM cash_registers WHERE location_id=$1 AND is_active=true ORDER BY sort_order,id LIMIT 1`,[locationId])).rows[0];
 if(existing)return existing;
 return (await client.query(`INSERT INTO cash_registers(location_id,name,register_type,opening_balance,comment,is_active) VALUES($1,'Főpénztár','cash',0,'Automatikusan létrehozott főpénztár',true) RETURNING *`,[locationId])).rows[0];
}
async function sessionExpected(client:any,session:any){
 const sales=await client.query(`SELECT COALESCE(SUM(wp.amount),0)::numeric amount FROM work_order_payments wp WHERE wp.payment_method='cash' AND wp.register_session_id=$1`,[session.id]);
 const movements=await client.query(`SELECT COALESCE(SUM(amount) FILTER(WHERE direction='in'),0)::numeric cash_in,COALESCE(SUM(amount) FILTER(WHERE direction='out'),0)::numeric cash_out FROM cash_movements WHERE session_id=$1`,[session.id]);
 const cashSales=money(sales.rows[0]?.amount),cashIn=money(movements.rows[0]?.cash_in),cashOut=money(movements.rows[0]?.cash_out);
 return{cash_sales:cashSales,cash_in:cashIn,cash_out:cashOut,expected_cash:money(money(session.opening_cash)+cashSales+cashIn-cashOut)};
}
async function resolveMethod(client:any,code:string){
 const c=String(code||'').trim().toLowerCase();
 const builtin:any={cash:{base:'cash'},card:{base:'card'},transfer:{base:'transfer'},voucher:{base:'voucher'},other:{base:'other'}};
 if(builtin[c])return{code:c,...builtin[c],config:null};
 const pm=(await client.query(`SELECT * FROM finance_payment_methods WHERE lower(code)=lower($1) AND active=true ORDER BY location_id NULLS LAST LIMIT 1`,[c])).rows[0];
 if(!pm)return null;
 const t=String(pm.method_type||'custom');const base=t==='cash'?'cash':t==='card'||t==='online_card'?'card':t==='bank_transfer'?'transfer':t==='voucher'?'voucher':'other';
 return{code:c,base,config:pm};
}
async function openSessionsForLocation(client:any,locationId:string){
 return (await client.query(`SELECT s.*,r.name register_name,r.register_type,r.financial_account_id FROM cash_register_sessions s JOIN cash_registers r ON r.id=s.register_id WHERE s.location_id=$1 AND s.status='open' ORDER BY r.sort_order,r.id`,[locationId])).rows;
}
async function resolveCashSession(client:any,locationId:string,registerId:any,methodConfig:any){
 let rid=String(registerId||'').trim();
 if(!rid&&methodConfig?.account_id){const mapped=(await client.query(`SELECT id FROM cash_registers WHERE location_id=$1 AND financial_account_id=$2::uuid AND is_active=true LIMIT 1`,[locationId,methodConfig.account_id])).rows[0];if(mapped)rid=String(mapped.id)}
 const open=await openSessionsForLocation(client,locationId);
 if(rid){const hit=open.find((s:any)=>String(s.register_id)===rid);if(!hit)throw Object.assign(new Error('A kiválasztott készpénztár nincs megnyitva.'),{status:409});return hit}
 if(open.length===0)throw Object.assign(new Error('Készpénzes fizetés előtt nyissa meg a pénztárt.'),{status:409});
 if(open.length>1)throw Object.assign(new Error('Több nyitott pénztár van. Válassza ki, melyik kasszába kerül a készpénz.'),{status:409});
 return open[0];
}

router.get('/payment-methods',async(req:AuthRequest,res,next)=>{try{
 const loc=locationFrom(req);const {rows}=await db.query(`SELECT pm.*,r.id default_register_id,r.name default_register_name FROM finance_payment_methods pm LEFT JOIN cash_registers r ON r.financial_account_id=pm.account_id AND r.location_id=$1 WHERE pm.active=true AND (pm.location_id IS NULL OR pm.location_id=$1) ORDER BY pm.sort_order,pm.name`,[loc]);res.json(rows)
}catch(e){next(e)}});

router.get('/registers',async(req:AuthRequest,res,next)=>{try{
 const loc=locationFrom(req);if(!loc)return res.status(400).json({message:'Válasszon telephelyet.'});
 const rows=(await db.query(`SELECT r.*,s.id open_session_id,s.opened_at,s.opened_by,s.business_date,s.opening_cash,s.shift_no FROM cash_registers r LEFT JOIN cash_register_sessions s ON s.register_id=r.id AND s.status='open' WHERE r.location_id=$1 ORDER BY r.is_active DESC,r.sort_order,r.name`,[loc])).rows;res.json(rows)
}catch(e){next(e)}});
router.post('/registers',async(req:AuthRequest,res,next)=>{try{
 const loc=locationFrom(req),name=String(req.body?.name||'').trim(),type=String(req.body?.register_type||'cash').trim();if(!loc||!name)return res.status(400).json({message:'Telephely és pénztárnév szükséges.'});if(!['cash','cashless'].includes(type))return res.status(400).json({message:'A pénztár típusa cash vagy cashless lehet.'});
 const row=(await db.query(`INSERT INTO cash_registers(location_id,name,register_type,opening_balance,comment,external_code,sort_order,financial_account_id,is_active) VALUES($1,$2,$3,$4,$5,$6,$7,$8::uuid,true) RETURNING *`,[loc,name,type,Math.max(0,money(req.body?.opening_balance)),req.body?.comment||null,req.body?.external_code||null,Number(req.body?.sort_order||100),req.body?.financial_account_id||null])).rows[0];res.status(201).json(row)
}catch(e){next(e)}});
router.patch('/registers/:id',async(req:AuthRequest,res,next)=>{try{
 const loc=locationFrom(req);const row=(await db.query(`UPDATE cash_registers SET name=COALESCE(NULLIF($3,''),name),register_type=COALESCE(NULLIF($4,''),register_type),opening_balance=COALESCE($5,opening_balance),comment=COALESCE($6,comment),sort_order=COALESCE($7,sort_order),financial_account_id=COALESCE($8::uuid,financial_account_id),is_active=COALESCE($9,is_active),updated_at=now() WHERE id=$1 AND location_id=$2 RETURNING *`,[req.params.id,loc,String(req.body?.name||''),String(req.body?.register_type||''),req.body?.opening_balance==null?null:money(req.body.opening_balance),req.body?.comment??null,req.body?.sort_order==null?null:Number(req.body.sort_order),req.body?.financial_account_id||null,req.body?.is_active==null?null:Boolean(req.body.is_active)])).rows[0];if(!row)return res.status(404).json({message:'Pénztár nem található.'});res.json(row)
}catch(e){next(e)}});

router.get('/register-state',async(req:AuthRequest,res,next)=>{try{
 const loc=locationFrom(req);if(!loc)return res.status(400).json({message:'A pénztár használatához válasszon telephelyet.'});
 const c=await db.connect();try{await c.query('BEGIN');let register:any;if(req.query.register_id)register=(await c.query(`SELECT * FROM cash_registers WHERE id=$1 AND location_id=$2`,[req.query.register_id,loc])).rows[0];else register=await ensureDefaultRegister(c,loc);if(!register){await c.query('ROLLBACK');return res.status(404).json({message:'Pénztár nem található.'})}
 const session=(await c.query(`SELECT * FROM cash_register_sessions WHERE register_id=$1 AND status='open' ORDER BY opened_at DESC LIMIT 1`,[register.id])).rows[0]||null;
 const registers=(await c.query(`SELECT r.*,s.id open_session_id,s.opened_at,s.opened_by,s.shift_no FROM cash_registers r LEFT JOIN cash_register_sessions s ON s.register_id=r.id AND s.status='open' WHERE r.location_id=$1 AND r.is_active=true ORDER BY r.sort_order,r.name`,[loc])).rows;
 const movements=session?(await c.query(`SELECT * FROM cash_movements WHERE session_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100`,[session.id])).rows:[];
 const counts=session?(await c.query(`SELECT * FROM cash_register_counts WHERE session_id=$1 ORDER BY created_at DESC,id DESC LIMIT 30`,[session.id])).rows:[];
 const totals=session?await sessionExpected(c,session):{cash_sales:0,cash_in:0,cash_out:0,expected_cash:money(register.opening_balance)};
 await c.query('COMMIT');res.json({location_id:loc,business_date:businessDate(req.query.date),register,registers,session,movements,counts,...totals})
 }catch(e){await c.query('ROLLBACK').catch(()=>undefined);throw e}finally{c.release()}
}catch(e){next(e)}});

router.post('/sessions/open',async(req:AuthRequest,res,next)=>{const c=await db.connect();try{
 const loc=locationFrom(req);if(!loc)return res.status(400).json({message:'A pénztárnyitáshoz válasszon telephelyet.'});const date=businessDate(req.body?.business_date);await c.query('BEGIN');
 let register:any;if(req.body?.register_id)register=(await c.query(`SELECT * FROM cash_registers WHERE id=$1 AND location_id=$2 AND is_active=true FOR UPDATE`,[req.body.register_id,loc])).rows[0];else register=await ensureDefaultRegister(c,loc);if(!register){await c.query('ROLLBACK');return res.status(404).json({message:'Pénztár nem található.'})}
 const opened=(await c.query(`SELECT * FROM cash_register_sessions WHERE register_id=$1 AND status='open' FOR UPDATE`,[register.id])).rows[0];if(opened){await c.query('ROLLBACK');return res.status(409).json({message:'Ez a pénztár már nyitva van.',session:opened})}
 const count=countDenominations(req.body?.denominations);const opening=req.body?.opening_cash==null?(count.total||money(register.opening_balance)):Math.max(0,money(req.body.opening_cash));
 const shift=Number((await c.query(`SELECT COALESCE(MAX(shift_no),0)+1 n FROM cash_register_sessions WHERE register_id=$1 AND business_date=$2::date`,[register.id,date])).rows[0]?.n||1);
 const session=(await c.query(`INSERT INTO cash_register_sessions(register_id,location_id,business_date,opening_cash,status,opened_by,note,shift_no) VALUES($1,$2,$3,$4,'open',$5,$6,$7) RETURNING *`,[register.id,loc,date,opening,actor(req),req.body?.note||null,shift])).rows[0];
 await c.query(`INSERT INTO cash_register_counts(register_id,session_id,location_id,business_date,count_type,denominations,counted_cash,expected_cash,difference,note,created_by) VALUES($1,$2,$3,$4,'opening',$5::jsonb,$6,$6,0,$7,$8)`,[register.id,session.id,loc,date,JSON.stringify(count.denominations),opening,req.body?.note||null,actor(req)]);
 await c.query('COMMIT');res.status(201).json({register,session})
}catch(e){await c.query('ROLLBACK').catch(()=>undefined);next(e)}finally{c.release()}});

router.post('/cash-movements',async(req:AuthRequest,res,next)=>{const c=await db.connect();try{
 const loc=locationFrom(req),sid=String(req.body?.session_id||'').trim(),direction=String(req.body?.direction||'').trim(),amount=money(req.body?.amount),reason=String(req.body?.reason||'').trim();if(!loc||!sid)return res.status(400).json({message:'Aktív pénztárműszak szükséges.'});if(!['in','out'].includes(direction)||!(amount>0)||reason.length<3)return res.status(400).json({message:'Érvényes irány, pozitív összeg és indok szükséges.'});await c.query('BEGIN');
 const session=(await c.query(`SELECT * FROM cash_register_sessions WHERE id=$1 AND location_id=$2 FOR UPDATE`,[sid,loc])).rows[0];if(!session||session.status!=='open'){await c.query('ROLLBACK');return res.status(409).json({message:'A pénztárműszak nem nyitott.'})}
 const row=(await c.query(`INSERT INTO cash_movements(session_id,location_id,register_id,direction,amount,reason,movement_type,reference_no,partner_id,employee_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,[session.id,loc,session.register_id,direction,amount,reason,String(req.body?.movement_type||'manual'),req.body?.reference_no||null,req.body?.partner_id||null,req.body?.employee_id||null,actor(req)])).rows[0];await c.query('COMMIT');res.status(201).json(row)
}catch(e){await c.query('ROLLBACK').catch(()=>undefined);next(e)}finally{c.release()}});

router.post('/sessions/:id/check',async(req:AuthRequest,res,next)=>{const c=await db.connect();try{
 const loc=locationFrom(req),kind=String(req.body?.count_type||'check');if(!['check','handover'].includes(kind))return res.status(400).json({message:'Az ellenőrzés típusa check vagy handover lehet.'});await c.query('BEGIN');
 const session=(await c.query(`SELECT s.*,r.register_type FROM cash_register_sessions s JOIN cash_registers r ON r.id=s.register_id WHERE s.id=$1 AND s.location_id=$2 FOR UPDATE`,[req.params.id,loc])).rows[0];if(!session||session.status!=='open'){await c.query('ROLLBACK');return res.status(409).json({message:'A pénztárműszak nem nyitott.'})}
 const totals=await sessionExpected(c,session),count=countDenominations(req.body?.denominations);const counted=req.body?.counted_cash==null?count.total:Math.max(0,money(req.body.counted_cash));const diff=money(counted-totals.expected_cash);const handedTo=String(req.body?.handed_to||'').trim()||null;if(kind==='handover'&&!handedTo){await c.query('ROLLBACK');return res.status(400).json({message:'Pénztárátadásnál adja meg az átvevő pénztárost.'})}
 const check=(await c.query(`INSERT INTO cash_register_counts(register_id,session_id,location_id,business_date,count_type,denominations,counted_cash,expected_cash,difference,note,handed_to,created_by) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12) RETURNING *`,[session.register_id,session.id,loc,session.business_date,kind,JSON.stringify(count.denominations),counted,totals.expected_cash,diff,req.body?.note||null,handedTo,actor(req)])).rows[0];
 let nextSession=null;if(kind==='handover'){await c.query(`UPDATE cash_register_sessions SET status='closed',counted_cash=$2,expected_cash=$3,difference=$4,closed_by=$5,closed_at=now(),handed_to=$6 WHERE id=$1`,[session.id,counted,totals.expected_cash,diff,actor(req),handedTo]);nextSession=(await c.query(`INSERT INTO cash_register_sessions(register_id,location_id,business_date,opening_cash,status,opened_by,note,shift_no,handover_from_session_id) VALUES($1,$2,$3,$4,'open',$5,$6,$7,$8) RETURNING *`,[session.register_id,loc,session.business_date,counted,handedTo,`Pénztárátadás: ${actor(req)} → ${handedTo}`,Number(session.shift_no||1)+1,session.id])).rows[0]}
 await c.query('COMMIT');res.status(201).json({check,next_session:nextSession,...totals})
}catch(e){await c.query('ROLLBACK').catch(()=>undefined);next(e)}finally{c.release()}});

router.post('/transfers',async(req:AuthRequest,res,next)=>{const c=await db.connect();try{
 const loc=locationFrom(req),from=String(req.body?.from_register_id||''),to=String(req.body?.to_register_id||''),amount=money(req.body?.amount);if(!loc||!from||!to||!(amount>0)||from===to)return res.status(400).json({message:'Két külön pénztár és pozitív összeg szükséges.'});await c.query('BEGIN');
 const regs=(await c.query(`SELECT * FROM cash_registers WHERE location_id=$1 AND id=ANY($2::bigint[]) FOR UPDATE`,[loc,[Number(from),Number(to)]])).rows;if(regs.length!==2){await c.query('ROLLBACK');return res.status(404).json({message:'Az egyik pénztár nem található.'})}
 const sessions=await openSessionsForLocation(c,loc);const fs=sessions.find((x:any)=>String(x.register_id)===from),ts=sessions.find((x:any)=>String(x.register_id)===to);if(!fs||!ts){await c.query('ROLLBACK');return res.status(409).json({message:'Átvezetéshez mindkét pénztárnak nyitva kell lennie.'})}
 const tr=(await c.query(`INSERT INTO cash_register_transfers(location_id,from_register_id,to_register_id,amount,reference_no,note,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[loc,from,to,amount,req.body?.reference_no||null,req.body?.note||null,actor(req)])).rows[0];
 await c.query(`INSERT INTO cash_movements(session_id,location_id,register_id,direction,amount,reason,movement_type,reference_no,transfer_id,created_by) VALUES($1,$2,$3,'out',$4,$5,'transfer',$6,$7,$8),($9,$2,$10,'in',$4,$5,'transfer',$6,$7,$8)`,[fs.id,loc,from,amount,req.body?.note||'Pénztárközi átvezetés',req.body?.reference_no||null,tr.id,actor(req),ts.id,to]);await c.query('COMMIT');res.status(201).json(tr)
}catch(e){await c.query('ROLLBACK').catch(()=>undefined);next(e)}finally{c.release()}});

router.post('/register-daily-close',async(req:AuthRequest,res,next)=>{const c=await db.connect();try{
 const loc=locationFrom(req),registerId=String(req.body?.register_id||'').trim();if(!loc)return res.status(400).json({message:'A napi záráshoz válasszon telephelyet.'});await c.query('BEGIN');
 let session:any;if(registerId)session=(await c.query(`SELECT * FROM cash_register_sessions WHERE register_id=$1 AND location_id=$2 AND status='open' FOR UPDATE`,[registerId,loc])).rows[0];else{const open=await openSessionsForLocation(c,loc);if(open.length!==1){await c.query('ROLLBACK');return res.status(409).json({message:'Válassza ki a lezárandó pénztárt.'})}session=open[0]}if(!session){await c.query('ROLLBACK');return res.status(409).json({message:'A pénztár nincs nyitva.'})}
 const totals=await sessionExpected(c,session),count=countDenominations(req.body?.denominations);const counted=req.body?.counted_cash==null?count.total:Math.max(0,money(req.body.counted_cash));const diff=money(counted-totals.expected_cash);
 await c.query(`INSERT INTO cash_register_counts(register_id,session_id,location_id,business_date,count_type,denominations,counted_cash,expected_cash,difference,note,created_by) VALUES($1,$2,$3,$4,'closing',$5::jsonb,$6,$7,$8,$9,$10)`,[session.register_id,session.id,loc,session.business_date,JSON.stringify(count.denominations),counted,totals.expected_cash,diff,req.body?.note||null,actor(req)]);
 const other=(await c.query(`SELECT COALESCE(SUM(wp.amount) FILTER(WHERE wp.payment_method='card'),0)::numeric card,COALESCE(SUM(wp.amount) FILTER(WHERE wp.payment_method='transfer'),0)::numeric transfer,COALESCE(SUM(wp.amount) FILTER(WHERE wp.payment_method='voucher'),0)::numeric voucher,COALESCE(SUM(wp.amount) FILTER(WHERE wp.payment_method='other'),0)::numeric other FROM work_order_payments wp WHERE wp.register_session_id=$1`,[session.id])).rows[0]||{};
 const closing=(await c.query(`INSERT INTO cash_register_closings(location_id,business_date,register_id,session_id,opening_cash,cash_sales,card_sales,transfer_sales,voucher_sales,other_sales,expected_cash,counted_cash,difference,note,closed_by,cash_in,cash_out) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) ON CONFLICT(register_id,business_date) WHERE register_id IS NOT NULL DO UPDATE SET session_id=EXCLUDED.session_id,opening_cash=EXCLUDED.opening_cash,cash_sales=EXCLUDED.cash_sales,card_sales=EXCLUDED.card_sales,transfer_sales=EXCLUDED.transfer_sales,voucher_sales=EXCLUDED.voucher_sales,other_sales=EXCLUDED.other_sales,expected_cash=EXCLUDED.expected_cash,counted_cash=EXCLUDED.counted_cash,difference=EXCLUDED.difference,note=EXCLUDED.note,closed_by=EXCLUDED.closed_by,closed_at=now(),cash_in=EXCLUDED.cash_in,cash_out=EXCLUDED.cash_out RETURNING *`,[loc,session.business_date,session.register_id,session.id,money(session.opening_cash),totals.cash_sales,money(other.card),money(other.transfer),money(other.voucher),money(other.other),totals.expected_cash,counted,diff,req.body?.note||null,actor(req),totals.cash_in,totals.cash_out])).rows[0];
 const closed=(await c.query(`UPDATE cash_register_sessions SET status='closed',counted_cash=$2,expected_cash=$3,difference=$4,note=COALESCE($5,note),closed_by=$6,closed_at=now() WHERE id=$1 RETURNING *`,[session.id,counted,totals.expected_cash,diff,req.body?.note||null,actor(req)])).rows[0];await c.query('COMMIT');res.status(201).json({closing,session:closed,...totals})
}catch(e){await c.query('ROLLBACK').catch(()=>undefined);next(e)}finally{c.release()}});

router.get('/workorders/:id/payments',async(req:AuthRequest,res,next)=>{try{
 const rows=(await db.query(`SELECT wp.*,COALESCE((SELECT json_agg(r ORDER BY r.created_at) FROM work_order_payment_refunds r WHERE r.payment_id=wp.id),'[]'::json)::json refunds FROM work_order_payments wp WHERE wp.work_order_id::text=$1 ORDER BY wp.paid_at,wp.id`,[req.params.id])).rows;res.json(rows)
}catch(e){next(e)}});
router.post('/payments/:paymentId/refund',async(req:AuthRequest,res,next)=>{const c=await db.connect();try{
 const reason=String(req.body?.reason||'').trim(),requested=money(req.body?.amount);if(reason.length<3)return res.status(400).json({message:'A visszatérítés indoka kötelező.'});await c.query('BEGIN');
 const p=(await c.query(`SELECT wp.*,wo.location_id,wo.gross_total,wo.discount_amount,wo.tip_amount FROM work_order_payments wp JOIN work_orders wo ON wo.id=wp.work_order_id WHERE wp.id=$1 FOR UPDATE`,[req.params.paymentId])).rows[0];if(!p){await c.query('ROLLBACK');return res.status(404).json({message:'A fizetés nem található.'})}
 const remaining=money(Number(p.amount)-Number(p.refunded_amount||0)),amount=requested>0?Math.min(requested,remaining):remaining;if(!(amount>0)){await c.query('ROLLBACK');return res.status(409).json({message:'Ezt a fizetést már teljes egészében visszatérítették.'})}
 let session:any=null;if(String(p.payment_method)==='cash'){session=await resolveCashSession(c,String(p.location_id),req.body?.register_id||p.register_id,null)}
 const refund=(await c.query(`INSERT INTO work_order_payment_refunds(payment_id,work_order_id,location_id,register_id,register_session_id,amount,reason,refund_method,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[p.id,String(p.work_order_id),String(p.location_id),session?.register_id||p.register_id||null,session?.id||null,amount,reason,String(p.payment_method),actor(req)])).rows[0];
 await c.query(`UPDATE work_order_payments SET refunded_amount=refunded_amount+$2 WHERE id=$1`,[p.id,amount]);if(session)await c.query(`INSERT INTO cash_movements(session_id,location_id,register_id,direction,amount,reason,movement_type,work_order_id,payment_id,created_by) VALUES($1,$2,$3,'out',$4,$5,'refund',$6,$7,$8)`,[session.id,String(p.location_id),session.register_id,amount,reason,String(p.work_order_id),p.id,actor(req)]);
 const paid=money((await c.query(`SELECT COALESCE(SUM(amount-refunded_amount),0)::numeric paid FROM work_order_payments WHERE work_order_id=$1`,[p.work_order_id])).rows[0]?.paid),due=Math.max(0,money(Number(p.gross_total||0)-Number(p.discount_amount||0)+Number(p.tip_amount||0)));const refundCount=Number((await c.query(`SELECT count(*) n FROM work_order_payment_refunds WHERE work_order_id=$1`,[String(p.work_order_id)])).rows[0]?.n||0);const status=paid<=0&&refundCount>0?'refunded':paid<=0?'unpaid':paid+.009<due?'partial':'paid';await c.query(`UPDATE work_orders SET amount_paid=$2,payment_status=$3,fully_paid=($3='paid'),updated_at=now() WHERE id=$1`,[p.work_order_id,paid,status]);
 await c.query('COMMIT');res.status(201).json({refund,amount_paid:paid,payment_status:status})
}catch(e:any){await c.query('ROLLBACK').catch(()=>undefined);if(e?.status)return res.status(e.status).json({message:e.message});next(e)}finally{c.release()}});

// Cash payment guard: cash cannot be posted without an open till. It also resolves
// the physical register/session so the payment is auditable and later countable.
router.post('/workorders/:id/settle',async(req:AuthRequest,res,next)=>{const c=await db.connect();try{
 const incoming=Array.isArray(req.body?.payments)?req.body.payments:[];if(!incoming.length)return next();const wo=(await c.query(`SELECT location_id FROM work_orders WHERE id::text=$1`,[req.params.id])).rows[0];if(!wo)return next();const loc=String(wo.location_id||locationFrom(req));
 for(const p of incoming){const resolved=await resolveMethod(c,String(p?.payment_method_code||p?.payment_method||''));if(!resolved)throw Object.assign(new Error(`Ismeretlen fizetési mód: ${p?.payment_method_code||p?.payment_method}`),{status:400});p.payment_method_code=resolved.code;p.payment_method=resolved.base;if(resolved.base==='cash'){const s=await resolveCashSession(c,loc,p.register_id||req.body?.register_id,resolved.config);p.register_id=s.register_id;p.register_session_id=s.id;req.body.register_id=s.register_id;req.body.register_session_id=s.id}else if(!p.register_id&&resolved.config?.account_id){const mapped=(await c.query(`SELECT id FROM cash_registers WHERE location_id=$1 AND financial_account_id=$2::uuid AND is_active=true LIMIT 1`,[loc,resolved.config.account_id])).rows[0];if(mapped)p.register_id=mapped.id}if(resolved.config){const brand=String(p.card_brand||'');const brandFee=brand&&resolved.config.brand_fees?.[brand]!=null?Number(resolved.config.brand_fees[brand]):Number(resolved.config.fee_percent||0);p.fee_amount=money(Number(p.amount||0)*brandFee/100+Number(resolved.config.fee_fixed||0))}}
 next()
}catch(e:any){if(e?.status)return res.status(e.status).json({message:e.message});next(e)}finally{c.release()}});

export default router;
