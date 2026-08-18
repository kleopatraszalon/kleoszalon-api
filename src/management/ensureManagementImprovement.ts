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
    CREATE UNIQUE INDEX IF NOT EXISTS management_improvement_one_pending_approval_idx
      ON management_improvement_approvals(project_id) WHERE decision='pending';

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

    CREATE OR REPLACE FUNCTION management_improvement_guard_project_state()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.approval_state='pending' AND NEW.status<>'review' THEN
        RAISE EXCEPTION 'Függő jóváhagyás mellett a projekt állapota csak review lehet.' USING ERRCODE='23514';
      END IF;
      IF NEW.approval_state='approved' AND NEW.status NOT IN ('approved','closed') THEN
        RAISE EXCEPTION 'Jóváhagyott projekt csak approved vagy closed állapotban lehet.' USING ERRCODE='23514';
      END IF;
      IF NEW.status='review' AND NEW.approval_state<>'pending' THEN
        RAISE EXCEPTION 'Review állapot csak függő jóváhagyással állítható be.' USING ERRCODE='23514';
      END IF;
      IF NEW.status IN ('approved','closed') AND NEW.approval_state<>'approved' THEN
        RAISE EXCEPTION 'Approved/closed állapot csak formális jóváhagyás után állítható be.' USING ERRCODE='23514';
      END IF;
      IF TG_OP='UPDATE' AND OLD.approval_state IN ('pending','approved') AND
         ROW(NEW.location_id,NEW.title,NEW.problem_statement,NEW.objective,NEW.methodology,NEW.analysis_data,
             NEW.owner_employee_id,NEW.owner_name,NEW.priority,NEW.start_date,NEW.due_date)
         IS DISTINCT FROM
         ROW(OLD.location_id,OLD.title,OLD.problem_statement,OLD.objective,OLD.methodology,OLD.analysis_data,
             OLD.owner_employee_id,OLD.owner_name,OLD.priority,OLD.start_date,OLD.due_date) THEN
        RAISE EXCEPTION 'Jóváhagyás alatt vagy után a projekt bizonyítéktartalma nem módosítható.' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS management_improvement_project_state_guard ON management_improvement_projects;
    CREATE TRIGGER management_improvement_project_state_guard
      BEFORE INSERT OR UPDATE ON management_improvement_projects
      FOR EACH ROW EXECUTE FUNCTION management_improvement_guard_project_state();

    CREATE OR REPLACE FUNCTION management_improvement_guard_child_tenant()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE parent_tenant bigint;
    BEGIN
      SELECT tenant_id INTO parent_tenant FROM management_improvement_projects WHERE id=NEW.project_id;
      IF parent_tenant IS NULL OR NEW.tenant_id IS DISTINCT FROM parent_tenant THEN
        RAISE EXCEPTION 'A fejlesztési projekt gyermekrekord tenant-hivatkozása érvénytelen.' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$;

    DROP TRIGGER IF EXISTS management_improvement_action_tenant_guard ON management_improvement_actions;
    CREATE TRIGGER management_improvement_action_tenant_guard
      BEFORE INSERT OR UPDATE ON management_improvement_actions
      FOR EACH ROW EXECUTE FUNCTION management_improvement_guard_child_tenant();
    DROP TRIGGER IF EXISTS management_improvement_kpi_tenant_guard ON management_improvement_kpis;
    CREATE TRIGGER management_improvement_kpi_tenant_guard
      BEFORE INSERT OR UPDATE ON management_improvement_kpis
      FOR EACH ROW EXECUTE FUNCTION management_improvement_guard_child_tenant();
    DROP TRIGGER IF EXISTS management_improvement_approval_tenant_guard ON management_improvement_approvals;
    CREATE TRIGGER management_improvement_approval_tenant_guard
      BEFORE INSERT OR UPDATE ON management_improvement_approvals
      FOR EACH ROW EXECUTE FUNCTION management_improvement_guard_child_tenant();
    DROP TRIGGER IF EXISTS management_improvement_audit_tenant_guard ON management_improvement_audit;
    CREATE TRIGGER management_improvement_audit_tenant_guard
      BEFORE INSERT ON management_improvement_audit
      FOR EACH ROW EXECUTE FUNCTION management_improvement_guard_child_tenant();

    CREATE OR REPLACE FUNCTION management_improvement_guard_evidence_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE pid uuid; state text;
    BEGIN
      pid:=CASE WHEN TG_OP='DELETE' THEN OLD.project_id ELSE NEW.project_id END;
      SELECT approval_state INTO state FROM management_improvement_projects WHERE id=pid;
      IF state IN ('pending','approved') THEN
        RAISE EXCEPTION 'Jóváhagyás alatt vagy után CAPA/KPI bizonyíték nem módosítható.' USING ERRCODE='23514';
      END IF;
      IF TG_OP='DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS management_improvement_action_evidence_guard ON management_improvement_actions;
    CREATE TRIGGER management_improvement_action_evidence_guard
      BEFORE INSERT OR UPDATE OR DELETE ON management_improvement_actions
      FOR EACH ROW EXECUTE FUNCTION management_improvement_guard_evidence_mutation();
    DROP TRIGGER IF EXISTS management_improvement_kpi_evidence_guard ON management_improvement_kpis;
    CREATE TRIGGER management_improvement_kpi_evidence_guard
      BEFORE INSERT OR UPDATE OR DELETE ON management_improvement_kpis
      FOR EACH ROW EXECUTE FUNCTION management_improvement_guard_evidence_mutation();

    CREATE OR REPLACE FUNCTION management_improvement_prevent_audit_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'A management improvement audit trail append-only és nem módosítható.' USING ERRCODE='55000';
    END $$;
    DROP TRIGGER IF EXISTS management_improvement_audit_immutable ON management_improvement_audit;
    CREATE TRIGGER management_improvement_audit_immutable
      BEFORE UPDATE OR DELETE ON management_improvement_audit
      FOR EACH ROW EXECUTE FUNCTION management_improvement_prevent_audit_mutation();
  `);
}

export async function ensureManagementImprovement(){
  if(!ready)ready=bootstrap().catch(error=>{ready=null;throw error});
  await ready;
}

export default ensureManagementImprovement;
