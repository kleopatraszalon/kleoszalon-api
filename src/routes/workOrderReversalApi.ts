import {Router} from 'express';
import db from '../db';
import {requireAuth,AuthRequest} from '../middleware/auth';
import {hasAnyRole} from '../security/roles';
import {ensureFinanceNav} from '../finance/ensureFinanceNav';

const router=Router();
router.use(requireAuth);
const UUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isAdmin=(role:unknown)=>hasAnyRole(role,['admin']);
const actor=(req:AuthRequest)=>req.user?.email||String(req.user?.id||'admin');

router.post('/:id/reversal-request',async(req:AuthRequest,res,next)=>{
  try{
    if(!isAdmin(req.user?.role))return res.status(403).json({code:'REVERSAL_ADMIN_REQUIRED',message:'Lezárt munkalap visszafordítását csak adminisztrátor kezdeményezheti.'});
    const workOrderId=String(req.params.id||'').trim();
    if(!UUID_RE.test(workOrderId))return res.status(400).json({code:'INVALID_WORK_ORDER_ID',message:'Érvénytelen munkalapazonosító.'});
    const reason=String(req.body?.reason||'').trim();
    const key=String(req.get('Idempotency-Key')||req.body?.idempotency_key||'').trim();
    if(reason.length<5)return res.status(400).json({code:'REVERSAL_REASON_REQUIRED',message:'A visszafordítás indoklása legalább 5 karakter legyen.'});
    if(key.length<8)return res.status(400).json({code:'REVERSAL_IDEMPOTENCY_KEY_REQUIRED',message:'A visszafordításhoz legalább 8 karakteres Idempotency-Key szükséges.'});

    await ensureFinanceNav();
    const prior=(await db.query(`SELECT id::text,work_order_id::text,status,idempotency_key FROM work_order_reversals WHERE work_order_id=$1::uuid OR idempotency_key=$2 ORDER BY created_at LIMIT 1`,[workOrderId,key])).rows[0]||null;
    if(prior&&String(prior.idempotency_key)===key&&String(prior.work_order_id)!==workOrderId)
      return res.status(409).json({code:'REVERSAL_IDEMPOTENCY_KEY_CONFLICT',message:'Ez az Idempotency-Key már másik munkalap visszafordításához tartozik.'});

    const row=(await db.query(`SELECT * FROM kleo_register_work_order_reversal($1::uuid,$2,$3,$4)`,[workOrderId,reason,actor(req),key])).rows[0];
    return res.status(prior?200:202).json({
      ok:true,
      idempotent:Boolean(prior),
      reversal:row,
      message:prior?'A visszafordítási kérés már létezett; ugyanazt a rekordot adtuk vissza.':'A visszafordítási kérés auditáltan rögzítve. A forrás munkalap és archívum változatlan maradt.'
    });
  }catch(error:any){
    const code=String(error?.code||'');const message=String(error?.message||'');
    if(code==='P0002'||message.includes('WORK_ORDER_NOT_FOUND'))return res.status(404).json({code:'WORK_ORDER_NOT_FOUND',message:'A munkalap nem található.'});
    if(code==='23514'&&message.includes('WORK_ORDER_NOT_FINALIZED'))return res.status(409).json({code:'WORK_ORDER_NOT_FINALIZED',message:'Csak véglegesen lezárt vagy archivált munkalap fordítható vissza.'});
    if(code==='23505'&&message.includes('REVERSAL_IDEMPOTENCY_KEY_CONFLICT'))return res.status(409).json({code:'REVERSAL_IDEMPOTENCY_KEY_CONFLICT',message:'Ez az Idempotency-Key már másik munkalap visszafordításához tartozik.'});
    if(code==='22023')return res.status(400).json({code:message.includes('IDEMPOTENCY')?'REVERSAL_IDEMPOTENCY_KEY_REQUIRED':'REVERSAL_REASON_REQUIRED',message:'A visszafordítási kérés indoklása vagy idempotenciakulcsa érvénytelen.'});
    return next(error);
  }
});

router.get('/:id/reversal',async(req:AuthRequest,res,next)=>{
  try{
    if(!hasAnyRole(req.user?.role,['admin','accounting','bookkeeper','konyveles','könyvelés']))return res.status(403).json({message:'A visszafordítási auditadat csak adminisztrátor vagy könyvelés számára érhető el.'});
    const workOrderId=String(req.params.id||'').trim();
    if(!UUID_RE.test(workOrderId))return res.status(400).json({message:'Érvénytelen munkalapazonosító.'});
    await ensureFinanceNav();
    const row=(await db.query(`SELECT * FROM work_order_reversals WHERE work_order_id=$1::uuid ORDER BY created_at DESC LIMIT 1`,[workOrderId])).rows[0];
    if(!row)return res.status(404).json({message:'Ehhez a munkalaphoz nincs visszafordítási rekord.'});
    return res.json(row);
  }catch(error){return next(error)}
});

export default router;
