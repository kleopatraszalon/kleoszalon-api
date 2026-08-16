import {Router,Response,NextFunction} from 'express';
import {AuthRequest,requireAuth} from '../middleware/auth';
import {issueWorkOrderEInvoice,validateWorkOrderEInvoicePreconditions} from '../finance/automaticEInvoiceService';

const router=Router();
router.use(requireAuth);
const actor=(req:AuthRequest)=>req.user?.email||String(req.user?.id||'automatic-e-invoice');

router.use(async(req:AuthRequest,res:Response,next:NextFunction)=>{
  const match=String(req.path||'').match(/^\/workorders\/([^/]+)\/finalize\/?$/);
  if(req.method!=='POST'||!match)return next();
  const workOrderId=decodeURIComponent(match[1]);
  try{
    const errors=await validateWorkOrderEInvoicePreconditions(workOrderId);
    if(errors.length)return res.status(409).json({
      message:'A munkalap nem zárható le, amíg az automatikus e-számlához szükséges adatok hiányosak.',
      code:'AUTOMATIC_E_INVOICE_NOT_READY',
      errors,
      e_invoice_required:true,
    });

    const originalJson=res.json.bind(res);
    let intercepted=false;
    (res as any).json=(body:any)=>{
      if(intercepted)return originalJson(body);
      if(res.statusCode>=400||!body?.finalized)return originalJson(body);
      intercepted=true;
      void issueWorkOrderEInvoice(workOrderId,actor(req)).then(result=>{
        originalJson({...body,e_invoice:result.invoice,nav_submission:result.nav||null,nav_queue_error:result.nav_error||null,e_invoice_required:true});
      }).catch((error:any)=>{
        const status=Number(error?.status||503);
        res.status(status>=400&&status<600?status:503);
        originalJson({
          message:'A munkalap lezárása megtörtént, de az automatikus e-számla kiállítása nem fejeződött be. A lezárás újbóli megnyomása biztonságosan újrapróbálja a számlázást.',
          code:error?.code||'AUTOMATIC_E_INVOICE_FAILED',
          errors:error?.errors||undefined,
          detail:String(error?.message||error),
          finalization:body,
          e_invoice_required:true,
        });
      });
      return res;
    };
    return next();
  }catch(error){return next(error)}
});

export default router;
