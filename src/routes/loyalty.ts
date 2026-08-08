import { Router } from 'express';
import db from '../db';
import { requireAuth, AuthRequest } from '../middleware/auth';

const router = Router();
router.use(requireAuth);
const actor=(req:AuthRequest)=>req.user?.email||String(req.user?.id||'');

router.get('/summary', async (_req,res,next)=>{try{
  const {rows}=await db.query(`SELECT
    (SELECT COUNT(*)::int FROM loyalty_accounts WHERE status='active') active_accounts,
    (SELECT COALESCE(SUM(balance),0) FROM loyalty_accounts WHERE status='active') total_balance,
    (SELECT COALESCE(SUM(points),0) FROM loyalty_accounts WHERE status='active') total_points,
    (SELECT COUNT(*)::int FROM loyalty_passes WHERE status='active' AND (valid_until IS NULL OR valid_until>=CURRENT_DATE)) active_passes,
    (SELECT COUNT(*)::int FROM loyalty_coupons WHERE active=true) active_coupons,
    (SELECT COUNT(*)::int FROM loyalty_vouchers WHERE status='active' AND remaining_value>0) active_vouchers`);
  res.json(rows[0]);
}catch(err){next(err)}});

router.get('/accounts', async (req,res,next)=>{try{
  const q=String(req.query.q||'').trim();
  const {rows}=await db.query(`SELECT a.* FROM loyalty_accounts a WHERE ($1='' OR a.customer_id ILIKE '%'||$1||'%' OR COALESCE(a.card_identifier,'') ILIKE '%'||$1||'%') ORDER BY a.updated_at DESC LIMIT 200`,[q]);
  res.json(rows);
}catch(err){next(err)}});

router.post('/accounts', async (req:AuthRequest,res,next)=>{try{
  const customerId=String(req.body?.customer_id||'').trim(); if(!customerId)return res.status(400).json({message:'customer_id kötelező'});
  const {rows}=await db.query(`INSERT INTO loyalty_accounts(customer_id,card_identifier,external_identifier) VALUES($1,$2,$3) ON CONFLICT(customer_id) DO UPDATE SET card_identifier=COALESCE(EXCLUDED.card_identifier,loyalty_accounts.card_identifier), external_identifier=COALESCE(EXCLUDED.external_identifier,loyalty_accounts.external_identifier), updated_at=now() RETURNING *`,[customerId,req.body?.card_identifier||null,req.body?.external_identifier||null]);
  res.status(201).json(rows[0]);
}catch(err){next(err)}});

router.post('/accounts/:id/topup', async (req:AuthRequest,res,next)=>{const client=await db.connect();try{
  const amount=Number(req.body?.amount||0); if(!(amount>0))return res.status(400).json({message:'A feltöltési összeg legyen pozitív.'});
  await client.query('BEGIN');
  const acc=await client.query(`UPDATE loyalty_accounts SET balance=balance+$2,updated_at=now() WHERE id=$1::uuid RETURNING *`,[req.params.id,amount]);
  if(!acc.rows[0]){await client.query('ROLLBACK');return res.status(404).json({message:'Hűségszámla nem található.'})}
  await client.query(`INSERT INTO loyalty_transactions(account_id,transaction_type,amount,work_order_id,reference_type,reference_id,note,created_by) VALUES($1,'balance_topup',$2,$3,'topup',$4,$5,$6)`,[req.params.id,amount,req.body?.work_order_id||null,req.body?.reference_id||null,req.body?.note||null,actor(req)]);
  await client.query('COMMIT'); res.json(acc.rows[0]);
}catch(err){await client.query('ROLLBACK');next(err)}finally{client.release()}});

router.get('/accounts/:id/transactions',async(req,res,next)=>{try{const{rows}=await db.query(`SELECT * FROM loyalty_transactions WHERE account_id=$1::uuid ORDER BY created_at DESC LIMIT 250`,[req.params.id]);res.json(rows)}catch(err){next(err)}});

router.get('/pass-types',async(_req,res,next)=>{try{const{rows}=await db.query(`SELECT p.*,COALESCE(json_agg(json_build_object('service_id',s.service_id,'quantity',s.quantity)) FILTER(WHERE s.id IS NOT NULL),'[]') services FROM loyalty_pass_types p LEFT JOIN loyalty_pass_type_services s ON s.pass_type_id=p.id GROUP BY p.id ORDER BY p.name`);res.json(rows)}catch(err){next(err)}});
router.post('/pass-types',async(req,res,next)=>{const client=await db.connect();try{await client.query('BEGIN');const r=await client.query(`INSERT INTO loyalty_pass_types(name,product_id,valid_days,validity_start_mode) VALUES($1,$2,$3,$4) RETURNING *`,[req.body?.name,req.body?.product_id||null,req.body?.valid_days||null,req.body?.validity_start_mode||'sale']);for(const s of (req.body?.services||[]))await client.query(`INSERT INTO loyalty_pass_type_services(pass_type_id,service_id,quantity) VALUES($1,$2,$3)`,[r.rows[0].id,String(s.service_id),Number(s.quantity||1)]);await client.query('COMMIT');res.status(201).json(r.rows[0])}catch(err){await client.query('ROLLBACK');next(err)}finally{client.release()}});

router.get('/passes',async(_req,res,next)=>{try{const{rows}=await db.query(`SELECT p.*,t.name pass_type_name,a.customer_id FROM loyalty_passes p JOIN loyalty_pass_types t ON t.id=p.pass_type_id JOIN loyalty_accounts a ON a.id=p.account_id ORDER BY p.created_at DESC LIMIT 250`);res.json(rows)}catch(err){next(err)}});
router.post('/passes',async(req,res,next)=>{const client=await db.connect();try{await client.query('BEGIN');const type=await client.query(`SELECT * FROM loyalty_pass_types WHERE id=$1::uuid`,[req.body?.pass_type_id]);if(!type.rows[0])throw new Error('Bérlettípus nem található');const from=req.body?.valid_from||new Date().toISOString().slice(0,10);const until=type.rows[0].valid_days?`(${client.escapeLiteral?.(from) || `'${from}'`})`:null;const r=await client.query(`INSERT INTO loyalty_passes(account_id,pass_type_id,valid_from,valid_until) VALUES($1::uuid,$2::uuid,$3::date,CASE WHEN $4::int IS NULL THEN NULL ELSE ($3::date + $4::int) END) RETURNING *`,[req.body?.account_id,req.body?.pass_type_id,from,type.rows[0].valid_days]);await client.query(`INSERT INTO loyalty_pass_balances(pass_id,service_id,original_quantity,remaining_quantity) SELECT $1,service_id,quantity,quantity FROM loyalty_pass_type_services WHERE pass_type_id=$2`,[r.rows[0].id,req.body?.pass_type_id]);await client.query('COMMIT');res.status(201).json(r.rows[0])}catch(err){await client.query('ROLLBACK');next(err)}finally{client.release()}});

router.get('/coupon-campaigns',async(_req,res,next)=>{try{const{rows}=await db.query(`SELECT c.*,COUNT(x.id)::int code_count FROM loyalty_coupon_campaigns c LEFT JOIN loyalty_coupons x ON x.campaign_id=c.id GROUP BY c.id ORDER BY c.created_at DESC`);res.json(rows)}catch(err){next(err)}});
router.post('/coupon-campaigns',async(req,res,next)=>{const client=await db.connect();try{await client.query('BEGIN');const c=await client.query(`INSERT INTO loyalty_coupon_campaigns(name,discount_type,discount_value,valid_from,valid_until,usage_mode,applies_to_all) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[req.body?.name,req.body?.discount_type||'percent',Number(req.body?.discount_value||0),req.body?.valid_from||null,req.body?.valid_until||null,req.body?.usage_mode||'single',req.body?.applies_to_all!==false]);const count=Math.max(0,Math.min(1000,Number(req.body?.generate_count||0)));for(let i=0;i<count;i++){const code=`KLEO-${Date.now().toString(36).toUpperCase()}-${i.toString(36).toUpperCase()}-${Math.random().toString(36).slice(2,6).toUpperCase()}`;await client.query(`INSERT INTO loyalty_coupons(campaign_id,code) VALUES($1,$2)`,[c.rows[0].id,code])}await client.query('COMMIT');res.status(201).json(c.rows[0])}catch(err){await client.query('ROLLBACK');next(err)}finally{client.release()}});
router.get('/coupons/validate/:code',async(req,res,next)=>{try{const{rows}=await db.query(`SELECT x.*,c.name campaign_name,c.discount_type,c.discount_value,c.valid_from,c.valid_until,c.usage_mode FROM loyalty_coupons x JOIN loyalty_coupon_campaigns c ON c.id=x.campaign_id WHERE upper(x.code)=upper($1) AND x.active=true AND c.active=true`,[req.params.code]);const x=rows[0];if(!x)return res.status(404).json({valid:false,message:'Kupon nem található.'});const now=Date.now();const valid=(!x.valid_from||new Date(x.valid_from).getTime()<=now)&&(!x.valid_until||new Date(x.valid_until).getTime()>=now)&&(x.usage_mode==='multiple'||Number(x.usage_count||0)===0);res.json({valid,coupon:x})}catch(err){next(err)}});

router.get('/vouchers',async(_req,res,next)=>{try{const{rows}=await db.query(`SELECT v.*,t.name voucher_type_name FROM loyalty_vouchers v LEFT JOIN loyalty_voucher_types t ON t.id=v.voucher_type_id ORDER BY v.created_at DESC LIMIT 250`);res.json(rows)}catch(err){next(err)}});
router.post('/vouchers',async(req:AuthRequest,res,next)=>{const client=await db.connect();try{await client.query('BEGIN');let vt=req.body?.voucher_type_id||null;let value=Number(req.body?.value||0),days=req.body?.valid_days||null;if(vt){const t=await client.query(`SELECT * FROM loyalty_voucher_types WHERE id=$1::uuid`,[vt]);if(t.rows[0]){value=Number(t.rows[0].face_value);days=t.rows[0].valid_days}}if(!(value>0))return res.status(400).json({message:'Az utalvány értéke kötelező.'});const code=req.body?.code||`KLEO-GIFT-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2,7).toUpperCase()}`;const r=await client.query(`INSERT INTO loyalty_vouchers(voucher_type_id,code,purchaser_customer_id,owner_customer_id,original_value,remaining_value,valid_from,valid_until) VALUES($1,$2,$3,$4,$5,$5,CURRENT_DATE,CASE WHEN $6::int IS NULL THEN NULL ELSE CURRENT_DATE+$6::int END) RETURNING *`,[vt,code,req.body?.purchaser_customer_id||null,req.body?.owner_customer_id||null,value,days]);await client.query('COMMIT');res.status(201).json(r.rows[0])}catch(err){await client.query('ROLLBACK');next(err)}finally{client.release()}});

export default router;
