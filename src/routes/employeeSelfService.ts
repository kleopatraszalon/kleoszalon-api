import { Router, Response, NextFunction } from "express";
import pool from "../db";
import { AuthRequest, requireAuth } from "../middleware/auth";
import { requireAdmin } from "../middleware/requireRoles";
import { ensureHrV2 } from "../hr/ensureHrV2";
import { ensureLegacyEvaluation2018Schema, syncLegacyTaskRedXById } from "../services/legacyEvaluation2018";

const router = Router();
router.use(requireAuth);

const asyncRoute =
  (handler: (req: AuthRequest, res: Response) => Promise<any>) =>
  (req: AuthRequest, res: Response, next: NextFunction) => handler(req, res).catch(next);

const TEAM_MODULES = [
  "schedule","attendance","workorders","tasks","chat","knowledge","checklists","quiz","training","evaluations","compensation",
] as const;
type TeamModule = (typeof TEAM_MODULES)[number];
const DEFAULT_TEAM_CONFIG = {
  enabled: true,
  brand_name: "Kleo Team",
  welcome_message: "Kleopátra dolgozói és partneri portál",
  modules: Object.fromEntries(TEAM_MODULES.map((key) => [key, true])) as Record<TeamModule, boolean>,
};
let teamSchemaReady: Promise<void> | null = null;

const actor = (req: AuthRequest) => req.user?.email || String(req.user?.id || "");

async function ensureKleoTeamSchema() {
  if (!teamSchemaReady) {
    teamSchemaReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS kleo_team_settings (
          singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton=true),
          config jsonb NOT NULL DEFAULT '{}'::jsonb,
          updated_by text,
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS kleo_team_employee_permissions (
          employee_id text NOT NULL,
          module_key text NOT NULL,
          can_use boolean NOT NULL,
          updated_by text,
          updated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY(employee_id,module_key)
        );
        CREATE TABLE IF NOT EXISTS kleo_team_audit (
          id bigserial PRIMARY KEY,
          action text NOT NULL,
          employee_id text,
          payload jsonb,
          actor text,
          created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS hr_training_courses (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text NOT NULL, role_key text NOT NULL,
          category text NOT NULL, provider text, source_url text, description text, duration_hours numeric,
          mandatory boolean DEFAULT false, active boolean DEFAULT true
        );
        CREATE TABLE IF NOT EXISTS hr_training_enrollments (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(), course_id uuid REFERENCES hr_training_courses(id),
          employee_id uuid NOT NULL, scheduled_at timestamptz, due_date date, completed_at timestamptz,
          status text DEFAULT 'planned', score numeric, certificate_url text, notes text
        );
        CREATE TABLE IF NOT EXISTS hr_employee_evaluations (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(), employee_id uuid NOT NULL, evaluator_id uuid,
          period_start date NOT NULL, period_end date NOT NULL, status text DEFAULT 'draft',
          professional_score numeric DEFAULT 0, guest_score numeric DEFAULT 0, sales_score numeric DEFAULT 0,
          teamwork_score numeric DEFAULT 0, hygiene_score numeric DEFAULT 0, attendance_score numeric DEFAULT 0,
          overall_score numeric DEFAULT 0, strengths text, development_goals text, manager_comment text,
          employee_comment text, approved_at timestamptz, created_at timestamptz DEFAULT now()
        );
        ALTER TABLE hr_employee_evaluations ADD COLUMN IF NOT EXISTS employee_comment text;
        ALTER TABLE hr_employee_evaluations ADD COLUMN IF NOT EXISTS approved_at timestamptz;
      `);
      await pool.query(
        `INSERT INTO kleo_team_settings(singleton,config) VALUES(true,$1::jsonb)
         ON CONFLICT(singleton) DO NOTHING`,
        [JSON.stringify(DEFAULT_TEAM_CONFIG)],
      );
    })().catch((error) => { teamSchemaReady = null; throw error; });
  }
  return teamSchemaReady;
}

async function currentEmployee(req: AuthRequest) {
  const id = String(req.user?.id ?? "").trim();
  const email = String(req.user?.email ?? "").trim();
  const { rows } = await pool.query(
    `SELECT e.id,e.full_name,e.email,e.login_name,e.location_id,l.name AS location_name,
            e.position_id,p.name AS position_name,to_jsonb(e)->>'role' AS role
       FROM employees e
       LEFT JOIN locations l ON l.id=e.location_id
       LEFT JOIN hr_positions p ON p.id=e.position_id
      WHERE COALESCE(e.active,true)=true
        AND (e.id::text=$1 OR ($2<>'' AND (lower(COALESCE(e.email,''))=lower($2) OR lower(COALESCE(e.login_name,''))=lower($2))))
      ORDER BY CASE WHEN e.id::text=$1 THEN 0 ELSE 1 END
      LIMIT 1`,
    [id,email]
  );
  return rows[0] ?? null;
}

async function readTeamConfig(employeeId?: string) {
  await ensureKleoTeamSchema();
  const row = (await pool.query(`SELECT config,updated_by,updated_at FROM kleo_team_settings WHERE singleton=true`)).rows[0];
  const raw = row?.config && typeof row.config === "object" ? row.config : {};
  const globalModules = { ...DEFAULT_TEAM_CONFIG.modules, ...(raw.modules || {}) } as Record<string, boolean>;
  const overrides = employeeId
    ? (await pool.query(`SELECT module_key,can_use FROM kleo_team_employee_permissions WHERE employee_id=$1`,[employeeId])).rows
    : [];
  const overrideMap = new Map(overrides.map((x:any)=>[String(x.module_key),Boolean(x.can_use)]));
  const modules = Object.fromEntries(TEAM_MODULES.map((key)=>[key,Boolean(globalModules[key]) && (overrideMap.has(key) ? Boolean(overrideMap.get(key)) : true)]));
  return {
    enabled: raw.enabled !== false,
    brand_name: String(raw.brand_name || DEFAULT_TEAM_CONFIG.brand_name),
    welcome_message: String(raw.welcome_message || DEFAULT_TEAM_CONFIG.welcome_message),
    modules,
    global_modules: globalModules,
    updated_by: row?.updated_by ?? null,
    updated_at: row?.updated_at ?? null,
  };
}

async function assertModule(employeeId:string,key:TeamModule) {
  const config = await readTeamConfig(employeeId);
  if (!config.enabled || !config.modules[key]) throw Object.assign(new Error("Ez a Kleo Team modul az Ön fiókjában nincs engedélyezve."),{status:403});
}

router.get("/config", asyncRoute(async (req,res) => {
  const employee = await currentEmployee(req);
  if (!employee) return res.status(404).json({ error:"A belépett felhasználóhoz nem található aktív munkatársi rekord." });
  res.json({ employee, ...(await readTeamConfig(String(employee.id))) });
}));

router.get("/dashboard", asyncRoute(async (req, res) => {
  await ensureHrV2();
  await ensureKleoTeamSchema();
  await ensureLegacyEvaluation2018Schema();
  const employee = await currentEmployee(req);
  if (!employee) return res.status(404).json({ error: "A belépett felhasználóhoz nem található aktív munkatársi rekord." });

  const year = Number(req.query.year || new Date().getFullYear());
  if (!Number.isInteger(year) || year < 2000 || year > 2200) return res.status(400).json({ error: "Érvénytelen év." });
  const yearStart = `${year}-01-01`, yearEnd = `${year}-12-31`;

  await pool.query(
    `INSERT INTO employee_leave_balances(employee_id,balance_year,entitlement_days)
     VALUES($1,$2,20) ON CONFLICT(employee_id,balance_year) DO NOTHING`,
    [employee.id,year]
  );

  const [attendance, leaveBalance, leaves, shifts, tasks] = await Promise.all([
    pool.query(
      `SELECT
         COUNT(DISTINCT work_date) FILTER (WHERE COALESCE(regular_minutes,0)+COALESCE(overtime_minutes,0)>0)::int AS worked_days_year,
         COUNT(DISTINCT work_date) FILTER (WHERE date_trunc('month',work_date)=date_trunc('month',CURRENT_DATE) AND COALESCE(regular_minutes,0)+COALESCE(overtime_minutes,0)>0)::int AS worked_days_month,
         COALESCE(SUM(regular_minutes),0)::int AS regular_minutes_year,
         COALESCE(SUM(overtime_minutes),0)::int AS overtime_minutes_year
       FROM timesheets
       WHERE employee_id=$1 AND work_date BETWEEN $2::date AND $3::date`,
      [employee.id,yearStart,yearEnd]
    ),
    pool.query(
      `WITH base AS (
         SELECT entitlement_days,carried_days,adjustment_days
           FROM employee_leave_balances WHERE employee_id=$1 AND balance_year=$2
       ), annual_days AS (
         SELECT r.status, COUNT(*) FILTER (WHERE EXTRACT(ISODOW FROM d.day)<6)::numeric AS days
           FROM leave_requests r JOIN leave_types t ON t.id=r.leave_type_id AND lower(t.code)='annual'
           CROSS JOIN LATERAL generate_series(GREATEST(r.date_from,$3::date),LEAST(r.date_to,$4::date),interval '1 day') AS d(day)
          WHERE r.employee_id=$1 AND r.date_from<=$4::date AND r.date_to>=$3::date GROUP BY r.status
       )
       SELECT b.entitlement_days,b.carried_days,b.adjustment_days,
              COALESCE((SELECT SUM(days) FROM annual_days WHERE status='approved'),0)::numeric AS taken_days,
              COALESCE((SELECT SUM(days) FROM annual_days WHERE status='pending'),0)::numeric AS pending_days,
              (b.entitlement_days+b.carried_days+b.adjustment_days-COALESCE((SELECT SUM(days) FROM annual_days WHERE status='approved'),0))::numeric AS remaining_days
         FROM base b`,
      [employee.id,year,yearStart,yearEnd]
    ),
    pool.query(
      `SELECT r.id,t.name AS leave_type_name,t.code AS leave_type_code,r.date_from,r.date_to,r.status,r.reason
         FROM leave_requests r JOIN leave_types t ON t.id=r.leave_type_id
        WHERE r.employee_id=$1 AND r.date_to>=CURRENT_DATE-interval '60 days'
        ORDER BY r.date_from DESC LIMIT 20`,[employee.id]
    ),
    pool.query(
      `SELECT id,work_date,starts_at,ends_at,break_minutes,shift_type,status,is_overtime,is_training,note
         FROM work_shifts WHERE employee_id=$1 AND status<>'cancelled' AND work_date BETWEEN CURRENT_DATE AND CURRENT_DATE+31
        ORDER BY work_date,starts_at LIMIT 80`,[employee.id]
    ),
    pool.query(
      `SELECT id,title,description,priority,status,due_at,recurrence,requires_approval,completed_at,approved_at,approved_by
         FROM operations_quality_records WHERE module_key='tasks' AND employee_id=$1
          AND (status NOT IN ('approved','cancelled','archived') OR due_at>=CURRENT_DATE-interval '90 days')
        ORDER BY CASE WHEN status='completed' THEN 0 WHEN due_at<now() THEN 1 ELSE 2 END,due_at NULLS LAST,created_at DESC LIMIT 100`,[employee.id]
    )
  ]);

  res.json({
    employee, year, team: await readTeamConfig(String(employee.id)),
    attendance: attendance.rows[0] ?? {},
    leave: leaveBalance.rows[0] ?? { entitlement_days:20,carried_days:0,adjustment_days:0,taken_days:0,pending_days:0,remaining_days:20 },
    leave_requests: leaves.rows, upcoming_shifts: shifts.rows, tasks: tasks.rows,
  });
}));

router.get("/development", asyncRoute(async (req,res) => {
  await ensureKleoTeamSchema();
  const employee = await currentEmployee(req);
  if (!employee) return res.status(404).json({error:"Munkatársi rekord nem található."});
  const cfg=await readTeamConfig(String(employee.id));
  if(!cfg.enabled || (!cfg.modules.training&&!cfg.modules.evaluations)) return res.status(403).json({error:"A fejlődés modul nincs engedélyezve."});
  const [training,evaluations]=await Promise.all([
    pool.query(`SELECT x.id,x.scheduled_at,x.due_date,x.completed_at,x.status,x.score,x.certificate_url,x.notes,c.title,c.category,c.provider,c.source_url,c.description,c.duration_hours,c.mandatory FROM hr_training_enrollments x JOIN hr_training_courses c ON c.id=x.course_id WHERE x.employee_id=$1 ORDER BY CASE WHEN x.status='completed' THEN 1 ELSE 0 END,x.due_date NULLS LAST,c.title`,[employee.id]),
    pool.query(`SELECT id,period_start,period_end,status,professional_score,guest_score,sales_score,teamwork_score,hygiene_score,attendance_score,overall_score,strengths,development_goals,manager_comment,employee_comment,approved_at,created_at FROM hr_employee_evaluations WHERE employee_id=$1 ORDER BY period_end DESC,created_at DESC LIMIT 30`,[employee.id])
  ]);
  res.json({employee,training:training.rows,evaluations:evaluations.rows});
}));

router.patch("/evaluations/:id/comment", asyncRoute(async(req,res)=>{
  await ensureKleoTeamSchema();
  const employee=await currentEmployee(req); if(!employee)return res.status(404).json({error:"Munkatársi rekord nem található."});
  await assertModule(String(employee.id),"evaluations");
  const comment=String(req.body?.comment||"").trim().slice(0,4000);
  const row=(await pool.query(`UPDATE hr_employee_evaluations SET employee_comment=$3 WHERE id=$1::uuid AND employee_id=$2 RETURNING *`,[req.params.id,employee.id,comment||null])).rows[0];
  if(!row)return res.status(404).json({error:"Az értékelés nem található."}); res.json(row);
}));

router.get("/compensation", asyncRoute(async(req,res)=>{
  await ensureHrV2();
  const employee=await currentEmployee(req); if(!employee)return res.status(404).json({error:"Munkatársi rekord nem található."});
  await assertModule(String(employee.id),"compensation");
  const [assignment,latest]=await Promise.all([
    pool.query(`SELECT a.*,p.name plan_name,p.code plan_code,p.description plan_description,p.calculation_mode,p.currency,p.monthly_base plan_monthly_base,p.hourly_rate plan_hourly_rate,p.daily_rate plan_daily_rate,p.service_commission_percent,p.product_commission_percent,p.revenue_commission_percent,p.attendance_bonus,p.target_bonus,p.monthly_target FROM employee_compensation_assignments a LEFT JOIN compensation_plans p ON p.id=a.compensation_plan_id WHERE a.employee_id=$1 AND a.is_active ORDER BY a.valid_from DESC,a.created_at DESC LIMIT 1`,[employee.id]),
    pool.query(`SELECT r.period_from,r.period_to,r.title,r.status run_status,r.approved_at,i.regular_minutes,i.overtime_minutes,i.worked_days,i.service_revenue,i.product_revenue,i.total_revenue,i.base_pay,i.overtime_pay,i.service_commission,i.product_commission,i.revenue_commission,i.attendance_bonus,i.target_bonus,i.deductions,i.gross_pay,i.net_pay FROM payroll_items i JOIN payroll_runs r ON r.id=i.payroll_run_id WHERE i.employee_id=$1 AND r.status IN ('calculated','approved','paid') ORDER BY r.period_to DESC,r.created_at DESC LIMIT 12`,[employee.id])
  ]);
  res.json({employee,assignment:assignment.rows[0]||null,payroll_history:latest.rows});
}));

router.post("/tasks/:id/complete", asyncRoute(async (req,res) => {
  await ensureLegacyEvaluation2018Schema();
  const employee = await currentEmployee(req);
  if (!employee) return res.status(404).json({ error: "A belépett felhasználóhoz nem található aktív munkatársi rekord." });
  await assertModule(String(employee.id),"tasks");
  const task = (await pool.query(
    `UPDATE operations_quality_records SET status='completed',completed_at=now(),approved_by=NULL,approved_at=NULL,
            metadata=metadata||jsonb_build_object('employee_completed_at',now()::text),updated_at=now()
      WHERE id=$1::uuid AND module_key='tasks' AND employee_id=$2 AND status NOT IN ('approved','cancelled','archived') RETURNING *`,
    [req.params.id,employee.id]
  )).rows[0];
  if (!task) return res.status(404).json({ error: "A feladat nem található, nem Önhöz tartozik, vagy már lezárt." });
  await syncLegacyTaskRedXById(String(task.id));
  res.json({ ok:true, task, message:"A feladat elvégzett állapotba került, vezetői jóváhagyásra vár." });
}));

router.get("/admin/config",requireAdmin,asyncRoute(async(_req,res)=>{
  await ensureKleoTeamSchema(); const config=await readTeamConfig();
  const counts=(await pool.query(`SELECT COUNT(*)::int total,COUNT(*) FILTER(WHERE COALESCE(active,true))::int active FROM employees`)).rows[0];
  res.json({config,modules:TEAM_MODULES,employees:counts});
}));

router.put("/admin/config",requireAdmin,asyncRoute(async(req,res)=>{
  await ensureKleoTeamSchema(); const current=await readTeamConfig(); const b=req.body||{};
  const modules={...current.global_modules};
  if(b.modules&&typeof b.modules==='object')for(const key of TEAM_MODULES)if(Object.prototype.hasOwnProperty.call(b.modules,key))modules[key]=Boolean(b.modules[key]);
  const next={enabled:Object.prototype.hasOwnProperty.call(b,'enabled')?Boolean(b.enabled):current.enabled,brand_name:String(b.brand_name??current.brand_name).trim().slice(0,80)||'Kleo Team',welcome_message:String(b.welcome_message??current.welcome_message).trim().slice(0,240),modules};
  await pool.query(`INSERT INTO kleo_team_settings(singleton,config,updated_by,updated_at) VALUES(true,$1::jsonb,$2,now()) ON CONFLICT(singleton) DO UPDATE SET config=EXCLUDED.config,updated_by=EXCLUDED.updated_by,updated_at=now()`,[JSON.stringify(next),actor(req)]);
  await pool.query(`INSERT INTO kleo_team_audit(action,payload,actor) VALUES('config.update',$1::jsonb,$2)`,[JSON.stringify(next),actor(req)]);
  res.json({ok:true,config:await readTeamConfig()});
}));

router.get("/admin/employees",requireAdmin,asyncRoute(async(_req,res)=>{
  await ensureKleoTeamSchema();
  const [employees,permissions]=await Promise.all([
    pool.query(`SELECT e.id::text id,COALESCE(NULLIF(e.full_name,''),NULLIF(e.email,''),'Munkatárs') full_name,e.email,COALESCE(p.name,'') position_name,COALESCE(l.name,'') location_name,COALESCE(e.active,true) active FROM employees e LEFT JOIN hr_positions p ON p.id=e.position_id LEFT JOIN locations l ON l.id=e.location_id WHERE COALESCE(e.active,true)=true ORDER BY lower(COALESCE(e.full_name,e.email,'')) LIMIT 5000`),
    pool.query(`SELECT employee_id,module_key,can_use FROM kleo_team_employee_permissions`)
  ]);
  const map:Record<string,Record<string,boolean>>={}; for(const x of permissions.rows){(map[String(x.employee_id)]||={})[String(x.module_key)]=Boolean(x.can_use)}
  res.json({modules:TEAM_MODULES,employees:employees.rows.map((e:any)=>({...e,permissions:map[e.id]||{}}))});
}));

router.put("/admin/employees/:id",requireAdmin,asyncRoute(async(req,res)=>{
  await ensureKleoTeamSchema(); const id=String(req.params.id); const permissions=req.body?.permissions||{};
  const exists=(await pool.query(`SELECT id FROM employees WHERE id::text=$1 LIMIT 1`,[id])).rows[0]; if(!exists)return res.status(404).json({error:"A munkatárs nem található."});
  const c=await pool.connect(); try{await c.query('BEGIN');for(const key of TEAM_MODULES){if(!Object.prototype.hasOwnProperty.call(permissions,key))continue;await c.query(`INSERT INTO kleo_team_employee_permissions(employee_id,module_key,can_use,updated_by,updated_at) VALUES($1,$2,$3,$4,now()) ON CONFLICT(employee_id,module_key) DO UPDATE SET can_use=EXCLUDED.can_use,updated_by=EXCLUDED.updated_by,updated_at=now()`,[id,key,Boolean(permissions[key]),actor(req)])}await c.query(`INSERT INTO kleo_team_audit(action,employee_id,payload,actor) VALUES('employee.permissions.update',$1,$2::jsonb,$3)`,[id,JSON.stringify(permissions),actor(req)]);await c.query('COMMIT')}catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
  res.json({ok:true,employee_id:id,config:await readTeamConfig(id)});
}));

router.get("/admin/audit",requireAdmin,asyncRoute(async(_req,res)=>{await ensureKleoTeamSchema();res.json((await pool.query(`SELECT * FROM kleo_team_audit ORDER BY created_at DESC LIMIT 200`)).rows)}));

export default router;