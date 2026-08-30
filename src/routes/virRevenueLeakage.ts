import { Router, Response } from "express";
import pool from "../db";
import type { AuthRequest } from "../middleware/auth";
import { requireManagement } from "../middleware/requireRoles";

const router = Router();
router.use(requireManagement);

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const n=(v:unknown)=>Number.isFinite(Number(v))?Number(v):0;
const clamp=(v:number,min:number,max:number)=>Math.min(max,Math.max(min,v));

type Scope={tenantId:string;locationId:string|null};
async function scope(req:AuthRequest,res:Response):Promise<Scope|undefined>{
  const tenantId=String(req.user?.tenant_id||"").trim();
  if(!tenantId){res.status(403).json({ok:false,error:"A felhasználóhoz nincs tenant rendelve."});return;}
  const requested=String(req.query.locationId||req.query.location_id||"").trim();
  if(!requested)return{tenantId,locationId:null};
  if(!UUID.test(requested)){res.status(400).json({ok:false,error:"Érvénytelen telephelyazonosító."});return;}
  const found=(await pool.query(`SELECT id::text FROM locations WHERE id=$1::uuid AND tenant_id=$2::uuid`,[requested,tenantId])).rows[0];
  if(!found){res.status(403).json({ok:false,error:"A telephely nem tartozik a tenantjához."});return;}
  return{tenantId,locationId:requested};
}

router.get("/",async(req:AuthRequest,res:Response)=>{
  try{
    const s=await scope(req,res);if(!s)return;
    const days=clamp(n(req.query.days)||30,7,90);
    const {rows}=await pool.query(`
      WITH wo_base AS (
        SELECT w.id,w.location_id,w.client_id,w.status,
          COALESCE(w.completed_at,w.closed_at,w.updated_at,w.created_at) event_time,
          COALESCE(NULLIF(to_jsonb(w)->>'gross_total','')::numeric,NULLIF(to_jsonb(w)->>'total_amount','')::numeric,0) gross_total,
          COALESCE(NULLIF(to_jsonb(w)->>'amount_due','')::numeric,0) amount_due,
          COALESCE(NULLIF(to_jsonb(w)->>'amount_paid','')::numeric,0) amount_paid,
          lower(COALESCE(to_jsonb(w)->>'payment_status','')) payment_status,
          COALESCE(NULLIF(to_jsonb(w)->>'work_order_number',''),w.id::text) work_order_number
        FROM work_orders w
        WHERE w.tenant_id=$1::uuid AND ($2::uuid IS NULL OR w.location_id=$2::uuid)
          AND COALESCE(w.completed_at,w.closed_at,w.updated_at,w.created_at)>=now()-($3::text||' days')::interval
      ), normalized AS (
        SELECT w.*,GREATEST(CASE WHEN w.amount_due>0 THEN w.amount_due ELSE w.gross_total END-w.amount_paid,0)::numeric outstanding_amount
        FROM wo_base w
      ), item_totals AS (
        SELECT wi.work_order_id,COUNT(*)::int item_count,
          COALESCE(SUM(COALESCE(wi.line_total,wi.unit_price*COALESCE(wi.quantity,1),0)),0)::numeric item_total
        FROM work_order_items wi JOIN normalized w ON w.id=wi.work_order_id GROUP BY wi.work_order_id
      ), completed_appointments AS (
        SELECT a.id,a.location_id,a.client_id,a.start_time,
          COALESCE(SUM(COALESCE(aps.price,0)),0)::numeric booked_value
        FROM appointments a LEFT JOIN appointment_services aps ON aps.appointment_id=a.id
        WHERE a.tenant_id=$1::uuid AND ($2::uuid IS NULL OR a.location_id=$2::uuid)
          AND a.start_time>=now()-($3::text||' days')::interval
          AND lower(COALESCE(a.status,'')) IN('completed','done','finished')
        GROUP BY a.id
      ), evidence AS (
        SELECT 'COMPLETED_UNPAID'::text leakage_type,'CRITICAL'::text severity,w.id::text entity_id,'work_order'::text entity_type,
          w.location_id,w.event_time,w.work_order_number title,w.outstanding_amount estimated_loss,
          jsonb_build_object('gross_total',w.gross_total,'amount_due',w.amount_due,'amount_paid',w.amount_paid,'outstanding_amount',w.outstanding_amount,'payment_status',w.payment_status) details
        FROM normalized w
        WHERE lower(COALESCE(w.status,''))='completed'
          AND w.payment_status NOT IN('paid','settled','completed')
          AND w.outstanding_amount>=1
        UNION ALL
        SELECT 'ZERO_VALUE_COMPLETED','HIGH',w.id::text,'work_order',w.location_id,w.event_time,w.work_order_number,
          0::numeric,jsonb_build_object('gross_total',w.gross_total,'note','Lezárt munkalap nulla értékkel')
        FROM normalized w WHERE lower(COALESCE(w.status,''))='completed' AND w.gross_total<=0
        UNION ALL
        SELECT 'HEADER_ITEM_MISMATCH','HIGH',w.id::text,'work_order',w.location_id,w.event_time,w.work_order_number,
          ABS(w.gross_total-COALESCE(i.item_total,0))::numeric,
          jsonb_build_object('gross_total',w.gross_total,'item_total',COALESCE(i.item_total,0),'difference',w.gross_total-COALESCE(i.item_total,0))
        FROM normalized w JOIN item_totals i ON i.work_order_id=w.id
        WHERE lower(COALESCE(w.status,''))='completed' AND ABS(w.gross_total-COALESCE(i.item_total,0))>=100
        UNION ALL
        SELECT 'COMPLETED_WITHOUT_ITEMS','HIGH',w.id::text,'work_order',w.location_id,w.event_time,w.work_order_number,
          w.gross_total::numeric,jsonb_build_object('gross_total',w.gross_total,'item_count',0)
        FROM normalized w LEFT JOIN item_totals i ON i.work_order_id=w.id
        WHERE lower(COALESCE(w.status,''))='completed' AND COALESCE(i.item_count,0)=0
        UNION ALL
        SELECT 'APPOINTMENT_WITHOUT_WORKORDER','HIGH',a.id::text,'appointment',a.location_id,a.start_time,'Teljesített időpont munkalap nélkül',
          a.booked_value::numeric,jsonb_build_object('booked_value',a.booked_value,'client_id',a.client_id)
        FROM completed_appointments a
        WHERE NOT EXISTS(
          SELECT 1 FROM work_orders w
          WHERE w.tenant_id=$1::uuid
            AND NULLIF(to_jsonb(w)->>'appointment_id','') IS NOT NULL
            AND (to_jsonb(w)->>'appointment_id')=a.id::text
        )
      )
      SELECT e.*,COALESCE(l.name,'Ismeretlen telephely') location_name
      FROM evidence e LEFT JOIN locations l ON l.id=e.location_id
      ORDER BY CASE e.severity WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 ELSE 2 END,e.estimated_loss DESC,e.event_time DESC
      LIMIT 500`,[s.tenantId,s.locationId,days]);
    const items=rows.map((r:any)=>({...r,estimated_loss:Math.round(n(r.estimated_loss))}));
    const byType:Record<string,{count:number;estimated_loss:number}>={};
    for(const x of items){const key=String(x.leakage_type);byType[key]??={count:0,estimated_loss:0};byType[key].count+=1;byType[key].estimated_loss+=x.estimated_loss;}
    res.json({ok:true,days,model:"evidence_based_revenue_leakage_v1",write_mode:"read_only",summary:{findings:items.length,critical:items.filter((x:any)=>x.severity==='CRITICAL').length,high:items.filter((x:any)=>x.severity==='HIGH').length,estimated_loss:items.reduce((a:number,x:any)=>a+x.estimated_loss,0)},by_type:byType,items});
  }catch(e:any){res.status(500).json({ok:false,error:e?.message||"revenue_leakage_failed"});}
});

export default router;
