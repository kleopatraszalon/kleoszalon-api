import db from "../db";
import { ensureMajorIncidentSchema } from "./majorIncidentWarRoom";

let schemaPromise:Promise<void>|null=null;

export function ensureMajorIncidentHardeningSchema(){
  if(!schemaPromise){
    schemaPromise=(async()=>{
      await ensureMajorIncidentSchema();
      await db.query(`
        CREATE OR REPLACE FUNCTION kleo_major_incident_state_guard() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          -- Monitoring may be entered automatically when the correlated source cluster recovers.
          -- Human-led mitigation/resolution still requires an accountable incident commander.
          IF NEW.status IN ('mitigating','resolved','postmortem_closed') AND NULLIF(trim(COALESCE(NEW.incident_commander_key,'')),'') IS NULL THEN
            RAISE EXCEPTION 'Incident commander is required before status %', NEW.status USING ERRCODE='23514';
          END IF;
          IF NEW.status IN ('resolved','postmortem_closed') THEN
            IF length(trim(COALESCE(NEW.resolution_note,''))) < 10 OR length(trim(COALESCE(NEW.resolution_evidence->>'description',''))) < 5 THEN
              RAISE EXCEPTION 'Major incident resolution requires note and evidence' USING ERRCODE='23514';
            END IF;
          END IF;
          IF NEW.status='postmortem_closed' THEN
            IF length(trim(COALESCE(NEW.postmortem->>'root_cause',''))) < 10
               OR length(trim(COALESCE(NEW.postmortem->>'impact_summary',''))) < 10
               OR length(trim(COALESCE(NEW.postmortem->>'lessons_learned',''))) < 10
               OR length(trim(COALESCE(NEW.postmortem->>'follow_up_actions',''))) < 10 THEN
              RAISE EXCEPTION 'Post-mortem root cause, impact, lessons and follow-up actions are required' USING ERRCODE='23514';
            END IF;
          END IF;
          RETURN NEW;
        END $$;
        DROP TRIGGER IF EXISTS trg_kleo_major_incident_state_guard ON major_incidents;
        CREATE TRIGGER trg_kleo_major_incident_state_guard
          BEFORE INSERT OR UPDATE OF status,incident_commander_key,resolution_note,resolution_evidence,postmortem
          ON major_incidents FOR EACH ROW EXECUTE FUNCTION kleo_major_incident_state_guard();

        CREATE OR REPLACE FUNCTION kleo_major_incident_action_guard() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.status='done' THEN
            IF length(trim(COALESCE(NEW.completion_evidence->>'description',''))) < 5 THEN
              RAISE EXCEPTION 'War Room action completion evidence is required' USING ERRCODE='23514';
            END IF;
            IF NEW.completed_at IS NULL THEN NEW.completed_at=now(); END IF;
          END IF;
          RETURN NEW;
        END $$;
        DROP TRIGGER IF EXISTS trg_kleo_major_incident_action_guard ON major_incident_actions;
        CREATE TRIGGER trg_kleo_major_incident_action_guard
          BEFORE INSERT OR UPDATE OF status,completion_evidence,completed_at
          ON major_incident_actions FOR EACH ROW EXECUTE FUNCTION kleo_major_incident_action_guard();
      `);
    })().catch(error=>{schemaPromise=null;throw error});
  }
  return schemaPromise;
}
