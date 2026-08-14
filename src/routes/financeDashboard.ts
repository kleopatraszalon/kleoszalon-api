import {Router} from 'express';
import db from '../db';
import {requireAuth,AuthRequest} from '../middleware/auth';
import {requireFeature} from '../middleware/featureAccess';

const router=Router();
router.use(requireAuth);
router.use(requireFeature('finance'));

// This set is local to the finance dashboard: accounting gets network-wide financial scope
// without becoming a system administrator anywhere else.
const ADMIN_ROLES=new Set(['admin','administrator','rendszergazda','superadmin','super_admin','accounting','bookkeeper','konyveles','könyvelés']);
const money=(v:any)=>Math.round(Number(v||0)*100)/100;
const roles=(raw:any):string[]=>{
  if(Array.isArray(raw))return raw.map(String).map(x=>x.toLowerCase());
  try{const parsed=JSON.parse(String(raw||''));if(Array.isArray(parsed))return parsed.map(String).map(x=>x.toLowerCase())}catch{}
  return String(raw||'').replace(/[\[\]"]/g,'').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean);
};
const isAdmin=(req:AuthRequest)=>roles(req.user?.role).some(r=>ADMIN_ROLES.has(r));
const validDate=(value:string)=>/^\d{4}-\d{2}-\d{2}$/.test(value);

async function safeRows(sql:string,params:any[],fallback:any[]=[]){
  try{return (await db.query(sql,params)).rows}catch(error:any){
    if(['42P01','42703','42883'].includes(String(error?.code||'')))return fallback;
    throw error;
  }
}

router.get('/',async(req:AuthRequest,res,next)=>{
  try{
    const requestedDate=String(req.query.date||new Date().toISOString().slice(0,10));
    const businessDate=validDate(requestedDate)?requestedDate:new Date().toISOString().slice(0,10);
    const admin=isAdmin(req);
    const requestedLocation=String(req.query.location_id||'').trim()||null;
    const locationId=admin?requestedLocation:(req.user?.location_id?String(req.user.location_id):null);
    if(!admin&&!locationId)return res.status(403).json({message:'A pénzügyi dashboardhoz a felhasználóhoz szalon-hozzárendelés szükséges.'});
    const params=[businessDate,locationId];
    const loc=`($2::uuid IS NULL OR wo.location_id=$2::uuid)`;

    const paymentRows=await safeRows(`SELECT
      COALESCE(SUM(wp.amount),0)::numeric collected_total,
      COUNT(*)::int payment_count,
      COUNT(DISTINCT wp.work_order_id)::int paid_workorders,
      COALESCE(SUM(wp.amount) FILTER(WHERE wp.payment_method='cash'),0)::numeric cash,
      COALESCE(SUM(wp.amount) FILTER(WHERE wp.payment_method='card'),0)::numeric card,
      COALESCE(SUM(wp.amount) FILTER(WHERE wp.payment_method='transfer'),0)::numeric transfer,
      COALESCE(SUM(wp.amount) FILTER(WHERE wp.payment_method='voucher'),0)::numeric voucher,
      COALESCE(SUM(wp.amount) FILTER(WHERE wp.payment_method='other'),0)::numeric other
      FROM work_order_payments wp JOIN work_orders wo ON wo.id=wp.work_order_id
      WHERE wp.paid_at::date=$1::date AND ${loc}`,params,[{}]);

    const workRows=await safeRows(`SELECT
      COUNT(*) FILTER(WHERE wo.financial_closed_at::date=$1::date)::int financially_closed,
      COALESCE(SUM(wo.discount_amount) FILTER(WHERE wo.financial_closed_at::date=$1::date),0)::numeric discounts,
      COALESCE(SUM(wo.tip_amount) FILTER(WHERE wo.financial_closed_at::date=$1::date),0)::numeric tips,
      COALESCE(AVG(wo.amount_due) FILTER(WHERE wo.financial_closed_at::date=$1::date),0)::numeric avg_ticket,
      COUNT(*) FILTER(WHERE wo.status NOT IN('completed','cancelled','no_show') AND wo.locked_at IS NULL)::int open_workorders,
      COUNT(*) FILTER(WHERE COALESCE(wo.payment_status,'unpaid')<>'paid' AND wo.status NOT IN('cancelled','no_show'))::int unpaid_workorders,
      COALESCE(SUM(GREATEST(COALESCE(wo.amount_due,0)-COALESCE(wo.amount_paid,0),0)) FILTER(WHERE COALESCE(wo.payment_status,'unpaid')<>'paid' AND wo.status NOT IN('cancelled','no_show')),0)::numeric unpaid_total
      FROM work_orders wo WHERE ${loc}`,params,[{}]);

    const refundRows=await safeRows(`SELECT COALESCE(SUM(fr.amount),0)::numeric refund_total,COUNT(*)::int refund_count
      FROM financial_refunds fr WHERE fr.refunded_at::date=$1::date AND ($2::uuid IS NULL OR fr.location_id=$2::uuid)`,params,[{}]);

    const locationRows=await safeRows(`SELECT wo.location_id::text location_id,COALESCE(l.name,'Nincs telephely') location_name,
      COALESCE(SUM(wp.amount),0)::numeric revenue,COUNT(DISTINCT wp.work_order_id)::int workorders,
      COALESCE(SUM(wp.amount) FILTER(WHERE wp.payment_method='cash'),0)::numeric cash,
      COALESCE(SUM(wp.amount) FILTER(WHERE wp.payment_method='card'),0)::numeric card,
      COALESCE(SUM(wp.amount) FILTER(WHERE wp.payment_method='transfer'),0)::numeric transfer,
      COALESCE(SUM(wp.amount) FILTER(WHERE wp.payment_method='voucher'),0)::numeric voucher,
      COALESCE(SUM(wp.amount) FILTER(WHERE wp.payment_method='other'),0)::numeric other
      FROM work_order_payments wp JOIN work_orders wo ON wo.id=wp.work_order_id LEFT JOIN locations l ON l.id=wo.location_id
      WHERE wp.paid_at::date=$1::date AND ${loc}
      GROUP BY wo.location_id,l.name ORDER BY revenue DESC`,params,[]);

    const staffRows=await safeRows(`WITH paid_workorders AS (
      SELECT wo.id,wo.employee_id,wo.amount_due,wo.tip_amount,wo.financial_closed_at,COALESCE(SUM(wp.amount),0)::numeric revenue
      FROM work_order_payments wp JOIN work_orders wo ON wo.id=wp.work_order_id
      WHERE wp.paid_at::date=$1::date AND ${loc}
      GROUP BY wo.id,wo.employee_id,wo.amount_due,wo.tip_amount,wo.financial_closed_at
    )
    SELECT p.employee_id::text employee_id,COALESCE(NULLIF(e.full_name,''),NULLIF(e.name,''),'Nincs munkatárs') employee_name,
      COUNT(*)::int workorders,COALESCE(SUM(p.revenue),0)::numeric revenue,
      COALESCE(AVG(NULLIF(p.amount_due,0)),0)::numeric avg_ticket,
      COALESCE(SUM(CASE WHEN p.financial_closed_at::date=$1::date THEN COALESCE(p.tip_amount,0) ELSE 0 END),0)::numeric tips
      FROM paid_workorders p LEFT JOIN employees e ON e.id=p.employee_id
      GROUP BY p.employee_id,e.full_name,e.name ORDER BY revenue DESC LIMIT 30`,params,[]);

    const commissionRows=await safeRows(`SELECT ce.employee_id::text employee_id,COALESCE(NULLIF(e.full_name,''),NULLIF(e.name,''),'Nincs munkatárs') employee_name,
      COUNT(*)::int event_count,COALESCE(SUM(ce.base_amount),0)::numeric base_amount,COALESCE(SUM(ce.tip_amount),0)::numeric tip_amount
      FROM work_order_commission_events ce JOIN work_orders wo ON wo.id=ce.work_order_id LEFT JOIN employees e ON e.id=ce.employee_id
      WHERE ce.status='open' AND ($2::uuid IS NULL OR wo.location_id=$2::uuid)
      GROUP BY ce.employee_id,e.full_name,e.name ORDER BY base_amount DESC LIMIT 30`,params,[]);

    const closingRows=await safeRows(`SELECT c.*,COALESCE(l.name,'Minden telephely') location_name FROM cash_register_closings c
      LEFT JOIN locations l ON l.id=c.location_id WHERE c.business_date=$1::date AND ($2::uuid IS NULL OR c.location_id=$2::uuid)
      ORDER BY c.closed_at DESC`,params,[]);

    const trendRows=await safeRows(`SELECT wp.paid_at::date business_date,COALESCE(SUM(wp.amount),0)::numeric revenue,
      COUNT(DISTINCT wp.work_order_id)::int workorders
      FROM work_order_payments wp JOIN work_orders wo ON wo.id=wp.work_order_id
      WHERE wp.paid_at::date BETWEEN ($1::date-INTERVAL '6 day')::date AND $1::date AND ${loc}
      GROUP BY wp.paid_at::date ORDER BY business_date`,params,[]);

    const p=paymentRows[0]||{},w=workRows[0]||{},r=refundRows[0]||{};
    const collected=money(p.collected_total),refunds=money(r.refund_total);
    res.json({
      business_date:businessDate,
      scope:{is_admin:admin,location_id:locationId},
      kpis:{
        collected_total:collected,refund_total:refunds,net_collected:money(collected-refunds),payment_count:Number(p.payment_count||0),paid_workorders:Number(p.paid_workorders||0),
        financially_closed:Number(w.financially_closed||0),open_workorders:Number(w.open_workorders||0),unpaid_workorders:Number(w.unpaid_workorders||0),unpaid_total:money(w.unpaid_total),
        discounts:money(w.discounts),tips:money(w.tips),avg_ticket:money(w.avg_ticket)
      },
      payments:[
        {method:'cash',label:'Készpénz',amount:money(p.cash)},
        {method:'card',label:'Bankkártya',amount:money(p.card)},
        {method:'transfer',label:'Átutalás',amount:money(p.transfer)},
        {method:'voucher',label:'Utalvány',amount:money(p.voucher)},
        {method:'other',label:'Egyéb',amount:money(p.other)}
      ],
      locations:locationRows.map((x:any)=>({...x,revenue:money(x.revenue),cash:money(x.cash),card:money(x.card),transfer:money(x.transfer),voucher:money(x.voucher),other:money(x.other),workorders:Number(x.workorders||0)})),
      staff:staffRows.map((x:any)=>({...x,revenue:money(x.revenue),avg_ticket:money(x.avg_ticket),tips:money(x.tips),workorders:Number(x.workorders||0)})),
      commissions:commissionRows.map((x:any)=>({...x,event_count:Number(x.event_count||0),base_amount:money(x.base_amount),tip_amount:money(x.tip_amount)})),
      closings:closingRows.map((x:any)=>({...x,opening_cash:money(x.opening_cash),cash_sales:money(x.cash_sales),expected_cash:money(x.expected_cash),counted_cash:money(x.counted_cash),difference:money(x.difference)})),
      trend:trendRows.map((x:any)=>({business_date:String(x.business_date).slice(0,10),revenue:money(x.revenue),workorders:Number(x.workorders||0)}))
    });
  }catch(error){next(error)}
});

export default router;