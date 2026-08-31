import type {NextFunction,Response} from 'express';
import type {AuthRequest} from '../middleware/auth';
import {settleWorkOrderWithoutShift} from '../services/workOrderSettlementRecovery';

const SETTLE_PATH=/^\/workorders\/([^/]+)\/settle\/?$/;
const SCHEMA_DRIFT_CODES=new Set(['42P01','42703','42804','42883','42P07']);
const CONSTRAINT_CODES=new Set(['23502','23503','23514']);
const actor=(req:AuthRequest)=>req.user?.email||String(req.user?.id||'');

export default async function workOrderSettlementErrorRecovery(err:any,req:AuthRequest,res:Response,next:NextFunction){
  const match=String(req.path||'').match(SETTLE_PATH);
  if(req.method!=='POST'||!match||!Boolean(req.body?.close_financially))return next(err);

  const workOrderId=decodeURIComponent(match[1]);
  const code=String(err?.code||'');
  const diagnostic={
    code:code||null,
    table:err?.table?String(err.table):null,
    column:err?.column?String(err.column):null,
    constraint:err?.constraint?String(err.constraint):null,
  };

  console.error('[cashier-settle-auto-recovery] primary settle failed',workOrderId,diagnostic,err?.message||err);

  if(code==='22P02')return res.status(400).json({message:'Érvénytelen azonosító vagy pénzügyi hivatkozás.',error_code:'CASHIER_SETTLEMENT_INVALID_ID',diagnostic});
  if(code==='P0001')return res.status(409).json({message:String(err?.message||'A pénztári művelet üzleti szabály miatt nem hajtható végre.'),error_code:'CASHIER_SETTLEMENT_RULE_CONFLICT',diagnostic});
  if(CONSTRAINT_CODES.has(code))return res.status(409).json({message:'A munkalap pénzügyi lezárását adatkonzisztencia-hiba akadályozza.',error_code:'CASHIER_SETTLEMENT_DATA_CONFLICT',diagnostic});
  if(code==='57014'||code==='55P03'||code==='40P01')return res.status(503).json({message:'A pénzügyi lezárást adatbázis-zárolás vagy timeout akadályozta. Próbálja újra.',error_code:'CASHIER_SETTLEMENT_RETRYABLE_DB',diagnostic});

  try{
    const recovered=await settleWorkOrderWithoutShift(workOrderId,req.body,actor(req));
    const body={
      ...recovered.body,
      auto_recovery:true,
      recovery_reason:SCHEMA_DRIFT_CODES.has(code)?'schema_drift':'primary_settlement_failure',
      primary_error:diagnostic,
    };
    console.warn('[cashier-settle-auto-recovery] recovery result',workOrderId,recovered.status,body.recovery_reason);
    return res.status(recovered.status).json(body);
  }catch(recoveryError:any){
    console.error('[cashier-settle-auto-recovery] recovery failed',workOrderId,recoveryError?.code||'',recoveryError?.table||'',recoveryError?.column||'',recoveryError?.constraint||'',recoveryError?.message||recoveryError);
    return res.status(500).json({
      message:'A munkalap pénzügyi lezárása és az automatikus helyreállítás is sikertelen.',
      error_code:'CASHIER_SETTLEMENT_RECOVERY_FAILED',
      primary_error:diagnostic,
      recovery_error:{
        code:recoveryError?.code||null,
        table:recoveryError?.table||null,
        column:recoveryError?.column||null,
        constraint:recoveryError?.constraint||null,
      },
    });
  }
}
