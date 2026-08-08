import {Router} from 'express';
import db from '../db';
import {requireAuth} from '../middleware/auth';
const router=Router();
router.use(requireAuth);
router.post('/record',async(req,res,next)=>{try{const employeeId=String(req.body?.employee_id||'').trim();const base=Math.max(0,Number(req.body?.base_amount||0));if(!employeeId||!base)return res.status(400).json({message:'Dolgozó és pozitív jutalékalap szükséges.'});const{rows}=await db.query(`INSERT INTO loyalty_commission_events(employee_id,work_order_id,source_type,source_id,base_amount,note) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(employee_id,source_type,source_id,work_order_id) DO UPDATE SET base_amount=EXCLUDED.base_amount,note=EXCLUDED.note RETURNING *`,[employeeId,req.body?.work_order_id||null,String(req.body?.source_type||'loyalty'),req.body?.source_id||null,base,req.body?.note||null]);res.status(201).json(rows[0])}catch(err){next(err)}});
router.get('/',async(req,res,next)=>{try{const employeeId=String(req.query.employee_id||'').trim();const{rows}=await db.query(`SELECT * FROM loyalty_commission_events WHERE ($1='' OR employee_id=$1) ORDER BY created_at DESC LIMIT 300`,[employeeId]);res.json(rows)}catch(err){next(err)}});
export default router;
