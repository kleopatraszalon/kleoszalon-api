import db from "../db";
import { ensureExceptionCapaSchema } from "./exceptionCapa";

let schemaPromise:Promise<void>|null=null;

export function ensureExceptionCapaHardeningSchema(){
  if(!schemaPromise){
    schemaPromise=(async()=>{
      await ensureExceptionCapaSchema();
      await db.query(`
        CREATE OR REPLACE FUNCTION kleo_exception_capa_state_guard()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.status IN ('approved','in_progress','verification','verified') THEN
            IF NEW.approved_by IS NULL OR NEW.approved_at IS NULL THEN
              RAISE EXCEPTION 'CAPA approval evidence is required before status %', NEW.status USING ERRCODE='23514';
            END IF;
            IF length(trim(COALESCE(NEW.problem_statement,''))) < 10
               OR length(trim(COALESCE(NEW.root_cause_hypothesis,''))) < 10
               OR length(trim(COALESCE(NEW.corrective_action,''))) < 10
               OR length(trim(COALESCE(NEW.preventive_action,''))) < 10 THEN
              RAISE EXCEPTION 'CAPA problem, root cause, corrective and preventive action must be documented before approval' USING ERRCODE='23514';
            END IF;
          END IF;

          IF NEW.status='verified' THEN
            IF NEW.verified_by IS NULL OR NEW.verified_at IS NULL THEN
              RAISE EXCEPTION 'CAPA verification actor and timestamp are required' USING ERRCODE='23514';
            END IF;
            IF length(trim(COALESCE(NEW.verification_note,''))) < 10 THEN
              RAISE EXCEPTION 'CAPA verification note must contain at least 10 characters' USING ERRCODE='23514';
            END IF;
            IF length(trim(COALESCE(NEW.verification_evidence->>'description',''))) < 5 THEN
              RAISE EXCEPTION 'CAPA verification evidence description is required' USING ERRCODE='23514';
            END IF;
          END IF;
          RETURN NEW;
        END $$;

        DROP TRIGGER IF EXISTS trg_kleo_exception_capa_state_guard ON exception_capa_candidates;
        CREATE TRIGGER trg_kleo_exception_capa_state_guard
          BEFORE INSERT OR UPDATE OF status,problem_statement,root_cause_hypothesis,corrective_action,preventive_action,
            approved_by,approved_at,verified_by,verified_at,verification_note,verification_evidence
          ON exception_capa_candidates
          FOR EACH ROW EXECUTE FUNCTION kleo_exception_capa_state_guard();
      `);
    })().catch(error=>{schemaPromise=null;throw error});
  }
  return schemaPromise;
}
