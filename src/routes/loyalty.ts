import { Router } from 'express';
import db from '../db';
import { requireAuth, AuthRequest } from '../middleware/auth';

const router = Router();
router.use(requireAuth);
const actor=(req:AuthRequest)=>req.user?.email||String(req.user?.id||'');
const idempotencyKey=(req:AuthRequest)=>String(req.get('Idempotency-Key')||req.body?.idempotency_key||'').trim();

router.get('/summary', async (_req,res,next)=>{try{const {rows}=await db.query(`SELECT (SELECT COUNT(*)::int FROM loyalty_accounts WHERE status='active') active_accounts,(SELECT COALESCE(SUM(balance),0) FROM loyalty_accounts WHERE status='active') total_balance,(SELECT COALESCE(SUM(points),0) FROM loyalty_accounts WHERE status='active') total_points,(SELECT COUNT(*)::int FROM loyalty_passes WHERE status='active' AND (valid_until IS NULL OR valid_until>=CURRENT_DATE)) active_passes,(SELECT COUNT(*)::int FROM loyalty_coupons WHERE active=true) active_coupons,(SELECT COUNT(*)::int FROM loyalty_vouchers WHERE status='active' AND remaining_value>0) active_vouchers`);res.json(rows[0])}catch(err){next(err)}});
router.get('/accounts', async (req,res,next)=>{try{const q=String(req.query.q||'').trim();const {rows}=await db.query(`SELECT a.* FROM loyalty_accounts a WHERE ($1='' OR a.customer_id ILIKE '%'||$1||'%' OR COALESCE(a.card_identifier,'') ILIKE '%'||$1||'%') ORDER BY a.updated_at DESC LIMIT 200`,[q]);res.json(rows)}catch(err){next(err)}});
router.post('/accounts', async (req:AuthRequest,res,next)=>{try{const customerId=String(req.body?.customer_id||'').trim();if(!customerId)return res.status(400).json({message:'customer_id kötelező'});const {rows}=await db.query(`INSERT INTO loyalty_accounts(customer_id,card_identifier,external_identifier) VALUES($1,$2,$3) ON CONFLICT(customer_id) DO UPDATE SET card_identifier=COALESCE(EXCLUDED.card_identifier,loyalty_accounts.card_identifier), external_identifier=COALESCE(EXCLUDED.external_identifier,loyalty_accounts.external_identifier), updated_at=now() RETURNING *`,[customerId,req.body?.card_identifier||null,req.body?.external_identifier||null]);res.status(201).json(rows[0])}catch(err){next(err)}});

router.post('/accounts/:id/topup', async (req:AuthRequest,res,next)=>{const client=await db.connect();try{
 const amount=Number(req.body?.amount||0),key=idempotencyKey(req);if(!(amount>0))return res.status(400).json({message:'A feltöltési összeg legyen pozitív.'});if(!key)return res.status(400).json({message:'Idempotency-Key kötelező.',code:'LOYALTY_TOPUP_IDEMPOTENCY_REQUIRED'});
 await client.query('BEGIN');
 const account=await client.query(`SELECT * FROM loyalty_accounts WHERE id=$1::uuid FOR UPDATE`,[req.params.id]);if(!account.rows[0]){await client.query('ROLLBACK');return res.status(404).json({message:'Hűségszámla nem található.'})}
 const existing=await client.query(`SELECT t.id transaction_id,t.amount,t.created_at,s.id sale_id FROM loyalty_transactions t LEFT JOIN loyalty_sales s ON s.sale_type='wallet_topup' AND s.reference_id=t.id::text WHERE t.account_id=$1::uuid AND t.transaction_type='balance_topup' AND t.reference_type='topup' AND t.reference_id=$2 LIMIT 1 FOR UPDATE`,[req.params.id,key]);
 if(existing.rows[0]){await client.query('COMMIT');return res.json({account:account.rows[0],transaction:existing.rows[0],idempotent:true});}
 const acc=await client.query(`UPDATE loyalty_accounts SET balance=balance+$2,updated_at=now() WHERE id=$1::uuid RETURNING *`,[req.params.id,amount]);
 const tx=await client.query(`INSERT INTO loyalty_transactions(account_id,transaction_type,amount,work_order_id,reference_type,reference_id,note,created_by) VALUES($1,'balance_topup',$2,$3,'topup',$4,$5,$6) RETURNING id,amount,created_at`,[req.params.id,amount,req.body?.work_order_id||null,key,req.body?.note||null,actor(req)]);
 await client.query(`INSERT INTO loyalty_sales(sale_type,reference_id,account_id,customer_id,employee_id,work_order_id,gross_amount,commission_base,revenue_recognized,note,created_by) VALUES('wallet_topup',$1,$2,$3,$4,$5,$6,$6,true,$7,$8) ON CONFLICT DO NOTHING`,[String(tx.rows[0].id),req.params.id,acc.rows[0].customer_id,req.body?.employee_id||null,req.body?.work_order_id||null,amount,req.body?.note||null,actor(req)]);
 await client.query('COMMIT');res.json({account:acc.rows[0],transaction:tx.rows[0],idempotent:false});
}catch(err){await client.query('ROLLBACK');next(err)}finally{client.release()}});

router.get('/accounts/:id/transactions',async(req,res,next)=>{try{const{rows}=await db.query(`SELECT * FROM loyalty_transactions WHERE account_id=$1::uuid ORDER BY created_at DESC LIMIT 250`,[req.params.id]);res.json(rows)}catch(err){next(err)}});

// The remaining loyalty administration endpoints are delegated to the existing
// operation modules. This router intentionally keeps account/top-up ownership
// here so financial idempotency is enforced at the balance mutation boundary.
export default router;
