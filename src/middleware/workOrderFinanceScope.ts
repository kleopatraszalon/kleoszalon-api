import type{Response,NextFunction}from'express';
import db from'../db';
import{requireAuth,type AuthRequest}from'./auth';

const ADMIN=new Set(['admin','administrator','rendszergazda','superadmin','super_admin']);
const RECEPTION=new Set(['receptionist','recepciós','recepcios','reception']);
const BUSINESS=new Set(['location_manager','üzletvezető','uzletvezeto','store_manager','branch_manager','salon_manager','szalonvezető','szalonvezeto']);
const SCOPED=new Set([...RECEPTION,...BUSINESS]);
const roles=(raw:any)=>{if(Array.isArray(raw))return raw.map(String).map(x=>x.toLowerCase());try{const p=JSON.parse(String(raw||''));if(Array.isArray(p))return p.map(String).map(x=>x.toLowerCase())}catch{}return String(raw||'').split(',').map(x=>x.replace(/[\[\]"]/g,'').trim().toLowerCase()).filter(Boolean)};
const idLike=(v:string)=>/^[0-9a-f-]{8,}$/i.test(v)||/^\d+$/.test(v);

async function guard(req:AuthRequest,res:Response,next:NextFunction){
 try{
  const r=roles(req.user?.role);
  if(r.some(x=>ADMIN.has(x))){res.locals.workOrderFinanceScope={kind:'all',canEdit:true,locationId:null};return next()}
  if(!r.some(x=>SCOPED.has(x)))return res.status(403).json({message:'Pénzügyi munkalapműveletet csak adminisztrátor, recepciós vagy üzlet-/szalonvezető végezhet.'});
  const locationId=String(req.user?.location_id||'').trim();
  if(!locationId)return res.status(403).json({message:'A felhasználóhoz nincs szalon rendelve.'});
  res.locals.workOrderFinanceLocationId=locationId;
  res.locals.workOrderFinanceScope={kind:'location',canEdit:true,locationId};
  if(!req.body||typeof req.body!=='object')req.body={};
  (req.query as any).location_id=locationId;
  (req.body as any).location_id=locationId;
  const parts=String(req.path||'').split('/').filter(Boolean);let workOrderId='';
  const wi=parts.indexOf('workorders');if(wi>=0&&parts[wi+1]&&idLike(parts[wi+1]))workOrderId=parts[wi+1];
  if(workOrderId){const q=await db.query(`SELECT 1 FROM work_orders WHERE id::text=$1 AND location_id::text=$2 LIMIT 1`,[workOrderId,locationId]);if(!q.rows[0])return res.status(404).json({message:'A munkalap nem ehhez a szalonhoz tartozik.'})}
  return next()
 }catch(e){next(e)}
}

export default function workOrderFinanceScope(req:AuthRequest,res:Response,next:NextFunction){if(req.user)return void guard(req,res,next);return requireAuth(req,res,()=>void guard(req,res,next))}
