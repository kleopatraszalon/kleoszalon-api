import {Router} from 'express';
import db from '../db';
import {requireAuth,type AuthRequest} from '../middleware/auth';

const router=Router();
router.use(requireAuth);
const actor=(req:AuthRequest)=>req.user?.email||String(req.user?.id||'');

router.post('/workorders/:id/settle',async(req:AuthRequest,res,next)=>{
 try{
  const payments=Array.isArray(req.body?.payments)?req.body.payments:[];
  const cash=payments.find((p:any)=>String(p?.payment_method||'').toLowerCase()==='cash'&&p?.register_id&&p?.register_session_id);
  if(!cash)return next();
  const locationId=String(req.user?.location_id||req.body?.location_id||'').trim()||String((await db.query(`SELECT location_id FROM work_orders WHERE id::text=$1`,[req.params.id])).rows[0]?.location_id||'');
  if(!locationId)return next();
  await db.query(`INSERT INTO cashier_checkout_context(work_order_id,location_id,register_id,register_session_id,created_by,expires_at,created_at)
   VALUES($1,$2,$3,$4,$5,now()+interval '5 minutes',now())
   ON CONFLICT(work_order_id) DO UPDATE SET location_id=EXCLUDED.location_id,register_id=EXCLUDED.register_id,register_session_id=EXCLUDED.register_session_id,created_by=EXCLUDED.created_by,expires_at=EXCLUDED.expires_at,created_at=now()`,
   [req.params.id,locationId,cash.register_id,cash.register_session_id,actor(req)]);
  next();
 }catch(e){next(e)}
});

export default router;
