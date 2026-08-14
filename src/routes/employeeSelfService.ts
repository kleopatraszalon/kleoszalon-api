import { Router, Response, NextFunction } from "express";
import pool from "../db";
import { AuthRequest, requireAuth } from "../middleware/auth";
import { ensureHrV2 } from "../hr/ensureHrV2";
import { ensureLegacyEvaluation2018Schema, syncLegacyTaskRedXById } from "../services/legacyEvaluation2018";

const router = Router();
router.use(requireAuth);

const asyncRoute =
  (handler: (req: AuthRequest, res: Response) => Promise<any>) =>
  (req: AuthRequest, res: Response, next: NextFunction) => handler(req, res).catch(next);

async function currentEmployee(req: AuthRequest) {
  const id = String(req.user?.id ?? "").trim();
  const email = String(req.user?.email ?? "").trim();
  const { rows } = await pool.query(
    `SELECT e.id,e.full_name,e.email,e.login_name,e.location_id,l.name AS location_name,
            e.position_id,p.name AS position_name
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

router.get("/dashboard", asyncRoute(async (req, res) => {
  await ensureHrV2();
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
         SELECT r.status,
                COUNT(*) FILTER (WHERE EXTRACT(ISODOW FROM d.day)<6)::numeric AS days
           FROM leave_requests r
           JOIN leave_types t ON t.id=r.leave_type_id AND lower(t.code)='annual'
           CROSS JOIN LATERAL generate_series(
             GREATEST(r.date_from,$3::date),LEAST(r.date_to,$4::date),interval '1 day'
           ) AS d(day)
          WHERE r.employee_id=$1 AND r.date_from<=$4::date AND r.date_to>=$3::date
          GROUP BY r.status
       )
       SELECT b.entitlement_days,b.carried_days,b.adjustment_days,
              COALESCE((SELECT SUM(days) FROM annual_days WHERE status='approved'),0)::numeric AS taken_days,
              COALESCE((SELECT SUM(days) FROM annual_days WHERE status='pending'),0)::numeric AS pending_days,
              (b.entitlement_days+b.carried_days+b.adjustment_days-
               COALESCE((SELECT SUM(days) FROM annual_days WHERE status='approved'),0))::numeric AS remaining_days
         FROM base b`,
      [employee.id,year,yearStart,yearEnd]
    ),
    pool.query(
      `SELECT r.id,t.name AS leave_type_name,t.code AS leave_type_code,r.date_from,r.date_to,r.status,r.reason
         FROM leave_requests r JOIN leave_types t ON t.id=r.leave_type_id
        WHERE r.employee_id=$1 AND r.date_to>=CURRENT_DATE-interval '60 days'
        ORDER BY r.date_from DESC LIMIT 12`,
      [employee.id]
    ),
    pool.query(
      `SELECT id,work_date,starts_at,ends_at,break_minutes,shift_type,status,is_overtime,is_training,note
         FROM work_shifts
        WHERE employee_id=$1 AND status<>'cancelled' AND work_date BETWEEN CURRENT_DATE AND CURRENT_DATE+14
        ORDER BY work_date,starts_at LIMIT 30`,
      [employee.id]
    ),
    pool.query(
      `SELECT id,title,description,priority,status,due_at,recurrence,requires_approval,completed_at,approved_at,approved_by
         FROM operations_quality_records
        WHERE module_key='tasks' AND employee_id=$1
          AND (status NOT IN ('approved','cancelled','archived') OR due_at>=CURRENT_DATE-interval '45 days')
        ORDER BY CASE WHEN status='completed' THEN 0 WHEN due_at<now() THEN 1 ELSE 2 END,due_at NULLS LAST,created_at DESC
        LIMIT 50`,
      [employee.id]
    )
  ]);

  res.json({
    employee,
    year,
    attendance: attendance.rows[0] ?? {},
    leave: leaveBalance.rows[0] ?? { entitlement_days:20,carried_days:0,adjustment_days:0,taken_days:0,pending_days:0,remaining_days:20 },
    leave_requests: leaves.rows,
    upcoming_shifts: shifts.rows,
    tasks: tasks.rows,
  });
}));

router.post("/tasks/:id/complete", asyncRoute(async (req,res) => {
  await ensureLegacyEvaluation2018Schema();
  const employee = await currentEmployee(req);
  if (!employee) return res.status(404).json({ error: "A belépett felhasználóhoz nem található aktív munkatársi rekord." });
  const task = (await pool.query(
    `UPDATE operations_quality_records
        SET status='completed',completed_at=now(),approved_by=NULL,approved_at=NULL,
            metadata=metadata||jsonb_build_object('employee_completed_at',now()::text),updated_at=now()
      WHERE id=$1::uuid AND module_key='tasks' AND employee_id=$2
        AND status NOT IN ('approved','cancelled','archived')
      RETURNING *`,
    [req.params.id,employee.id]
  )).rows[0];
  if (!task) return res.status(404).json({ error: "A feladat nem található, nem Önhöz tartozik, vagy már lezárt." });
  await syncLegacyTaskRedXById(String(task.id));
  res.json({ ok:true, task, message:"A feladat elvégzett állapotba került, vezetői jóváhagyásra vár." });
}));

export default router;
