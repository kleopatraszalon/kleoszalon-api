import {Router} from 'express';
import db from '../db';
import {requireAuth,AuthRequest} from '../middleware/auth';

const router=Router();
router.use(requireAuth);

const ADMIN_ROLES=new Set(['admin','administrator','rendszergazda','superadmin','super_admin']);
const roleList=(raw:any):string[]=>{
  if(Array.isArray(raw))return raw.map(String).map(x=>x.toLowerCase());
  try{const p=JSON.parse(String(raw||''));if(Array.isArray(p))return p.map(String).map(x=>x.toLowerCase())}catch{}
  return String(raw||'').replace(/[\[\]"]/g,'').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean);
};
const isAdmin=(req:AuthRequest)=>roleList(req.user?.role).some(r=>ADMIN_ROLES.has(r));
const num=(v:any)=>Number(v||0);
const money=(v:any)=>Math.round(num(v)*100)/100;

async function safeRows(sql:string,params:any[],fallback:any[]=[]){
  try{return (await db.query(sql,params)).rows}catch(error:any){
    if(['42P01','42703','42883'].includes(String(error?.code||'')))return fallback;
    throw error;
  }
}

router.get('/summary',async(req:AuthRequest,res,next)=>{
  try{
    const admin=isAdmin(req);
    const requested=String(req.query.location_id||'').trim();
    const ownLocation=req.user?.location_id?String(req.user.location_id):'';
    if(!admin&&!ownLocation)return res.status(403).json({message:'A készletirányításhoz a felhasználóhoz szalon-hozzárendelés szükséges.'});
    const locationId=admin?(requested||null):ownLocation;
    const central=admin&&!locationId;
    const stockParams:any[]=[];
    let stockWhere='b.location_id IS NULL';
    if(!central){stockParams.push(locationId);stockWhere='b.location_id=$1::uuid';}

    const balances=await safeRows(`SELECT b.id::text,b.product_id::text,p.name product_name,p.internal_code,p.brand,
      b.location_id::text,COALESCE(l.name,'Központi készlet') location_name,
      COALESCE(b.quantity,0)::numeric quantity,COALESCE(b.min_quantity,0)::numeric min_quantity,
      COALESCE(b.unit_cost,0)::numeric unit_cost,(COALESCE(b.quantity,0)*COALESCE(b.unit_cost,0))::numeric stock_value,
      CASE WHEN COALESCE(b.quantity,0)<=0 THEN 'out' WHEN COALESCE(b.quantity,0)<=COALESCE(b.min_quantity,0) THEN 'low' ELSE 'ok' END stock_status,
      GREATEST(COALESCE(b.min_quantity,0)*2-COALESCE(b.quantity,0),0)::numeric suggested_replenishment,
      r.id::text open_request_id,r.status open_request_status,COALESCE(r.requested_quantity,0)::numeric open_request_quantity
      FROM product_stock_balances b JOIN products p ON p.id=b.product_id LEFT JOIN locations l ON l.id=b.location_id
      LEFT JOIN LATERAL(SELECT sr.id,sr.status,sr.requested_quantity FROM salon_stock_requests sr
        WHERE sr.product_id=b.product_id AND sr.location_id IS NOT DISTINCT FROM b.location_id
          AND sr.status IN('requested','approved','partially_supplied') ORDER BY sr.created_at DESC LIMIT 1) r ON true
      WHERE ${stockWhere} ORDER BY CASE WHEN COALESCE(b.quantity,0)<=0 THEN 0 WHEN COALESCE(b.quantity,0)<=COALESCE(b.min_quantity,0) THEN 1 ELSE 2 END,p.name`,stockParams,[]);

    const requestParams:any[]=[];
    let requestWhere="r.status IN('requested','approved','partially_supplied')";
    if(!central){requestParams.push(locationId);requestWhere+=` AND r.location_id=$1::uuid`;}
    const requests=await safeRows(`SELECT r.id::text,r.location_id::text,l.name location_name,r.product_id::text,p.name product_name,
      r.requested_quantity::numeric,r.approved_quantity::numeric,r.supplied_quantity::numeric,r.status,r.source,r.source_work_order_id::text,
      r.purchase_order_id,r.created_at,
      COALESCE(cb.quantity,0)::numeric central_quantity,
      COALESCE((SELECT SUM(t.quantity) FROM stock_transfers t WHERE t.request_id=r.id AND t.status IN('prepared','dispatched')),0)::numeric pending_transfer_quantity
      FROM salon_stock_requests r JOIN locations l ON l.id=r.location_id JOIN products p ON p.id=r.product_id
      LEFT JOIN product_stock_balances cb ON cb.product_id=r.product_id AND cb.location_id IS NULL
      WHERE ${requestWhere} ORDER BY r.created_at DESC LIMIT 100`,requestParams,[]);

    const consumptionParams:any[]=[];
    let consumptionWhere="m.movement_type='work_order_consumption' AND m.created_at>=now()-interval '7 day'";
    if(central)consumptionWhere+=' AND m.location_id IS NULL';
    else{consumptionParams.push(locationId);consumptionWhere+=` AND m.location_id=$1::uuid`;}
    const consumption=(await safeRows(`SELECT COALESCE(SUM(ABS(m.quantity)),0)::numeric quantity,
      COALESCE(SUM(ABS(m.quantity)*COALESCE(m.unit_cost,0)),0)::numeric value,
      COUNT(DISTINCT m.work_order_id)::int workorders,COUNT(*)::int movement_count
      FROM inventory_movements m WHERE ${consumptionWhere}`,consumptionParams,[{}]))[0]||{};

    const atRisk=balances.filter((x:any)=>x.stock_status!=='ok').slice(0,50);
    const low=balances.filter((x:any)=>x.stock_status==='low').length;
    const out=balances.filter((x:any)=>x.stock_status==='out').length;
    const totalValue=balances.reduce((s:number,x:any)=>s+num(x.stock_value),0);
    const totalUnits=balances.reduce((s:number,x:any)=>s+num(x.quantity),0);
    const openRequestValue=requests.reduce((s:number,x:any)=>{
      const approved=num(x.approved_quantity||x.requested_quantity),remaining=Math.max(0,approved-num(x.supplied_quantity)-num(x.pending_transfer_quantity));
      return s+remaining;
    },0);
    const procurementNeeded=requests.filter((x:any)=>{
      const approved=num(x.approved_quantity||x.requested_quantity),remaining=Math.max(0,approved-num(x.supplied_quantity)-num(x.pending_transfer_quantity));
      return remaining>num(x.central_quantity)+1e-9&&!x.purchase_order_id;
    });

    res.json({
      scope:{is_admin:admin,central,location_id:locationId},
      kpis:{stock_items:balances.length,total_units:totalUnits,stock_value:money(totalValue),low_count:low,out_count:out,at_risk_count:low+out,
        open_request_count:requests.length,open_request_quantity:openRequestValue,procurement_needed_count:procurementNeeded.length,
        consumption_7d_quantity:num(consumption.quantity),consumption_7d_value:money(consumption.value),consumption_7d_workorders:Number(consumption.workorders||0)},
      at_risk:atRisk,
      requests:requests.slice(0,30),
      procurement_needed:procurementNeeded.slice(0,30)
    });
  }catch(error){next(error)}
});

export default router;
