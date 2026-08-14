import pool from "../db";

const AUTO_SOURCE = "task_approval";
const SYSTEM_USER = "system:legacy-evaluation-2018";
let schemaPromise: Promise<void> | null = null;
let workerTimer: NodeJS.Timeout | null = null;
let workerInitialTimer: NodeJS.Timeout | null = null;

export async function ensureLegacyEvaluation2018Schema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = pool.query(`
      CREATE TABLE IF NOT EXISTS operations_quality_records(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        module_key text NOT NULL,
        title text NOT NULL,
        description text,
        location_name text,
        department text,
        assignee text,
        employee_id uuid,
        priority text DEFAULT 'normal',
        status text NOT NULL DEFAULT 'open',
        due_at timestamptz,
        recurrence text,
        requires_approval boolean DEFAULT false,
        approved_by text,
        approved_at timestamptz,
        completed_at timestamptz,
        metadata jsonb DEFAULT '{}'::jsonb,
        created_at timestamptz DEFAULT now(),
        updated_at timestamptz DEFAULT now()
      );
      ALTER TABLE operations_quality_records ADD COLUMN IF NOT EXISTS employee_id uuid;
      ALTER TABLE operations_quality_records ADD COLUMN IF NOT EXISTS approved_by text;
      ALTER TABLE operations_quality_records ADD COLUMN IF NOT EXISTS approved_at timestamptz;
      ALTER TABLE operations_quality_records ADD COLUMN IF NOT EXISTS completed_at timestamptz;
      CREATE INDEX IF NOT EXISTS idx_operations_quality_task_employee
        ON operations_quality_records(module_key,employee_id,due_at,status);

      CREATE TABLE IF NOT EXISTS hr_legacy_points(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id uuid NOT NULL,
        evaluation_month date NOT NULL,
        point_type text NOT NULL CHECK(point_type IN ('red','black','red_x')),
        point_count integer NOT NULL DEFAULT 1,
        reason text,
        source text NOT NULL DEFAULT 'manager',
        source_record_id uuid,
        auto_generated boolean NOT NULL DEFAULT false,
        guest_rating numeric,
        created_by text,
        created_at timestamptz DEFAULT now(),
        approved_at timestamptz
      );
      ALTER TABLE hr_legacy_points ADD COLUMN IF NOT EXISTS source_record_id uuid;
      ALTER TABLE hr_legacy_points ADD COLUMN IF NOT EXISTS auto_generated boolean NOT NULL DEFAULT false;
      CREATE UNIQUE INDEX IF NOT EXISTS uq_hr_legacy_task_red_x
        ON hr_legacy_points(source_record_id)
        WHERE source_record_id IS NOT NULL AND source='task_approval' AND point_type='red_x';
      CREATE INDEX IF NOT EXISTS idx_hr_legacy_points_employee_month
        ON hr_legacy_points(employee_id,evaluation_month);

      CREATE OR REPLACE FUNCTION clamp_legacy_2018_manual_points() RETURNS trigger AS $$
      BEGIN
        IF NEW.point_type IN ('red','black') THEN
          NEW.point_count := LEAST(5, GREATEST(1, COALESCE(NEW.point_count,1)));
        END IF;
        IF NEW.point_type='red_x' AND NEW.source='task_approval' THEN
          NEW.point_count := 1;
          NEW.auto_generated := true;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS trg_clamp_legacy_2018_manual_points ON hr_legacy_points;
      CREATE TRIGGER trg_clamp_legacy_2018_manual_points
        BEFORE INSERT OR UPDATE ON hr_legacy_points
        FOR EACH ROW EXECUTE FUNCTION clamp_legacy_2018_manual_points();
    `).then(() => undefined).catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

function monthStart(value: Date): string {
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

export async function syncLegacyTaskRedXById(taskId: string): Promise<{ action: "created_or_synced" | "removed" | "ignored"; task_id: string }> {
  await ensureLegacyEvaluation2018Schema();
  const task = (await pool.query(
    `SELECT id,module_key,title,employee_id,status,due_at,requires_approval
       FROM operations_quality_records
      WHERE id=$1::uuid LIMIT 1`,
    [taskId]
  )).rows[0];
  if (!task || task.module_key !== "tasks") return { action: "ignored", task_id: taskId };

  const eligible = Boolean(task.requires_approval && task.employee_id && task.due_at);
  const dueAt = task.due_at ? new Date(task.due_at) : null;
  const status = String(task.status || "").toLowerCase();
  const shouldHaveRedX = eligible && dueAt != null && dueAt.getTime() <= Date.now() && !["approved","cancelled","archived"].includes(status);

  if (!shouldHaveRedX) {
    await pool.query(
      `DELETE FROM hr_legacy_points
        WHERE source_record_id=$1::uuid AND source=$2 AND point_type='red_x'`,
      [taskId,AUTO_SOURCE]
    );
    return { action: "removed", task_id: taskId };
  }

  const reason = `Automatikus piros X – a feladat a határidőig nem kapott vezetői jóváhagyást: ${String(task.title || "Feladat").slice(0,300)}`;
  await pool.query(
    `INSERT INTO hr_legacy_points(
       employee_id,evaluation_month,point_type,point_count,reason,source,source_record_id,auto_generated,created_by,approved_at
     ) VALUES($1,$2::date,'red_x',1,$3,$4,$5::uuid,true,$6,now())
     ON CONFLICT (source_record_id) WHERE source_record_id IS NOT NULL AND source='task_approval' AND point_type='red_x'
     DO UPDATE SET employee_id=EXCLUDED.employee_id,evaluation_month=EXCLUDED.evaluation_month,
                   reason=EXCLUDED.reason,auto_generated=true,approved_at=now()`,
    [task.employee_id,monthStart(dueAt!),reason,AUTO_SOURCE,taskId,SYSTEM_USER]
  );
  return { action: "created_or_synced", task_id: taskId };
}

export async function reconcileLegacyTaskRedX(): Promise<{ scanned: number; active_red_x: number }> {
  await ensureLegacyEvaluation2018Schema();
  const tasks = (await pool.query(
    `SELECT id
       FROM operations_quality_records
      WHERE module_key='tasks'
        AND employee_id IS NOT NULL
        AND due_at IS NOT NULL
        AND requires_approval=true
      ORDER BY due_at DESC
      LIMIT 5000`
  )).rows;
  for (const task of tasks) await syncLegacyTaskRedXById(String(task.id));
  const active = Number((await pool.query(
    `SELECT count(*)::int AS n FROM hr_legacy_points WHERE source=$1 AND point_type='red_x' AND auto_generated=true`,
    [AUTO_SOURCE]
  )).rows[0]?.n || 0);
  return { scanned: tasks.length, active_red_x: active };
}

export async function getLegacyEvaluation2018AutomationSummary() {
  await ensureLegacyEvaluation2018Schema();
  const row = (await pool.query(`
    SELECT
      count(*) FILTER(
        WHERE q.module_key='tasks' AND q.requires_approval=true AND q.employee_id IS NOT NULL
          AND q.due_at<=now() AND q.status NOT IN ('approved','cancelled','archived')
      )::int AS overdue_without_approval,
      (SELECT count(*)::int FROM hr_legacy_points p
        WHERE p.source='task_approval' AND p.point_type='red_x' AND p.auto_generated=true) AS automatic_red_x
    FROM operations_quality_records q
  `)).rows[0] || {};
  return {
    overdue_without_approval: Number(row.overdue_without_approval || 0),
    automatic_red_x: Number(row.automatic_red_x || 0),
    manual_red_black_max_per_entry: 5,
  };
}

export function startLegacyEvaluation2018Worker(): void {
  if (workerTimer || workerInitialTimer) return;
  const run = () => reconcileLegacyTaskRedX().catch((error) => console.error("2018 evaluation automation failed:", error));
  workerInitialTimer = setTimeout(() => {
    workerInitialTimer = null;
    void run();
  }, 15_000);
  workerInitialTimer.unref?.();
  workerTimer = setInterval(() => void run(), 5 * 60_000);
  workerTimer.unref?.();
}
