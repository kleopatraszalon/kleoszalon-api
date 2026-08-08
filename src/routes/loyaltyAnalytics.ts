import { Router } from 'express';
import db from '../db';
import { requireAuth } from '../middleware/auth';

const router=Router();
router.use(requireAuth);

router.get('/summary',async(req,res,next)=>{try{
  const from=String(req.query.from||'').trim()||null;
  const to=String(req.query.to||'').trim()||null;
  const {rows}=await db.query(`
    WITH period_tx AS (
      SELECT * FROM loyalty_transactions
      WHERE ($1::date IS NULL OR created_at::date >= $1::date)
        AND ($2::date IS NULL OR created_at::date <= $2::date)
    )
    SELECT
      (SELECT COUNT(*)::int FROM loyalty_accounts WHERE status='active') active_accounts,
      (SELECT COALESCE(SUM(balance),0) FROM loyalty_accounts WHERE status='active') wallet_balance,
      (SELECT COALESCE(SUM(points),0) FROM loyalty_accounts WHERE status='active') points_balance,
      (SELECT COUNT(*)::int FROM loyalty_passes WHERE status='active' AND (valid_until IS NULL OR valid_until>=CURRENT_DATE)) active_passes,
      (SELECT COALESCE(SUM(remaining_quantity),0) FROM loyalty_pass_balances b JOIN loyalty_passes p ON p.id=b.pass_id WHERE p.status='active') pass_units_remaining,
      (SELECT COUNT(*)::int FROM loyalty_coupons c JOIN loyalty_coupon_campaigns cc ON cc.id=c.campaign_id WHERE c.active=true AND cc.active=true) active_coupons,
      (SELECT COALESCE(SUM(usage_count),0)::int FROM loyalty_coupons) coupon_uses,
      (SELECT COUNT(*)::int FROM loyalty_vouchers WHERE status='active' AND remaining_value>0 AND (valid_until IS NULL OR valid_until>=CURRENT_DATE)) active_vouchers,
      (SELECT COALESCE(SUM(remaining_value),0) FROM loyalty_vouchers WHERE status='active') voucher_liability,
      (SELECT COUNT(*)::int FROM loyalty_vouchers WHERE status='active' AND valid_until BETWEEN CURRENT_DATE AND CURRENT_DATE+30) vouchers_expiring_30d,
      (SELECT COALESCE(SUM(amount),0) FROM period_tx WHERE transaction_type='balance_topup') period_topups,
      (SELECT COALESCE(SUM(ABS(amount)),0) FROM period_tx WHERE transaction_type IN ('balance_spend','voucher_spend')) period_redemptions,
      (SELECT COALESCE(SUM(points),0) FROM period_tx WHERE points>0) period_points_earned,
      (SELECT COALESCE(SUM(ABS(points)),0) FROM period_tx WHERE points<0) period_points_spent,
      (SELECT COUNT(*)::int FROM period_tx) period_transactions
  `,[from,to]);
  res.json(rows[0]);
}catch(err){next(err)}});

router.get('/trend',async(req,res,next)=>{try{
  const days=Math.max(7,Math.min(180,Number(req.query.days||30)));
  const {rows}=await db.query(`SELECT created_at::date day,
    COALESCE(SUM(amount) FILTER(WHERE transaction_type='balance_topup'),0) topups,
    COALESCE(SUM(ABS(amount)) FILTER(WHERE transaction_type IN ('balance_spend','voucher_spend')),0) redemptions,
    COALESCE(SUM(points) FILTER(WHERE points>0),0) points_earned,
    COALESCE(SUM(ABS(points)) FILTER(WHERE points<0),0) points_spent
    FROM loyalty_transactions WHERE created_at>=CURRENT_DATE-($1::int-1)
    GROUP BY created_at::date ORDER BY day`,[days]);
  res.json(rows);
}catch(err){next(err)}});

router.get('/transactions',async(req,res,next)=>{try{
  const q=String(req.query.q||'').trim();
  const {rows}=await db.query(`SELECT t.*,a.customer_id,a.card_identifier FROM loyalty_transactions t JOIN loyalty_accounts a ON a.id=t.account_id WHERE ($1='' OR a.customer_id ILIKE '%'||$1||'%' OR COALESCE(t.note,'') ILIKE '%'||$1||'%' OR t.transaction_type ILIKE '%'||$1||'%') ORDER BY t.created_at DESC LIMIT 300`,[q]);
  res.json(rows);
}catch(err){next(err)}});

router.get('/points-rules',async(_req,res,next)=>{try{const{rows}=await db.query(`SELECT * FROM loyalty_points_rules ORDER BY active DESC,created_at DESC`);res.json(rows)}catch(err){next(err)}});
router.post('/points-rules',async(req,res,next)=>{try{const{rows}=await db.query(`INSERT INTO loyalty_points_rules(name,spend_amount,points_earned,point_value,valid_from,valid_until,active) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[req.body?.name||'Hűségpont szabály',Number(req.body?.spend_amount||100),Number(req.body?.points_earned||1),Number(req.body?.point_value||1),req.body?.valid_from||null,req.body?.valid_until||null,req.body?.active!==false]);res.status(201).json(rows[0])}catch(err){next(err)}});

export default router;
