import type {NextFunction,Response} from 'express';
import type {AuthRequest} from '../middleware/auth';
import {settleWorkOrderWithoutShift} from '../services/workOrderSettlementRecovery';

const SETTLE_PATH=/^\/workorders\/([^/]+)\/settle\/?$/;
const SCHEMA_DRIFT_CODES=new Set(['42P01','42703','42804','42883','42P07']);
const CONSTRAINT_CODES=new Set(['23502','23503','23514']);
const RETRYABLE_CODES=new Set(['57014','55P03','40P01']);
const actor=(req:AuthRequest)=>req.user?.email||String(req.user?.id||'');
const diagnostic=(error:any)=>({
  code:error?.code?String(error.code):null,
  table:error?.table?String(error.table):null,
  column:error?.column?String(error.column):null,
  constraint:error?.constraint?String(error.constraint):null,
});

export default async function workOrderSettlementErrorRecovery(err:any,req:AuthRequest,res:Response,next:NextFunction){
  const match=String(req.path||'').match(SETTLE_PATH);
  if(req.method!=='POST'||!match||!Boolean(req.body?.close_financially))return next(err);

  const workOrderId=decodeURIComponent(match[1]);
  const code=String(err?.code||'');
  const primaryDiagnostic=diagnostic(err);

  console.error('[cashier-settle-auto-recovery] primary settle failed',workOrderId,primaryDiagnostic,err?.message||err);

  if(code==='22P02')return res.status(400).json({message:'Érvénytelen azonosító vagy pénzügyi hivatkozás.',error_code:'CASHIER_SETTLEMENT_INVALID_ID',diagnostic:primaryDiagnostic});
  if(code==='P0001')return res.status(409).json({message:String(err?.message||'A pénztári művelet üzleti szabály miatt nem hajtható végre.'),error_code:'CASHIER_SETTLEMENT_RULE_CONFLICT',diagnostic:primaryDiagnostic});
  if(code==='57014'||code==='55P03'||code==='40P01')return res.status(503).json({message:'A pénzügyi lezárást adatbázis-zárolás vagy timeout akadályozta. Próbálja újra.',error_code:'CASHIER_SETTLEMENT_RETRYABLE_DB',diagnostic:primaryDiagnostic});

  try{
    const recovered=await settleWorkOrderWithoutShift(workOrderId,req.body,actor(req));
    const recoveryReason=SCHEMA_DRIFT_CODES.has(code)
      ?'schema_drift'
      :CONSTRAINT_CODES.has(code)
        ?'constraint_conflict'
        :'primary_settlement_failure';
    const body={
      ...recovered.body,
      auto_recovery:true,
      recovery_reason:recoveryReason,
      primary_error:primaryDiagnostic,
    };
    console.warn('[cashier-settle-auto-recovery] recovery result',workOrderId,recovered.status,body.recovery_reason);
    return res.status(recovered.status).json(body);
  }catch(recoveryError:any){
    const recoveryCode=String(recoveryError?.code||'');
    const recoveryDiagnostic=diagnostic(recoveryError);
    console.error('[cashier-settle-auto-recovery] recovery failed',workOrderId,recoveryDiagnostic,recoveryError?.message||recoveryError);

    // A recoveryben is érvényben maradnak a pénzügyi üzleti szabályok. Készpénzes
    // fizetés például nyitott pénztári műszak nélkül továbbra sem kerülhető meg;
    // ezt azonban 409-es, értelmezhető üzleti konfliktusként adjuk vissza, nem 500-ként.
    if(recoveryCode==='P0001')return res.status(409).json({
      message:String(recoveryError?.message||'A pénztári művelet üzleti szabály miatt nem hajtható végre.'),
      error_code:'CASHIER_SETTLEMENT_RULE_CONFLICT',
      primary_error:primaryDiagnostic,
      recovery_error:recoveryDiagnostic,
    });
    if(recoveryCode==='22P02')return res.status(400).json({
      message:'A helyreállítás során érvénytelen pénzügyi hivatkozás került elő.',
      error_code:'CASHIER_SETTLEMENT_INVALID_ID',
      primary_error:primaryDiagnostic,
      recovery_error:recoveryDiagnostic,
    });
    if(RETRYABLE_CODES.has(recoveryCode))return res.status(503).json({
      message:'A pénzügyi helyreállítást adatbázis-zárolás vagy timeout akadályozta. Próbálja újra.',
      error_code:'CASHIER_SETTLEMENT_RETRYABLE_DB',
      primary_error:primaryDiagnostic,
      recovery_error:recoveryDiagnostic,
    });
    if(CONSTRAINT_CODES.has(recoveryCode))return res.status(409).json({
      message:'A munkalap pénzügyi helyreállítását egy fennmaradó adatkonzisztencia-feltétel akadályozza.',
      error_code:'CASHIER_SETTLEMENT_RECOVERY_CONSTRAINT',
      primary_error:primaryDiagnostic,
      recovery_error:recoveryDiagnostic,
    });

    return res.status(500).json({
      message:'A munkalap pénzügyi lezárása és az automatikus helyreállítás is sikertelen.',
      error_code:'CASHIER_SETTLEMENT_RECOVERY_FAILED',
      primary_error:primaryDiagnostic,
      recovery_error:{
        code:recoveryError?.code||null,
        table:recoveryError?.table||null,
        column:recoveryError?.column||null,
        constraint:recoveryError?.constraint||null,
      },
    });
  }
}
