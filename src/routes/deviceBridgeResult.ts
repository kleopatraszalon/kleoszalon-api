import {Router,Response} from 'express';
import {createHmac,timingSafeEqual} from 'crypto';
import db from '../db';
import {AuthRequest} from '../middleware/auth';
import {parseRoleKeys} from '../security/roles';

const router=Router();
const OP_ROLES=new Set(['admin','manager','location_manager','salon_manager','receptionist']);
const GLOBAL_ROLES=new Set(['admin','manager']);
const STATUSES=new Set(['APPROVED','DECLINED','CANCELLED','ERROR']);
const money=(v:unknown)=>{const n=Number(v??0);return Number.isFinite(n)?Math.round(n*100)/100:0};
const roles=(req:AuthRequest)=>parseRoleKeys(req.user?.role);
const allowed=(req:AuthRequest)=>roles(req).some(r=>OP_ROLES.has(r));

router.post('/payments/:id/bridge-result',async(req:AuthRequest,res:Response,next)=>{
 try{
  if(!allowed(req))return res.status(403).json({message:'Ehhez a művelethez recepciós vagy vezetői jogosultság szükséges.'});
  const q=await db.query(`SELECT x.*,d.secret_env_key,d.adapter_type FROM vir_payment_terminal_transactions x JOIN vir_payment_terminal_devices d ON d.id=x.terminal_id WHERE x.id=$1::uuid`,[req.params.id]);
  const tx=q.rows[0];if(!tx)return res.status(404).json({message:'A tranzakció nem található.'});
  const roleKeys=roles(req),own=String(req.user?.location_id??'').trim();
  if(!roleKeys.some(r=>GLOBAL_ROLES.has(r))&&(!own||own!==String(tx.location_id)))return res.status(403).json({message:'Másik telephely tranzakciója nem kezelhető.'});
  if(tx.adapter_type==='SIMULATOR')return res.status(409).json({message:'Teszt terminálhoz a simulate végpont használható.'});
  if(!['CREATED','SENT'].includes(String(tx.status)))return res.json(tx);
  const result=req.body?.result||{};const signature=String(req.body?.signature||'').trim().toLowerCase();
  const secret=tx.secret_env_key?process.env[String(tx.secret_env_key)]:'';
  if(!secret)return res.status(503).json({message:'A terminál bridge aláírási titka nincs konfigurálva a szerveren.'});
  const canonical=JSON.stringify(result),expected=createHmac('sha256',secret).update(canonical).digest('hex');
  const a=Buffer.from(signature),b=Buffer.from(expected);
  if(!signature||a.length!==b.length||!timingSafeEqual(a,b))return res.status(401).json({message:'Érvénytelen terminál bridge aláírás.'});
  const status=String(result.status||'').toUpperCase();
  if(!STATUSES.has(status))return res.status(400).json({message:'Érvénytelen terminál státusz.'});
  if(money(result.amount)!==money(tx.amount)||String(result.currency||'').toUpperCase()!==String(tx.currency).toUpperCase())return res.status(409).json({message:'A terminál eredményének összege vagy pénzneme eltér a VIR tranzakciótól.'});
  const row=(await db.query(`UPDATE vir_payment_terminal_transactions SET status=$2,sent_at=COALESCE(sent_at,now()),completed_at=now(),external_transaction_id=$3,approval_code=$4,receipt_reference=$5,error_message=$6 WHERE id=$1::uuid RETURNING *`,[req.params.id,status,String(result.external_transaction_id||'')||null,String(result.approval_code||'')||null,String(result.receipt_reference||'')||null,String(result.error_message||'')||null])).rows[0];
  return res.json(row);
 }catch(e){next(e)}
});

export default router;
