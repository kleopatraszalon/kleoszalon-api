import {Router} from 'express';
import db from '../db';
import {requireAuth,type AuthRequest} from '../middleware/auth';
const router=Router();router.use(requireAuth);

router.get('/register-history',async(req:AuthRequest,res,next)=>{try{
 const locationId=String(req.query.location_id||req.user?.location_id||'').trim();const registerId=String(req.query.register_id||'').trim();const date=String(req.query.date||'').trim()||new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Budapest',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 if(!locationId||!registerId)return res.status(400).json({message:'Telephely és pénztár szükséges.'});
 const register=(await db.query(`SELECT * FROM cash_registers WHERE id=$1 AND location_id=$2`,[registerId,locationId])).rows[0];if(!register)return res.status(404).json({message:'Pénztár nem található.'});
 const counts=(await db.query(`SELECT c.*,s.shift_no,s.opened_by,s.closed_by FROM cash_register_counts c JOIN cash_register_sessions s ON s.id=c.session_id WHERE c.register_id=$1 AND c.business_date=$2::date ORDER BY c.created_at`,[registerId,date])).rows;
 const sessions=(await db.query(`SELECT * FROM cash_register_sessions WHERE register_id=$1 AND business_date=$2::date ORDER BY shift_no,opened_at`,[registerId,date])).rows;
 const previous=(await db.query(`SELECT c.*,s.shift_no FROM cash_register_counts c JOIN cash_register_sessions s ON s.id=c.session_id WHERE c.register_id=$1 AND c.business_date<$2::date AND c.count_type='closing' ORDER BY c.business_date DESC,c.created_at DESC LIMIT 1`,[registerId,date])).rows[0]||null;
 const closing=(await db.query(`SELECT * FROM cash_register_closings WHERE register_id=$1 AND business_date=$2::date ORDER BY closed_at DESC LIMIT 1`,[registerId,date])).rows[0]||null;
 res.json({business_date:date,register,counts,sessions,previous_closing_count:previous,closing});
}catch(e){next(e)}});

export default router;
