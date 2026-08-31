import {Router,Response} from "express";
import pool from "../db";
import type {AuthRequest} from "../middleware/auth";
import {requireManagement} from "../middleware/requireRoles";
import {profitEngine} from "../services/virWave2Engine";
import {ensureInventoryOperationsSchema} from "../inventory/ensureInventoryOperationsSchema";
import {ensureInventoryLotSchema} from "../inventory/ensureInventoryLotSchema";

const router=Router();
router.use(requireManagement);
type Scope={tenantId:string;locationId:string|null};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRIORITY_RANK:Record<string,number>={CRITICAL:0,HIGH:1,MEDIUM:2,LOW:3};
function n(v:unknown){return Number.isFinite(Number(v))?Number(v):0}
function clamp(v:number,min:number,max:number){return Math.min(max,Math.max(min,v))}
async function scope(req:AuthRequest,res:Response):Promise<Scope|undefined>{
 const tenantId=String(req.user?.tenant_id||"").trim();
 if(!/^\d+$/.test(tenantId)||Number(tenantId)<=0){res.status(403).json({ok:false,error:"A felhasználóhoz nincs tenant rendelve."});return}
 const requested=String(req.query.locationId||req.query.location_id||"").trim();
 if(!requested)return{tenantId,locationId:null};
 if(!UUID.test(requested)){res.status(400).json({ok:false,error:"Érvénytelen telephelyazonosító."});return}
 const row=(await pool.query(`SELECT id::text FROM locations WHERE id=$1::uuid AND tenant_id=$2::bigint`,[requested,tenantId])).rows[0];
 if(!row){res.status(403).json({ok:false,error:"A telephely nem tartozik a tenantjához."});return}
 return{tenantId,locationId:requested}
}
async function tenantLocations(s:Scope){if(s.locationId)return[s.locationId];return (await pool.query(`SELECT id::text FROM locations WHERE tenant_id=$1::bigint ORDER BY name`,[s.tenantId])).rows.map((r:any)=>String(r.id))}

router.get("/customer-360",async(req:AuthRequest,res:Response)=>{try{const s=await scope(req,res);if(!s)return;const rows=(await pool.query(`
 WITH a AS (
  SELECT client_id,COUNT(*)::int visits,COUNT(*) FILTER(WHERE lower(COALESCE(status,'')) IN('no_show','no-show','noshow'))::int no_shows,MAX(start_time) last_visit,MIN(start_time) FILTER(WHERE start_time>now()) next_visit
  FROM appointments WHERE tenant_id=$1::bigint AND ($2::uuid IS NULL OR location_id=$2::uuid) GROUP BY client_id
 ),v AS (
  SELECT client_id,COALESCE(SUM(COALESCE(NULLIF(to_jsonb(w)->>'gross_total','')::numeric,NULLIF(to_jsonb(w)->>'total_amount','')::numeric,0)),0)::numeric lifetime_value
  FROM work_orders w WHERE w.tenant_id=$1::bigint AND ($2::uuid IS NULL OR w.location_id=$2::uuid) AND lower(COALESCE(w.status,''))='completed' GROUP BY client_id
 )
 SELECT c.id::text client_id,COALESCE(c.full_name,c.name,'Vendég') client_name,c.email,c.phone,COALESCE(a.visits,0)::int visits,COALESCE(a.no_shows,0)::int no_shows,a.last_visit,a.next_visit,COALESCE(v.lifetime_value,0)::numeric lifetime_value
 FROM clients c LEFT JOIN a ON a.client_id=c.id LEFT JOIN v ON v.client_id=c.id
 WHERE c.tenant_id=$1::bigint AND ($2::uuid IS NULL OR c.location_id=$2::uuid OR c.location_id IS NULL)
 ORDER BY lifetime_value DESC,visits DESC LIMIT 250`,[s.tenantId,s.locationId])).rows;
 const items=rows.map((r:any)=>({...r,visits:n(r.visits),no_shows:n(r.no_shows),lifetime_value:n(r.lifetime_value),recency_days:r.last_visit?Math.max(0,Math.floor((Date.now()-new Date(r.last_visit).getTime())/86400000)):null,value_tier:n(r.lifetime_value)>=150000||n(r.visits)>=12?"VIP":n(r.lifetime_value)>=60000||n(r.visits)>=6?"LOYAL":n(r.visits)?"STANDARD":"NEW"}));
 res.json({ok:true,summary:{clients:items.length,vip:items.filter((x:any)=>x.value_tier==='VIP').length,at_risk:items.filter((x:any)=>x.recency_days!==null&&x.recency_days>=60&&!x.next_visit).length,lifetime_value:items.reduce((a:number,x:any)=>a+x.lifetime_value,0)},items,canonical_route:"/modules/customers/intelligence"});
}catch(e:any){res.status(500).json({ok:false,error:e?.message||"customer_360_failed"})}});

router.get("/forecast",async(req:AuthRequest,res:Response)=>{try{const s=await scope(req,res);if(!s)return;const history=(await pool.query(`SELECT COALESCE(SUM(COALESCE(NULLIF(to_jsonb(w)->>'gross_total','')::numeric,NULLIF(to_jsonb(w)->>'total_amount','')::numeric,0)),0)::numeric revenue,COUNT(DISTINCT COALESCE(w.completed_at,w.updated_at)::date)::int active_days FROM work_orders w WHERE w.tenant_id=$1::bigint AND ($2::uuid IS NULL OR w.location_id=$2::uuid) AND lower(COALESCE(w.status,''))='completed' AND COALESCE(w.completed_at,w.updated_at)>=now()-interval '90 days'`,[s.tenantId,s.locationId])).rows[0]||{};const daily=n(history.revenue)/Math.max(1,n(history.active_days)||90);const horizons=[] as any[];for(const days of [7,30,90]){const pipe=(await pool.query(`SELECT COUNT(DISTINCT a.id)::int bookings,COALESCE(SUM(COALESCE(aps.price,0)),0)::numeric booked_value FROM appointments a LEFT JOIN appointment_services aps ON aps.appointment_id=a.id WHERE a.tenant_id=$1::bigint AND ($2::uuid IS NULL OR a.location_id=$2::uuid) AND a.start_time>=now() AND a.start_time<now()+($3::text||' days')::interval AND lower(COALESCE(a.status,'')) NOT IN('cancelled','canceled','no_show','no-show')`,[s.tenantId,s.locationId,days])).rows[0]||{};const runRate=daily*days,base=Math.max(runRate,n(pipe.booked_value));horizons.push({days,bookings:n(pipe.bookings),booked_value:Math.round(n(pipe.booked_value)),run_rate:Math.round(runRate),forecast_low:Math.round(base*.9),forecast_base:Math.round(base),forecast_high:Math.round(base*1.1),coverage_percent:runRate>0?Math.round(n(pipe.booked_value)/runRate*1000)/10:0})}res.json({ok:true,method:"trailing_90d_run_rate_plus_booked_floor",daily_run_rate:Math.round(daily),horizons});}catch(e:any){res.status(500).json({ok:false,error:e?.message||"forecast_failed"})}});

router.get("/inventory-intelligence",async(req:AuthRequest,res:Response)=>{try{
 await ensureInventoryOperationsSchema();await ensureInventoryLotSchema();
 const s=await scope(req,res);if(!s)return;const ids=await tenantLocations(s);if(!ids.length)return res.json({ok:true,summary:{products:0,critical:0,high:0,suggested_order_value:0,expired_quantity:0},items:[],canonical_procurement_route:"/warehouse?view=procurement&section=suggestions"});
 const movementExists=Boolean((await pool.query(`SELECT to_regclass('public.inventory_movements')::text rel`)).rows[0]?.rel);
 const consumption=new Map<string,number>();
 if(movementExists){
  const q=await pool.query(`SELECT location_id::text,product_id::text,
    COALESCE(SUM(ABS(COALESCE(quantity,0))) FILTER(WHERE COALESCE(quantity,0)<0 OR lower(COALESCE(movement_type,'')) IN('out','sale','usage','consume','salon_use','work_order_consumption','writeoff','transfer_out')),0)::numeric used
    FROM inventory_movements
    WHERE location_id=ANY($1::uuid[]) AND created_at>=now()-interval '30 days'
    GROUP BY location_id,product_id`,[ids]);
  for(const r of q.rows)consumption.set(`${String(r.location_id)}:${String(r.product_id)}`,n(r.used));
 }
 const rows=(await pool.query(`WITH expired AS (
   SELECT lb.warehouse_id,l.product_id,COALESCE(SUM(lb.quantity) FILTER(WHERE l.expires_at<CURRENT_DATE),0)::numeric expired_qty
   FROM inventory_warehouse_lot_balances lb JOIN inventory_lots l ON l.id=lb.lot_id
   WHERE lb.quantity>0 GROUP BY lb.warehouse_id,l.product_id
  ),stock AS (
   SELECT w.location_id,b.product_id,p.name product_name,
     COALESCE(SUM(b.quantity),0)::numeric physical_stock_qty,
     COALESCE(SUM(COALESCE(e.expired_qty,0)),0)::numeric expired_stock_qty,
     COALESCE(SUM(CASE WHEN COALESCE(p.lot_tracking_enabled,false) THEN GREATEST(b.quantity-COALESCE(e.expired_qty,0),0) ELSE b.quantity END),0)::numeric usable_stock_qty,
     CASE WHEN SUM(GREATEST(b.quantity,0))>0 THEN SUM(GREATEST(b.quantity,0)*COALESCE(b.unit_cost,0))/SUM(GREATEST(b.quantity,0)) ELSE COALESCE(MAX(b.unit_cost),0) END::numeric unit_cost
   FROM inventory_warehouse_balances b
   JOIN inventory_warehouses w ON w.id=b.warehouse_id AND w.active=true
   JOIN products p ON p.id=b.product_id
   LEFT JOIN expired e ON e.warehouse_id=b.warehouse_id AND e.product_id=b.product_id
   WHERE w.location_id=ANY($1::uuid[])
   GROUP BY w.location_id,b.product_id,p.name
  )
  SELECT s.location_id,s.product_id::text,l.name location_name,s.product_name,s.physical_stock_qty,s.expired_stock_qty,s.usable_stock_qty,s.unit_cost
  FROM stock s JOIN locations l ON l.id=s.location_id
  WHERE l.tenant_id=$2::bigint
  ORDER BY s.product_name,l.name`,[ids,s.tenantId])).rows;
 const items=rows.map((r:any)=>{const key=`${String(r.location_id)}:${String(r.product_id)}`,used30=consumption.get(key)||0,daily=used30/30,stock=n(r.usable_stock_qty),physical=n(r.physical_stock_qty),expired=n(r.expired_stock_qty),cover=daily>0?stock/daily:999,reorder=Math.max(0,Math.ceil(daily*21-stock));return{...r,stock_qty:stock,usable_stock_qty:stock,physical_stock_qty:physical,expired_stock_qty:expired,unit_cost:n(r.unit_cost),used_30d:used30,daily_usage:Math.round(daily*100)/100,days_cover:cover===999?null:Math.round(cover*10)/10,suggested_order_qty:reorder,suggested_order_value:Math.round(reorder*n(r.unit_cost)),priority:cover<7?"CRITICAL":cover<14?"HIGH":cover<30?"MEDIUM":"LOW"}}).sort((a:any,b:any)=>(PRIORITY_RANK[String(a.priority)]??99)-(PRIORITY_RANK[String(b.priority)]??99));
 res.json({ok:true,summary:{products:items.length,critical:items.filter((x:any)=>x.priority==='CRITICAL').length,high:items.filter((x:any)=>x.priority==='HIGH').length,suggested_order_value:items.reduce((a:number,x:any)=>a+x.suggested_order_value,0),expired_quantity:items.reduce((a:number,x:any)=>a+x.expired_stock_qty,0)},items:items.slice(0,300),canonical_procurement_route:"/warehouse?view=procurement&section=suggestions",stock_basis:"usable_non_expired_fefo"});
}catch(e:any){res.status(500).json({ok:false,error:e?.message||"inventory_intelligence_failed"})}});

router.get("/simulator",async(req:AuthRequest,res:Response)=>{try{const s=await scope(req,res);if(!s)return;const rev=clamp(n(req.query.revenue_change),-50,100),price=clamp(n(req.query.price_change),-30,50),util=clamp(n(req.query.utilization_change),-50,100),wage=clamp(n(req.query.wage_change),-30,50),material=clamp(n(req.query.material_change),-30,50);const ids=await tenantLocations(s);const bases=[] as any[];for(const id of ids){const p=await profitEngine({locationId:id});bases.push(p.summary)}const base=bases.reduce((a:any,x:any)=>({revenue:a.revenue+n(x.revenue),material_cost:a.material_cost+n(x.material_cost),labor_cost:a.labor_cost+n(x.labor_cost),commission_cost:a.commission_cost+n(x.commission_cost),gross_profit:a.gross_profit+n(x.gross_profit)}),{revenue:0,material_cost:0,labor_cost:0,commission_cost:0,gross_profit:0});const revenueMultiplier=(1+rev/100)*(1+price/100)*(1+util/100),scenarioRevenue=base.revenue*revenueMultiplier,scenarioMaterial=base.material_cost*(1+material/100)*(1+rev/100)*(1+util/100),scenarioLabor=base.labor_cost*(1+wage/100)*(1+util/100),scenarioCommission=base.revenue?base.commission_cost*(scenarioRevenue/base.revenue):0,profit=scenarioRevenue-scenarioMaterial-scenarioLabor-scenarioCommission;res.json({ok:true,inputs:{revenue_change:rev,price_change:price,utilization_change:util,wage_change:wage,material_change:material},baseline:{...base,margin_percent:base.revenue?Math.round(base.gross_profit/base.revenue*10000)/100:0},scenario:{revenue:Math.round(scenarioRevenue),material_cost:Math.round(scenarioMaterial),labor_cost:Math.round(scenarioLabor),commission_cost:Math.round(scenarioCommission),gross_profit:Math.round(profit),margin_percent:scenarioRevenue?Math.round(profit/scenarioRevenue*10000)/100:0},delta:{revenue:Math.round(scenarioRevenue-base.revenue),gross_profit:Math.round(profit-base.gross_profit)},model:"deterministic_what_if_no_write"});}catch(e:any){res.status(500).json({ok:false,error:e?.message||"simulator_failed"})}});

export default router;
