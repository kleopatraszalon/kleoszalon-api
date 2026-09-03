import type {NextFunction,Response} from 'express';
import type {AuthRequest} from '../middleware/auth';
import {ensureSalonDefaultLegalEntities} from '../finance/ensureSalonDefaultLegalEntities';
import {settleWorkOrderWithoutShift} from '../services/workOrderSettlementRecovery';

const SETTLE_PATH=/^\/workorders\/([^/]+)\/settle\/?$/;
const SCHEMA_DRIFT_CODES=new Set(['42P01','42703','42804','42883','42P07','42P10']);
const CONSTRAINT_CODES=new Set(['23502','23503','23505','23514','23P01']);
const RETRYABLE_CODES=new Set(['57014','55P03','40P01']);
const actor=(req:AuthRequest)=>req.user?.email||String(req.user?.id||'');
const diagnostic=(error:any)=>({
  code:error?.code?String(error.code):null,
  table:error?.table?String(error.table):null,
  column:error?.column?String(error.column):null,
  constraint:error?.constraint?String(error.constraint):null,
  message:error?.message?String(error.message).slice(0,320):null,
});
const settlementKey=(req:AuthRequest)=>{
  const raw=String(req.get?.('Idempotency-Key')||req.headers?.['idempotency-key']||req.body?.idempotency_key||'').trim();
  return /^[A-Za-z0-9._:-]{8,120}$/.test(raw)?`workorder-settlement:${raw}`:undefined;
};

export default async function workOrderSettlementErrorRecovery(err:any,req:AuthRequest,res:Response,next:NextFunction){
  const match=String(req.path||'').match(SETTLE_PATH);
  if(req.method!=='POST'||!match||!Boolean(req.body?.close_financially))return next(err);

  const workOrderId=decodeURIComponent(match[1]);
  const code=String(err?.code||'');
  const primaryDiagnostic=diagnostic(err);

  console.error('[cashier-settle-auto-recovery] primary settle failed',workOrderId,primaryDiagnostic,err?.message||err);

  if(code==='22P02')return res.status(400).json({message:'Érvénytelen azonosító vagy pénzügyi hivatkozás.',error_code:'CASHIER_SETTLEMENT_INVALID_ID',diagnostic:primaryDiagnostic});
  if(code==='P0001')return res.status(409).json({message:String(err?.message||'A pénztári művelet üzleti szabály miatt nem hajtható végre.'),error_code:'CASHIER_SETTLEMENT_RULE_CONFLICT',diagnostic:primaryDiagnostic});
  if(RETRYABLE_CODES.has(code))return res.status(503).json({message:'A pénzügyi lezárást adatbázis-zárolás vagy timeout akadályozta. Próbálja újra.',error_code:'CASHIER_SETTLEMENT_RETRYABLE_DB',diagnostic:primaryDiagnostic});

  try{
    // A globális szalon-fallback seed best-effort kompatibilitási lépés. Egy régi,
    // idegen szalon hibás default-linkje nem állíthatja le az éppen fizetett munkalap
    // célzott recoveryjét; utóbbi saját tranzakcióban fail-closed módon ellenőrzi,
    // hogy ténylegesen van-e használható kibocsátó cég.
    let salonDefaultSeedWarning:any=null;
    try{
      await ensureSalonDefaultLegalEntities(true);
    }catch(seedError:any){
      salonDefaultSeedWarning=diagnostic(seedError);
      console.error('[cashier-settle-auto-recovery] salon default seed skipped',workOrderId,salonDefaultSeedWarning,seedError?.message||seedError);
    }

    // A primary pénzügyi tranzakció visszagörgetése után ugyanazt az idempotencia-
    // kulcsot használjuk a védett recovery könyveléshez. Így nincs párhuzamos
    // "legacy" fizetési sor: a helyreállítás is ugyanazon ledger-integritási úton fut.
    const recovered=await settleWorkOrderWithoutShift(workOrderId,req.body,actor(req),settlementKey(req));
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
      ...(salonDefaultSeedWarning?{salon_default_seed_warning:salonDefaultSeedWarning}:{}),
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
      message:String(recoveryError?.message||'A munkalap pénzügyi helyreállítását egy fennmaradó adatkonzisztencia-feltétel akadályozza.'),
      error_code:'CASHIER_SETTLEMENT_RECOVERY_CONSTRAINT',
      primary_error:primaryDiagnostic,
      recovery_error:recoveryDiagnostic,
    });
    if(SCHEMA_DRIFT_CODES.has(recoveryCode))return res.status(503).json({
      message:String(recoveryError?.message||'A pénzügyi helyreállítást egy régi adatbázisséma-eltérés akadályozza.'),
      error_code:'CASHIER_SETTLEMENT_SCHEMA_DRIFT',
      primary_error:primaryDiagnostic,
      recovery_error:recoveryDiagnostic,
    });

    const marker=[recoveryCode,recoveryDiagnostic.constraint].filter(Boolean).join(' / ');
    return res.status(500).json({
      message:`A munkalap pénzügyi lezárása és az automatikus helyreállítás is sikertelen${marker?` (${marker})`:''}.`,
      error_code:'CASHIER_SETTLEMENT_RECOVERY_FAILED',
      primary_error:primaryDiagnostic,
      recovery_error:recoveryDiagnostic,
    });
  }
}
