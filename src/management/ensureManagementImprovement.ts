import db from "../db";

let ready:Promise<void>|null=null;

async function bootstrap(){
  await db.query(`
    CREATE TABLE IF NOT EXISTS management_improvement_projects(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id bigint NOT NULL,
      location_id text,
      code text NOT NULL,
      title text NOT NULL,
      problem_statement text,
      objective text,
      methodology text[] NOT NULL DEFAULT ARRAY[]::text[],
      analysis_data jsonb NOT NULL DEFAULT '{}'::jsonb,
      owner_employee_id text,
      owner_name text,
      priority text NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','critical')),
      status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','review','approved','closed','cancelled')),
      start_date date NOT NULL DEFAULT CURRENT_DATE,
      due_date date,
      approval_state text NOT NULL DEFAULT 'not_requested' CHECK(approval_state IN ('not_requested','pending','approved','rejected')),
      approval_requested_by text,
      approval_requested_at timestamptz,
      approved_by text,
      approved_at timestamptz,
      rejected_by text,
      rejected_at timestamptz,
      approval_comment text,
      created_by text NOT NULL,
      closed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(tenant_id,code)
    );
    CREATE INDEX IF NOT EXISTS management_improvement_projects_tenant_idx ON management_improvement_projects(tenant_id,status,due_date,updated_at DESC);
    CREATE INDEX IF NOT EXISTS management_improvement_projects_owner_idx ON management_improvement_projects(tenant_id,owner_employee_id,status);

    CREATE TABLE IF NOT EXISTS management_improvement_actions(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id uuid NOT NULL REFERENCES management_improvement_projects(id) ON DELETE CASCADE,
      tenant_id bigint NOT NULL,
      action_type text NOT NULL DEFAULT 'improvement' CHECK(action_type IN ('correction','corrective','preventive','improvement')),
      title text NOT NULL,
      description text,
      root_cause text,
      owner_employee_id text,
      owner_name text,
      due_date date,
      status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','completed','verified','cancelled')),
      effectiveness_criteria text,
      effectiveness_result text,
      completed_at timestamptz,
      verified_by text,
      verified_at timestamptz,
      created_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS management_improvement_actions_project_idx ON management_improvement_actions(project_id,status,due_date);
    CREATE INDEX IF NOT EXISTS management_improvement_actions_tenant_idx ON management_improvement_actions(tenant_id,status,due_date);

    CREATE TABLE IF NOT EXISTS management_improvement_kpis(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id uuid NOT NULL REFERENCES management_improvement_projects(id) ON DELETE CASCADE,
      tenant_id bigint NOT NULL,
      metric_key text,
      name text NOT NULL,
      unit text,
      direction text NOT NULL DEFAULT 'higher_better' CHECK(direction IN ('higher_better','lower_better','target')),
      before_value numeric,
      target_value numeric,
      after_value numeric,
      before_at timestamptz,
      after_at timestamptz,
      source text,
      notes text,
      created_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS management_improvement_kpis_project_idx ON management_improvement_kpis(project_id,created_at);

    CREATE TABLE IF NOT EXISTS management_improvement_approvals(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id uuid NOT NULL REFERENCES management_improvement_projects(id) ON DELETE CASCADE,
      tenant_id bigint NOT NULL,
      stage text NOT NULL DEFAULT 'final_review',
      decision text NOT NULL DEFAULT 'pending' CHECK(decision IN ('pending','approved','rejected','withdrawn')),
      requested_by text NOT NULL,
      requested_at timestamptz NOT NULL DEFAULT now(),
      decided_by text,
      decided_at timestamptz,
      comment text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS management_improvement_approvals_project_idx ON management_improvement_approvals(project_id,requested_at DESC);

    CREATE TABLE IF NOT EXISTS management_improvement_audit(
      id bigserial PRIMARY KEY,
      project_id uuid NOT NULL REFERENCES management_improvement_projects(id) ON DELETE CASCADE,
      tenant_id bigint NOT NULL,
      entity_type text NOT NULL,
      entity_id text NOT NULL,
      action text NOT NULL,
      actor_user_id text,
      actor text NOT NULL,
      changes jsonb NOT NULL DEFAULT '{}'::jsonb,
      request_ip text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS management_improvement_audit_project_idx ON management_improvement_audit(project_id,created_at DESC,id DESC);
    CREATE INDEX IF NOT EXISTS management_improvement_audit_tenant_idx ON management_improvement_audit(tenant_id,created_at DESC);
  `);
}

export async function ensureManagementImprovement(){
  if(!ready)ready=bootstrap().catch(error=>{ready=null;throw error});
  await ready;
}

export default ensureManagementImprovement;
