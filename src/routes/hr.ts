import { Router, Request, Response, NextFunction } from "express";
import pool from "../db";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { ensureHrV2 } from "../hr/ensureHrV2";

const router = Router();
router.use(requireAuth);

const asyncRoute = (handler: (req: any, res: Response) => Promise<any>) =>
  (req: Request, res: Response, next: NextFunction) => handler(req, res).catch(next);
const n = (value: unknown) => value === "" || value == null ? null : Number(value);
function roleKeys(req:AuthRequest){const raw:any=req.user?.role;if(Array.isArray(raw))return raw.map(String).map(x=>x.toLowerCase());try{const parsed=JSON.parse(String(raw||""));if(Array.isArray(parsed))return parsed.map(String).map(x=>x.toLowerCase())}catch{}return String(raw||"").replace(/[\[\]"]/g,"").split(",").map(x=>x.trim().toLowerCase()).filter(Boolean)}
function requireHrManagement(req:AuthRequest,res:Response){const allowed=roleKeys(req).some(x=>["admin","administrator","manager","vezető","vezeto","superadmin","super_admin"].includes(x));if(!allowed){res.status(403).json({error:"A munkakörök módosításához vezetői jogosultság szükséges."});return false}return true}

async function audit(client: any, req: AuthRequest, action: string, entityType: string, entityId: string | null, oldData: any, newData: any) {
  await client.query(
    `INSERT INTO audit_log(actor_user_id,actor_role,action,entity_type,entity_id,location_id,old_data,new_data,request_id,ip_address)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,NULLIF($10,'')::inet)`,
    [String(req.user?.id ?? ""), req.user?.role ?? null, action, entityType, entityId,
     req.user?.location_id == null ? null : String(req.user.location_id), JSON.stringify(oldData ?? null),
     JSON.stringify(newData ?? null), String(req.headers["x-request-id"] ?? "") || null, req.ip || ""]
  );
}

router.get("/positions",asyncRoute(async(_req,res)=>{
  await ensureHrV2();
  const{rows}=await pool.query(`SELECT p.*,COUNT(e.id)::int employee_count FROM hr_positions p LEFT JOIN employees e ON e.position_id=p.id AND COALESCE(e.active,true)=true GROUP BY p.id ORDER BY p.is_active DESC,p.name`);
  res.json(rows);
}));

router.post("/positions",asyncRoute(async(req:AuthRequest,res)=>{
  if(!requireHrManagement(req,res))return;
  await ensureHrV2();const b=req.body||{},name=String(b.name||"").trim(),code=String(b.code||"").trim()||null;
  if(!name)return res.status(400).json({error:"A munkakör megnevezése kötelező."});
  try{const{rows}=await pool.query(`INSERT INTO hr_positions(code,name,description,department_name,management_level,revenue_target_per_hour,is_active) VALUES($1,$2,$3,$4,COALESCE($5,0),GREATEST(0,COALESCE($6,0)),COALESCE($7,true)) RETURNING *`,[code,name,String(b.description||"").trim()||null,String(b.department_name||"").trim()||null,n(b.management_level),n(b.revenue_target_per_hour),b.is_active]);await audit(pool,req,"create","hr_position",rows[0].id,null,rows[0]);res.status(201).json(rows[0])}catch(e:any){if(e?.code==="23505")return res.status(409).json({error:"Ez a munkakörkód már használatban van."});throw e}
}));

router.patch("/positions/:id",asyncRoute(async(req:AuthRequest,res)=>{
  if(!requireHrManagement(req,res))return;
  await ensureHrV2();const old=(await pool.query(`SELECT * FROM hr_positions WHERE id=$1::uuid`,[req.params.id])).rows[0];if(!old)return res.status(404).json({error:"A munkakör nem található."});
  const b=req.body||{},name=Object.prototype.hasOwnProperty.call(b,"name")?String(b.name||"").trim():old.name;if(!name)return res.status(400).json({error:"A munkakör megnevezése kötelező."});
  try{const{rows}=await pool.query(`UPDATE hr_positions SET code=$2,name=$3,description=$4,department_name=$5,management_level=COALESCE($6,management_level),revenue_target_per_hour=GREATEST(0,COALESCE($7,revenue_target_per_hour)),is_active=COALESCE($8,is_active),updated_at=now() WHERE id=$1::uuid RETURNING *`,[req.params.id,String(b.code??old.code??"").trim()||null,name,String(b.description??old.description??"").trim()||null,String(b.department_name??old.department_name??"").trim()||null,n(b.management_level),Object.prototype.hasOwnProperty.call(b,"revenue_target_per_hour")?n(b.revenue_target_per_hour):null,b.is_active]);await audit(pool,req,"update","hr_position",req.params.id,old,rows[0]);res.json(rows[0])}catch(e:any){if(e?.code==="23505")return res.status(409).json({error:"Ez a munkakörkód már használatban van."});throw e}
}));

router.get("/employment-types", asyncRoute(async (_req, res) => {
  await ensureHrV2();
  const { rows } = await pool.query("SELECT * FROM employment_types ORDER BY sort_order,name");
  res.json(rows);
}));

router.post("/employment-types", asyncRoute(async (req: AuthRequest, res) => {
  await ensureHrV2();
  const b = req.body || {};
  if (!String(b.code || "").trim() || !String(b.name || "").trim()) return res.status(400).json({ error: "A kód és a megnevezés kötelező." });
  const { rows } = await pool.query(
    `INSERT INTO employment_types(code,name,description,employee_kind,default_weekly_hours,is_active,sort_order)
     VALUES ($1,$2,$3,COALESCE($4,'employee'),$5,COALESCE($6,true),COALESCE($7,0)) RETURNING *`,
    [String(b.code).trim(), String(b.name).trim(), b.description || null, b.employee_kind || null, n(b.default_weekly_hours), b.is_active, n(b.sort_order)]
  );
  await audit(pool, req, "create", "employment_type", rows[0].id, null, rows[0]);
  res.status(201).json(rows[0]);
}));

router.patch("/employment-types/:id", asyncRoute(async (req: AuthRequest, res) => {
  await ensureHrV2();
  const old = await pool.query("SELECT * FROM employment_types WHERE id=$1", [req.params.id]);
  if (!old.rows[0]) return res.status(404).json({ error: "A foglalkoztatási forma nem található." });
  const b = req.body || {};
  const { rows } = await pool.query(
    `UPDATE employment_types SET code=COALESCE($2,code),name=COALESCE($3,name),description=$4,
     employee_kind=COALESCE($5,employee_kind),default_weekly_hours=$6,is_active=COALESCE($7,is_active),
     sort_order=COALESCE($8,sort_order),updated_at=now() WHERE id=$1 RETURNING *`,
    [req.params.id, b.code || null, b.name || null, b.description || null, b.employee_kind || null,
     n(b.default_weekly_hours), b.is_active, n(b.sort_order)]
  );
  await audit(pool, req, "update", "employment_type", req.params.id, old.rows[0], rows[0]);
  res.json(rows[0]);
}));

router.get("/employees/:id/overview", asyncRoute(async (req, res) => {
  await ensureHrV2();
  const [employee, positions, contracts, compensation, services, timesheets, leaves] = await Promise.all([
    pool.query(`SELECT e.*,l.name location_name,p.name position_name FROM employees e LEFT JOIN locations l ON l.id=e.location_id LEFT JOIN hr_positions p ON p.id=e.position_id WHERE e.id=$1`, [req.params.id]),
    pool.query(`SELECT a.*,p.name position_name,l.name location_name FROM employee_position_assignments a JOIN hr_positions p ON p.id=a.position_id LEFT JOIN locations l ON l.id=a.location_id WHERE a.employee_id=$1 ORDER BY a.is_active DESC,a.valid_from DESC`, [req.params.id]),
    pool.query(`SELECT c.*,t.code employment_type_code,t.name employment_type_name FROM employment_contracts c JOIN employment_types t ON t.id=c.employment_type_id WHERE c.employee_id=$1 ORDER BY c.start_date DESC`, [req.params.id]),
    pool.query(`SELECT a.*,p.name compensation_plan_name FROM employee_compensation_assignments a LEFT JOIN compensation_plans p ON p.id=a.compensation_plan_id WHERE a.employee_id=$1 ORDER BY a.valid_from DESC`, [req.params.id]),
    pool.query(`SELECT o.*,s.name service_name,s.base_price,s.base_duration_minutes FROM employee_service_overrides o JOIN services s ON s.id=o.service_id WHERE o.employee_id=$1 ORDER BY s.name`, [req.params.id]),
    pool.query(`SELECT t.*,l.name location_name FROM timesheets t LEFT JOIN locations l ON l.id=t.location_id WHERE t.employee_id=$1 ORDER BY t.work_date DESC LIMIT 10`, [req.params.id]),
    pool.query(`SELECT r.*,t.name leave_type_name,t.color FROM leave_requests r JOIN leave_types t ON t.id=r.leave_type_id WHERE r.employee_id=$1 ORDER BY r.date_from DESC LIMIT 10`, [req.params.id])
  ]);
  if (!employee.rows[0]) return res.status(404).json({ error: "A munkatárs nem található." });
  res.json({ employee: employee.rows[0], positions: positions.rows, contracts: contracts.rows, compensation: compensation.rows, services: services.rows, timesheets: timesheets.rows, leaves: leaves.rows });
}));

router.post("/employees/:id/positions", asyncRoute(async (req: AuthRequest, res) => {
  await ensureHrV2();
  const b = req.body || {};
  if (!b.position_id) return res.status(400).json({ error: "A munkakör kötelező." });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (b.is_primary !== false) await client.query("UPDATE employee_position_assignments SET is_active=false,valid_to=COALESCE(valid_to,CURRENT_DATE),updated_at=now() WHERE employee_id=$1 AND is_primary AND is_active", [req.params.id]);
    const { rows } = await client.query(
      `INSERT INTO employee_position_assignments(employee_id,position_id,location_id,is_primary,weekly_hours,valid_from,valid_to,is_active)
       VALUES ($1,$2,$3,COALESCE($4,true),$5,COALESCE($6,CURRENT_DATE),$7,true) RETURNING *`,
      [req.params.id,b.position_id,b.location_id || null,b.is_primary,n(b.weekly_hours),b.valid_from || null,b.valid_to || null]
    );
    if (b.is_primary !== false) await client.query("UPDATE employees SET position_id=$2,location_id=COALESCE($3,location_id),updated_at=now() WHERE id=$1", [req.params.id,b.position_id,b.location_id || null]);
    await audit(client, req, "assign", "employee_position", rows[0].id, null, rows[0]);
    await client.query("COMMIT");
    res.status(201).json(rows[0]);
  } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
}));

router.post("/employees/:id/contracts", asyncRoute(async (req: AuthRequest, res) => {
  await ensureHrV2();
  const b = req.body || {};
  if (!b.employment_type_id || !b.start_date) return res.status(400).json({ error: "A foglalkoztatási forma és a kezdőnap kötelező." });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (b.is_active !== false) await client.query("UPDATE employment_contracts SET is_active=false,updated_at=now() WHERE employee_id=$1 AND is_active", [req.params.id]);
    const { rows } = await client.query(
      `INSERT INTO employment_contracts(employee_id,employment_type_id,contract_number,start_date,end_date,probation_end_date,weekly_hours,work_schedule_type,cost_center,tax_category,notes,document_url,is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,COALESCE($13,true)) RETURNING *`,
      [req.params.id,b.employment_type_id,b.contract_number || null,b.start_date,b.end_date || null,b.probation_end_date || null,n(b.weekly_hours),b.work_schedule_type || null,b.cost_center || null,b.tax_category || null,b.notes || null,b.document_url || null,b.is_active]
    );
    await client.query(`UPDATE employees SET employment_type=(SELECT code FROM employment_types WHERE id=$2),updated_at=now() WHERE id=$1`, [req.params.id,b.employment_type_id]);
    await audit(client, req, "create", "employment_contract", rows[0].id, null, rows[0]);
    await client.query("COMMIT");
    res.status(201).json(rows[0]);
  } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
}));

router.get("/compensation-plans", asyncRoute(async (_req, res) => {
  await ensureHrV2();
  const { rows } = await pool.query("SELECT * FROM compensation_plans ORDER BY is_active DESC,name");
  res.json(rows);
}));

router.post("/compensation-plans", asyncRoute(async (req: AuthRequest, res) => {
  await ensureHrV2();
  const b = req.body || {};
  if (!String(b.name || "").trim()) return res.status(400).json({ error: "A bércsomag neve kötelező." });
  const { rows } = await pool.query(
    `INSERT INTO compensation_plans(name,code,description,monthly_base,hourly_rate,daily_rate,shift_rate,service_commission_percent,product_commission_percent,revenue_commission_percent,attendance_bonus,target_bonus,overtime_multiplier,weekend_multiplier,evening_multiplier,currency,is_active)
     VALUES ($1,$2,$3,COALESCE($4,0),COALESCE($5,0),COALESCE($6,0),COALESCE($7,0),COALESCE($8,0),COALESCE($9,0),COALESCE($10,0),COALESCE($11,0),COALESCE($12,0),COALESCE($13,1.5),COALESCE($14,1),COALESCE($15,1),COALESCE($16,'HUF'),COALESCE($17,true)) RETURNING *`,
    [String(b.name).trim(),b.code || null,b.description || null,n(b.monthly_base),n(b.hourly_rate),n(b.daily_rate),n(b.shift_rate),n(b.service_commission_percent),n(b.product_commission_percent),n(b.revenue_commission_percent),n(b.attendance_bonus),n(b.target_bonus),n(b.overtime_multiplier),n(b.weekend_multiplier),n(b.evening_multiplier),b.currency || null,b.is_active]
  );
  await audit(pool, req, "create", "compensation_plan", rows[0].id, null, rows[0]);
  res.status(201).json(rows[0]);
}));

router.post("/employees/:id/compensation", asyncRoute(async (req: AuthRequest, res) => {
  await ensureHrV2();
  const b = req.body || {};
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE employee_compensation_assignments SET is_active=false,valid_to=COALESCE(valid_to,CURRENT_DATE) WHERE employee_id=$1 AND is_active", [req.params.id]);
    const { rows } = await client.query(
      `INSERT INTO employee_compensation_assignments(employee_id,compensation_plan_id,monthly_base,hourly_rate,daily_rate,service_commission_percent,product_commission_percent,revenue_commission_percent,valid_from,valid_to,reason,is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,CURRENT_DATE),$10,$11,true) RETURNING *`,
      [req.params.id,b.compensation_plan_id || null,n(b.monthly_base),n(b.hourly_rate),n(b.daily_rate),n(b.service_commission_percent),n(b.product_commission_percent),n(b.revenue_commission_percent),b.valid_from || null,b.valid_to || null,b.reason || null]
    );
    await client.query("UPDATE employees SET monthly_wage=$2,hourly_wage=$3,commission_percent=$4,updated_at=now() WHERE id=$1", [req.params.id,n(b.monthly_base),n(b.hourly_rate),n(b.service_commission_percent)]);
    await audit(client, req, "assign", "employee_compensation", rows[0].id, null, rows[0]);
    await client.query("COMMIT");
    res.status(201).json(rows[0]);
  } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
}));

router.get("/timesheets", asyncRoute(async (req, res) => {
  await ensureHrV2();
  const { rows } = await pool.query(`SELECT t.*,e.full_name,l.name location_name FROM timesheets t JOIN employees e ON e.id=t.employee_id LEFT JOIN locations l ON l.id=t.location_id WHERE ($1::date IS NULL OR t.work_date >= $1) AND ($2::date IS NULL OR t.work_date <= $2) AND ($3::uuid IS NULL OR t.employee_id=$3) ORDER BY t.work_date DESC,e.full_name`, [req.query.from || null,req.query.to || null,req.query.employee_id || null]);
  res.json(rows);
}));

router.get("/attendance-summary", asyncRoute(async (req, res) => {
  await ensureHrV2();
  const from = req.query.from || new Date().toISOString().slice(0, 8) + "01";
  const to = req.query.to || new Date().toISOString().slice(0, 10);
  const { rows } = await pool.query(
    `SELECT COUNT(DISTINCT t.employee_id)::int employee_count,
            COALESCE(SUM(t.regular_minutes),0)::int regular_minutes,
            COALESCE(SUM(t.overtime_minutes),0)::int overtime_minutes,
            COALESCE(SUM(t.break_minutes),0)::int break_minutes,
            COUNT(*) FILTER (WHERE t.status='approved')::int approved_count,
            COUNT(*) FILTER (WHERE t.status<>'approved')::int open_count,
            (SELECT COUNT(*)::int FROM leave_requests r WHERE r.status='pending' AND r.date_from <= $2::date AND r.date_to >= $1::date) pending_leave_count
     FROM timesheets t WHERE t.work_date BETWEEN $1::date AND $2::date`,
    [from, to]
  );
  res.json({ ...rows[0], from, to });
}));

router.post("/timesheets", asyncRoute(async (req: AuthRequest, res) => {
  await ensureHrV2(); const b=req.body||{};
  if (!b.employee_id || !b.work_date) return res.status(400).json({ error: "A munkatárs és a munkanap kötelező." });
  const { rows } = await pool.query(`INSERT INTO timesheets(employee_id,location_id,work_date,clock_in,clock_out,break_minutes,regular_minutes,overtime_minutes,status,note) VALUES($1,$2,$3,$4,$5,COALESCE($6,0),COALESCE($7,0),COALESCE($8,0),COALESCE($9,'draft'),$10) ON CONFLICT(employee_id,work_date) DO UPDATE SET location_id=EXCLUDED.location_id,clock_in=EXCLUDED.clock_in,clock_out=EXCLUDED.clock_out,break_minutes=EXCLUDED.break_minutes,regular_minutes=EXCLUDED.regular_minutes,overtime_minutes=EXCLUDED.overtime_minutes,status=EXCLUDED.status,note=EXCLUDED.note,updated_at=now() RETURNING *`, [b.employee_id,b.location_id||null,b.work_date,b.clock_in||null,b.clock_out||null,n(b.break_minutes),n(b.regular_minutes),n(b.overtime_minutes),b.status||null,b.note||null]);
  await audit(pool,req,"upsert","timesheet",rows[0].id,null,rows[0]); res.status(201).json(rows[0]);
}));

router.patch("/timesheets/:id/status", asyncRoute(async (req: AuthRequest, res) => {
  await ensureHrV2();
  const status = String(req.body?.status || "");
  if (!["draft", "submitted", "approved", "rejected"].includes(status)) return res.status(400).json({ error: "Érvénytelen jelenléti státusz." });
  const old = await pool.query("SELECT * FROM timesheets WHERE id=$1", [req.params.id]);
  if (!old.rows[0]) return res.status(404).json({ error: "A jelenléti sor nem található." });
  const { rows } = await pool.query(
    `UPDATE timesheets SET status=$2,approved_by=CASE WHEN $2='approved' THEN $3 ELSE NULL END,
     approved_at=CASE WHEN $2='approved' THEN now() ELSE NULL END,updated_at=now() WHERE id=$1 RETURNING *`,
    [req.params.id, status, String(req.user?.id ?? "") || null]
  );
  await audit(pool, req, "status", "timesheet", req.params.id, old.rows[0], rows[0]);
  res.json(rows[0]);
}));

router.get("/leave-types", asyncRoute(async (_req,res)=>{ await ensureHrV2(); const {rows}=await pool.query("SELECT * FROM leave_types ORDER BY name"); res.json(rows); }));
router.get("/leave-requests", asyncRoute(async (req,res)=>{ await ensureHrV2(); const {rows}=await pool.query(`SELECT r.*,e.full_name,t.name leave_type_name,t.color FROM leave_requests r JOIN employees e ON e.id=r.employee_id JOIN leave_types t ON t.id=r.leave_type_id WHERE ($1::uuid IS NULL OR r.employee_id=$1) ORDER BY r.date_from DESC`,[req.query.employee_id||null]); res.json(rows); }));
router.post("/leave-requests", asyncRoute(async (req:AuthRequest,res)=>{ await ensureHrV2(); const b=req.body||{}; if(!b.employee_id||!b.leave_type_id||!b.date_from||!b.date_to)return res.status(400).json({error:"A munkatárs, távolléttípus és dátumok kötelezők."}); const {rows}=await pool.query(`INSERT INTO leave_requests(employee_id,leave_type_id,date_from,date_to,minutes_per_day,reason,status) VALUES($1,$2,$3,$4,$5,$6,COALESCE($7,'pending')) RETURNING *`,[b.employee_id,b.leave_type_id,b.date_from,b.date_to,n(b.minutes_per_day),b.reason||null,b.status||null]); await audit(pool,req,"create","leave_request",rows[0].id,null,rows[0]); res.status(201).json(rows[0]); }));
router.patch("/leave-requests/:id", asyncRoute(async (req:AuthRequest,res)=>{ await ensureHrV2(); const old=await pool.query("SELECT * FROM leave_requests WHERE id=$1",[req.params.id]); if(!old.rows[0])return res.status(404).json({error:"A kérelem nem található."}); const status=String(req.body?.status||""); if(!["pending","approved","rejected","cancelled"].includes(status))return res.status(400).json({error:"Érvénytelen távolléti státusz."}); const {rows}=await pool.query(`UPDATE leave_requests SET status=$2,approved_by=CASE WHEN $2 IN ('approved','rejected') THEN $3 ELSE NULL END,approved_at=CASE WHEN $2 IN ('approved','rejected') THEN now() ELSE NULL END,updated_at=now() WHERE id=$1 RETURNING *`,[req.params.id,status,String(req.user?.id??"")||null]); await audit(pool,req,"status","leave_request",req.params.id,old.rows[0],rows[0]); res.json(rows[0]); }));

router.get("/audit", asyncRoute(async (req,res)=>{ await ensureHrV2(); const limit=Math.min(Number(req.query.limit)||100,500); const {rows}=await pool.query("SELECT * FROM audit_log ORDER BY created_at DESC LIMIT $1",[limit]); res.json(rows); }));

export default router;
