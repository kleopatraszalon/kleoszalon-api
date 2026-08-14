import type { Response,NextFunction } from "express";
import pool from "../db";
import { requireAuth,type AuthRequest } from "./auth";

function roles(raw:unknown):string[]{
  if(Array.isArray(raw))return raw.map(String).map(x=>x.toLowerCase());
  const value=String(raw??"");
  try{const parsed=JSON.parse(value);if(Array.isArray(parsed))return parsed.map(String).map(x=>x.toLowerCase());if(parsed!=null)return[String(parsed).toLowerCase()]}catch{}
  return value.split(",").map(x=>x.replace(/[\[\]"]/g,"").trim().toLowerCase()).filter(Boolean);
}
function elevated(req:AuthRequest){return roles(req.user?.role).some(r=>["admin","administrator","rendszergazda","superadmin","super_admin","manager","vezető","vezeto","location_manager","üzletvezető","uzletvezeto","store_manager","branch_manager"].includes(r));}
function receptionist(req:AuthRequest){return roles(req.user?.role).some(r=>["receptionist","reception","recepciós","recepcios"].includes(r));}

async function resolveEmployee(req:AuthRequest){
  const id=String(req.user?.id??"").trim();const email=String(req.user?.email??"").trim();
  const{rows}=await pool.query(`SELECT id,location_id FROM employees WHERE COALESCE(active,true)=true AND (id::text=$1 OR ($2<>'' AND (lower(COALESCE(email,''))=lower($2) OR lower(COALESCE(login_name,''))=lower($2)))) ORDER BY CASE WHEN id::text=$1 THEN 0 ELSE 1 END LIMIT 1`,[id,email]);
  return rows[0]??null;
}

async function guard(req:AuthRequest,res:Response,next:NextFunction){
  try{
    if(elevated(req))return next();
    const employee=await resolveEmployee(req);
    if(!employee)return res.status(403).json({error:"A művelethez nem található saját munkatársi rekord."});
    const path=String(req.path||"");

    if(req.method==="GET"&&path==="/"){
      if(!receptionist(req))return res.status(403).json({error:"A teljes időpont-beosztás csak vezetői vagy recepciós felületen érhető el."});
      if(!employee.location_id)return res.status(403).json({error:"A recepciós fiókhoz nincs szalon rendelve."});
      (req.query as any).location_id=String(employee.location_id);
      return next();
    }
    if(req.method==="GET"&&path==="/schedule"){
      (req.query as any).location_id=employee.location_id?String(employee.location_id):"";
      return next();
    }
    if(req.method==="PUT"&&path.startsWith("/profiles/"))return res.status(403).json({error:"A munkaidőprofil módosítása vezetői jogosultságot igényel."});
    if(req.method==="POST"&&path==="/publish")return res.status(403).json({error:"A beosztás közzététele vezetői jogosultságot igényel."});

    if(req.method==="POST"&&path==="/shifts"){
      if(String(req.body?.employee_id||"")!==String(employee.id))return res.status(403).json({error:"Munkatársként csak a saját beosztása szerkeszthető."});
      req.body.location_id=employee.location_id??null;
      return next();
    }

    const match=path.match(/^\/shifts\/([^/]+)$/);
    if(match&&(req.method==="PATCH"||req.method==="DELETE")){
      const{rows}=await pool.query("SELECT employee_id FROM work_shifts WHERE id=$1 LIMIT 1",[match[1]]);
      if(!rows[0])return res.status(404).json({error:"A műszak nem található."});
      if(String(rows[0].employee_id)!==String(employee.id))return res.status(403).json({error:"Munkatársként csak a saját beosztása szerkeszthető."});
      if(req.method==="PATCH")req.body.location_id=employee.location_id??null;
      return next();
    }

    return next();
  }catch(error){next(error);}
}

export default function timetableSelfAccess(req:AuthRequest,res:Response,next:NextFunction){
  if(req.user)return void guard(req,res,next);
  return requireAuth(req,res,()=>void guard(req,res,next));
}
