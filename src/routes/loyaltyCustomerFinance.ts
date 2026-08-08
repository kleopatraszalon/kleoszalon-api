import { Router } from 'express';
import db from '../db';
import { requireAuth, AuthRequest } from '../middleware/auth';

const router = Router();
router.use(requireAuth);
const actor=(req:AuthRequest)=>req.user?.email||String(req.user?.id||'');

router.get('/customer/:customerId',async(req,res,next)=>{try{
  const customerId=String(req.params.customerId||'').trim();
  const accountRes=await db.query(`SELECT * FROM loyalty_accounts WHERE customer_id=$1 LIMIT 1`,[customerId]);
  const account=accountRes.rows[0]||null;
  const passes=account?await db.query(`SELECT p.*,t.name pass_type_name,t.sale_price,
    COALESCE(json_agg(json_build_object('service_id',b.service_id,'original_quantity',b.original_quantity,'remaining_quantity',b.remaining_quantity)) FILTER(WHERE b.id IS NOT NULL),'[]') balances
    FROM loyalty_passes p JOIN loyalty_pass_types t ON t.id=p.pass_type_id
    LEFT JOIN loyalty_pass_balances b ON b.pass_id=p.id
    WHERE p.account_id=$1 GROUP BY p.id,t.id ORDER BY p.created_at DESC`,[account.id]):{rows:[]};
  const vouchers=await db.query(`SELECT v.*,t.name voucher_type_name FROM loyalty_vouchers v LEFT JOIN loyalty_voucher_types t ON t.id=v.voucher_type_id WHERE v.owner_customer_id=$1 OR v.purchaser_customer_id=$1 ORDER BY v.created_at DESC LIMIT 100`,[customerId]);
  const coupons=await db.query(`SELECT c.*,cc.name campaign_name,cc.discount_type,cc.discount_value,cc.valid_until FROM loyalty_coupons c JOIN loyalty_coupon_campaigns cc ON cc.id=c.campaign_id WHERE c.customer_id=$1 ORDER BY c.created_at DESC LIMIT 100`,[customerId]);
  const transactions=account?await db.query(`SELECT * FROM loyalty_transactions WHERE account_id=$1 ORDER BY created_at DESC LIMIT 100`,[account.id]):{rows:[]};
  const sales=await db.query(`SELECT * FROM loyalty_sales WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 100`,[customerId]);
  res.json({account,passes:passes.rows,vouchers:vouchers.rows,coupons:coupons.rows,transactions:transactions.rows,sales:sales.rows});
}catch(err){next(err)}});

router.get('/finance/accounts',async(_req,res,next)=>{try{
  const {rows}=await db.query(`SELECT id,name,account_type,currency,location_id FROM financial_accounts WHERE active=true ORDER BY account_type,name`);
  res.json(rows);
}catch(err){next(err)}});

router.post('/finance/post-sale',async(req:AuthRequest,res,next)=>{const client=await db.connect();try{
  const saleType=String(req.body?.sale_type||'').trim();
  const referenceId=String(req.body?.reference_id||'').trim();
  const financeAccountId=String(req.body?.finance_account_id||'').trim();
  if(!['voucher','pass','wallet_topup'].includes(saleType)||!referenceId||!financeAccountId)return res.status(400).json({message:'Értékesítési típus, referencia és pénzügyi számla szükséges.'});
  await client.query('BEGIN');
  const saleRes=await client.query(`SELECT * FROM loyalty_sales WHERE sale_type=$1 AND reference_id=$2 ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,[saleType,referenceId]);
  const sale=saleRes.rows[0];
  if(!sale){await client.query('ROLLBACK');return res.status(404).json({message:'A hűségértékesítés nem található.'})}
  if(sale.finance_movement_id){await client.query('ROLLBACK');return res.json({ok:true,already_posted:true,finance_movement_id:sale.finance_movement_id})}
  const accountRes=await client.query(`SELECT * FROM financial_accounts WHERE id=$1::uuid AND active=true`,[financeAccountId]);
  const account=accountRes.rows[0];
  if(!account){await client.query('ROLLBACK');return res.status(404).json({message:'A pénzügyi számla/pénztár nem található.'})}
  const label=saleType==='voucher'?'Ajándékutalvány értékesítés':saleType==='pass'?'Bérlet értékesítés':'Vendégegyenleg feltöltés';
  const movement=await client.query(`INSERT INTO financial_movements(location_id,account_id,direction,amount,occurred_at,reference_type,reference_id,counterparty,note,created_by)
    VALUES($1,$2::uuid,'income',$3,now(),$4,$5,$6,$7,$8) RETURNING *`,[account.location_id,financeAccountId,Number(sale.gross_amount||0),`loyalty_${saleType}_sale`,String(sale.id),sale.customer_id||null,label,actor(req)]);
  await client.query(`UPDATE loyalty_sales SET finance_movement_id=$2,finance_account_id=$3::uuid,finance_reference=$2::text WHERE id=$1`,[sale.id,movement.rows[0].id,financeAccountId]);
  await client.query('COMMIT');
  res.json({ok:true,sale_id:sale.id,finance_movement:movement.rows[0]});
}catch(err){await client.query('ROLLBACK');next(err)}finally{client.release()}});

export default router;
