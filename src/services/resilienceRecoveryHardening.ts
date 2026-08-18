import db from "../db";
import { ensureResilienceRecoverySchema } from "./resilienceRecoveryControl";

let schemaPromise:Promise<void>|null=null;
export function ensureResilienceRecoveryHardeningSchema(){
  if(!schemaPromise){
    schemaPromise=(async()=>{
      await ensureResilienceRecoverySchema();
      await db.query(`
        CREATE OR REPLACE FUNCTION kleo_resilience_override_guard() RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE commander text;
        BEGIN
          IF NEW.status='approved' THEN
            IF NEW.approved_by IS NULL OR lower(trim(NEW.approved_by))=lower(trim(NEW.requested_by)) THEN
              RAISE EXCEPTION 'Emergency override requires independent second-person approval' USING ERRCODE='23514';
            END IF;
            IF length(trim(COALESCE(NEW.evidence->>'description',''))) < 5 THEN
              RAISE EXCEPTION 'Emergency override approval evidence is required' USING ERRCODE='23514';
            END IF;
            IF NEW.expires_at<=now() OR NEW.expires_at>now()+interval '2 hours' THEN
              RAISE EXCEPTION 'Emergency override expiry must be within 2 hours' USING ERRCODE='23514';
            END IF;
            SELECT mi.incident_commander_key INTO commander
              FROM resilience_change_freezes f JOIN major_incidents mi ON mi.id=f.incident_id WHERE f.id=NEW.freeze_id;
            IF NULLIF(trim(COALESCE(commander,'')),'') IS NULL THEN
              RAISE EXCEPTION 'Incident commander is required before emergency change approval' USING ERRCODE='23514';
            END IF;
          END IF;
          RETURN NEW;
        END $$;
        DROP TRIGGER IF EXISTS trg_kleo_resilience_override_guard ON resilience_emergency_change_overrides;
        CREATE TRIGGER trg_kleo_resilience_override_guard BEFORE INSERT OR UPDATE OF status,approved_by,evidence,expires_at ON resilience_emergency_change_overrides FOR EACH ROW EXECUTE FUNCTION kleo_resilience_override_guard();

        CREATE OR REPLACE FUNCTION kleo_resilience_all_clear_guard() RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE commander text; mandatory_open integer; unverified integer; actions_open integer; incident_status text;
        BEGIN
          IF NEW.status='all_clear' THEN
            SELECT incident_commander_key INTO commander FROM major_incidents WHERE id=NEW.incident_id;
            IF NULLIF(trim(COALESCE(commander,'')),'') IS NULL THEN RAISE EXCEPTION 'Incident commander is required for ALL CLEAR' USING ERRCODE='23514'; END IF;
            IF length(trim(COALESCE(NEW.all_clear_note,'')))<10 OR length(trim(COALESCE(NEW.all_clear_evidence->>'description','')))<5 THEN
              RAISE EXCEPTION 'ALL CLEAR requires note and evidence' USING ERRCODE='23514';
            END IF;
            SELECT COUNT(*)::int INTO mandatory_open FROM resilience_recovery_step_runs sr JOIN resilience_recovery_runbooks r ON r.service_key=sr.service_key AND r.step_key=sr.step_key WHERE sr.session_id=NEW.id AND r.mandatory=true AND sr.status<>'completed';
            SELECT COUNT(*)::int INTO unverified FROM resilience_recovery_service_state WHERE session_id=NEW.id AND state<>'verified';
            SELECT COUNT(*)::int INTO actions_open FROM major_incident_actions WHERE incident_id=NEW.incident_id AND status IN('open','in_progress') AND priority IN('critical','high');
            IF mandatory_open>0 OR unverified>0 OR actions_open>0 THEN
              RAISE EXCEPTION 'ALL CLEAR blocked: mandatory recovery work remains' USING ERRCODE='23514';
            END IF;
          END IF;
          IF NEW.status='closed' AND OLD.status<>'all_clear' THEN
            SELECT status INTO incident_status FROM major_incidents WHERE id=NEW.incident_id;
            IF incident_status<>'dismissed' THEN RAISE EXCEPTION 'Recovery session may close only after ALL CLEAR or incident dismissal' USING ERRCODE='23514'; END IF;
          END IF;
          RETURN NEW;
        END $$;
        DROP TRIGGER IF EXISTS trg_kleo_resilience_all_clear_guard ON resilience_recovery_sessions;
        CREATE TRIGGER trg_kleo_resilience_all_clear_guard BEFORE UPDATE OF status,all_clear_note,all_clear_evidence ON resilience_recovery_sessions FOR EACH ROW EXECUTE FUNCTION kleo_resilience_all_clear_guard();
      `);
    })().catch(error=>{schemaPromise=null;throw error});
  }
  return schemaPromise;
}
