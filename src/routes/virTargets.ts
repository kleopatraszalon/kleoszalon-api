import { Router } from "express";
import pool from "../db";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { ensureHrV2 } from "../hr/ensureHrV2";

const router = Router();
router.use(requireAuth);

const roles=(raw:unknown)=>Array.isArray(raw)?raw.map(String).map(x=>x.toLowerCase()):String(raw||"").replace(/[\[\]"]/g,"").split(",").map(x=>x.trim().toLowerCase()).filter(Boolean);
const crossLocationRoles=new Set(["admin","administrator","rendszergazda","superadmin","super_admin","manager","vezető","vezeto","hr","hr_manager"]);
const dateValue=(value:unknown)=>/^\d{4}-\d{2}-\d{2}$/.test(String(value||""))?String(value):"";
function scopedLocation(req:AuthRequest){
  const own=String(req.user?.location_id||"").trim();
  const requested=String(req.query.locationId||req.query.location_id||"").trim();
  return own&&!roles(req.user?.role).some(x=>crossLocationRoles.has(x))?own:(requested||own||null);
}

router.get("/daily-plan", async (req:AuthRequest, res) => {
  try {
    await ensureHrV2();
    const date=dateValue(req.query.date);
    if(!date)return res.status(400).json({ok:false,error:"Érvényes date paraméter szükséges (YYYY-MM-DD)."});
    const locationId=scopedLocation(req);
    const [fallbackResult,shiftResult]=await Promise.all([
      pool.query(`SELECT target_value FROM vir_kpi_targets
        WHERE kpi_key='default_revenue_per_work_hour'
          AND (location_id IS NULL OR location_id::text=$1::text)
        ORDER BY (location_id IS NOT NULL) DESC LIMIT 1`,[locationId]),
      pool.query(`SELECT s.employee_id::text,e.full_name,p.id::text position_id,
          COALESCE(p.name,'Nincs munkakör') position_name,
          COALESCE(p.revenue_target_per_hour,0)::numeric revenue_target_per_hour,
          GREATEST(0,ROUND(EXTRACT(EPOCH FROM (s.ends_at-s.starts_at))/60)-COALESCE(s.break_minutes,0))::int scheduled_minutes
        FROM work_shifts s
        JOIN employees e ON e.id=s.employee_id
        LEFT JOIN hr_positions p ON p.id=e.position_id
        WHERE s.work_date=$1::date AND s.status<>'cancelled'
          AND ($2::text IS NULL OR COALESCE(s.location_id::text,e.location_id::text)=$2::text)
        ORDER BY e.full_name,s.starts_at`,[date,locationId])
    ]);
    const defaultHourly=Math.max(0,Number(fallbackResult.rows[0]?.target_value||0));
    const items=shiftResult.rows.map((row:any)=>{
      const minutes=Math.max(0,Number(row.scheduled_minutes||0));
      const positionHourly=Math.max(0,Number(row.revenue_target_per_hour||0));
      const hourlyTarget=positionHourly||defaultHourly;
      return{...row,scheduled_minutes:minutes,revenue_target_per_hour:hourlyTarget,planned_revenue:Math.round(minutes/60*hourlyTarget)};
    });
    const summary=items.reduce((acc:any,item:any)=>{acc.scheduled_minutes+=item.scheduled_minutes;acc.daily_revenue_target+=item.planned_revenue;acc.employee_ids.add(item.employee_id);return acc},{scheduled_minutes:0,daily_revenue_target:0,employee_ids:new Set<string>()});
    const byPosition=new Map<string,any>();
    for(const item of items){const key=item.position_id||"unassigned",current=byPosition.get(key)||{position_id:item.position_id,position_name:item.position_name,scheduled_minutes:0,daily_revenue_target:0};current.scheduled_minutes+=item.scheduled_minutes;current.daily_revenue_target+=item.planned_revenue;byPosition.set(key,current)}
    res.json({ok:true,date,location_id:locationId,default_revenue_per_work_hour:defaultHourly,summary:{scheduled_minutes:summary.scheduled_minutes,scheduled_hours:Number((summary.scheduled_minutes/60).toFixed(2)),employee_count:summary.employee_ids.size,daily_revenue_target:summary.daily_revenue_target},by_position:Array.from(byPosition.values()),items});
  } catch (err:any) {
    res.status(500).json({ok:false,error:err.message||"daily_revenue_plan_failed"});
  }
});

router.get("/", async (req:AuthRequest, res) => {
  try {
    const locationId=scopedLocation(req);
    const { rows } = await pool.query(
      `SELECT kpi_key, target_value
       FROM vir_kpi_targets
       WHERE location_id IS NULL OR location_id::text = $1::text
       ORDER BY (location_id IS NOT NULL) ASC`,
      [locationId]
    );
    const targets: Record<string, number> = {};
    rows.forEach((row:any)=>{targets[row.kpi_key]=Number(row.target_value)});
    res.json({ok:true,targets});
  } catch (err:any) {
    res.status(500).json({ok:false,error:err.message||"vir_targets_failed"});
  }
});

export default router;
