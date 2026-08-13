import {Router} from 'express';
import db from '../db';
import {requireAuth,type AuthRequest} from '../middleware/auth';

const router=Router();router.use(requireAuth);
const actor=(req:AuthRequest)=>req.user?.email||String(req.user?.id||'');
const localDate=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Budapest',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());

router.get('/register-history',async(req:AuthRequest,res,next)=>{try{
  const locationId=String(req.query.location_id||req.user?.location_id||'').trim(),registerId=String(req.query.register_id||'').trim(),date=String(req.query.date||'').trim()||localDate();
  if(!locationId||!registerId)return res.status(400).json({message:'Telephely és pénztár szükséges.'});
  const register=(await db.query(`SELECT * FROM cash_registers WHERE id=$1 AND location_id=$2`,[registerId,locationId])).rows[0];
  if(!register)return res.status(404).json({message:'Pénztár nem található.'});
  const counts=(await db.query(`SELECT c.*,s.shift_no,s.opened_by,s.closed_by FROM cash_register_counts c JOIN cash_register_sessions s ON s.id=c.session_id WHERE c.register_id=$1 AND c.business_date=$2::date ORDER BY c.created_at`,[registerId,date])).rows;
  const sessions=(await db.query(`SELECT * FROM cash_register_sessions WHERE register_id=$1 AND business_date=$2::date ORDER BY shift_no,opened_at`,[registerId,date])).rows;
  const previous=(await db.query(`SELECT c.*,s.shift_no FROM cash_register_counts c JOIN cash_register_sessions s ON s.id=c.session_id WHERE c.register_id=$1 AND c.business_date<$2::date AND c.count_type='closing' ORDER BY c.business_date DESC,c.created_at DESC LIMIT 1`,[registerId,date])).rows[0]||null;
  res.json({business_date:date,register,counts,sessions,previous_closing_count:previous,closing:counts.find((c:any)=>c.count_type==='closing')||null});
}catch(error){next(error)}});

router.post('/workorders/:id/settle',async(req:AuthRequest,_res,next)=>{try{
  const payments=Array.isArray(req.body?.payments)?req.body.payments:[];
  const cash=payments.find((p:any)=>String(p?.payment_method||'').toLowerCase()==='cash'&&p?.register_id&&p?.register_session_id);
  if(!cash)return next();
  const locationId=String(req.user?.location_id||req.body?.location_id||'').trim()||String((await db.query(`SELECT location_id FROM work_orders WHERE id::text=$1`,[req.params.id])).rows[0]?.location_id||'');
  if(!locationId)return next();
  await db.query(`INSERT INTO cashier_checkout_context(work_order_id,location_id,register_id,register_session_id,created_by,expires_at,created_at) VALUES($1,$2,$3,$4,$5,now()+interval '5 minutes',now()) ON CONFLICT(work_order_id) DO UPDATE SET location_id=EXCLUDED.location_id,register_id=EXCLUDED.register_id,register_session_id=EXCLUDED.register_session_id,created_by=EXCLUDED.created_by,expires_at=EXCLUDED.expires_at,created_at=now()`,[req.params.id,locationId,cash.register_id,cash.register_session_id,actor(req)]);
  next();
}catch(error){next(error)}});

export default router;
