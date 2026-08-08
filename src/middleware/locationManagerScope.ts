import type { Response, NextFunction } from "express";
import db from "../db";
import { requireAuth, type AuthRequest } from "./auth";

export type LocationScopeKind =
  | "dashboard"
  | "employees"
  | "clients"
  | "appointments"
  | "workorders"
  | "inventory"
  | "procurement"
  | "timetable"
  | "checklists";

function normalizeRole(value:string){
  const role=value.trim().toLowerCase();
  if(["üzletvezető","uzletvezeto","store_manager","branch_manager"].includes(role)) return "location_manager";
  return role;
}

function roleKeys(req:AuthRequest):string[]{
  const raw:any=req.user?.role;
  if(Array.isArray(raw)) return raw.map(String).map(normalizeRole).filter(Boolean);
  const text=String(raw??"");
  try{
    const parsed=JSON.parse(text);
    if(Array.isArray(parsed)) return parsed.map(String).map(normalizeRole).filter(Boolean);
    if(parsed!=null) return [normalizeRole(String(parsed))].filter(Boolean);
  }catch{}
  return text.split(",").map(x=>x.replace(/[\[\]"]/g,"")).map(normalizeRole).filter(Boolean);
}

function isLocationManager(req:AuthRequest){return roleKeys(req).includes("location_manager");}
function ownLocation(req:AuthRequest){return req.user?.location_id==null?"":String(req.user.location_id).trim();}
function isId(value:string){return /^[0-9a-f-]{8,}$/i.test(value)||/^\d+$/.test(value);}
function pathParts(req:AuthRequest){return String(req.path||"").split("/").filter(Boolean);}

function forceLocation(req:AuthRequest,locationId:string){
  (req.query as any).location_id=locationId;
  if(!req.body||typeof req.body!=="object") req.body={};
  (req.body as any).location_id=locationId;
}

async function entityInLocation(table:string,id:string,locationId:string){
  const allowed=new Set(["employees","clients","appointments","work_orders","product_stock_balances","purchase_orders"]);
  if(!allowed.has(table)) return false;
  const {rows}=await db.query(`SELECT 1 FROM ${table} WHERE id::text=$1 AND location_id::text=$2 LIMIT 1`,[id,locationId]);
  return Boolean(rows[0]);
}

async function shiftInLocation(id:string,locationId:string){
  const {rows}=await db.query(`SELECT 1 FROM work_shifts s JOIN employees e ON e.id=s.employee_id WHERE s.id::text=$1 AND COALESCE(s.location_id,e.location_id)::text=$2 LIMIT 1`,[id,locationId]);
  return Boolean(rows[0]);
}

async function employeeInLocation(id:unknown,locationId:string){
  const value=String(id??"").trim(); if(!value) return false;
  return entityInLocation("employees",value,locationId);
}

function sanitizeCreatedEmployee(req:AuthRequest,locationId:string){
  if(!req.body||typeof req.body!=="object") req.body={};
  req.body.location_id=locationId;
  const requested=Array.isArray(req.body.roles)?req.body.roles.map(String).map(normalizeRole):[];
  const safe=requested.filter((r:string)=>["employee","receptionist"].includes(r));
  req.body.roles=safe.length?safe:["employee"];
}

async function guard(req:AuthRequest,res:Response,next:NextFunction,kind:LocationScopeKind){
  try{
    if(!isLocationManager(req)) return next();
    const locationId=ownLocation(req);
    if(!locationId) return res.status(403).json({error:"Az üzletvezetői fiókhoz nincs telephely rendelve."});
    forceLocation(req,locationId);
    const parts=pathParts(req);

    if(kind==="employees"){
      if(req.method==="POST"&&parts.length===0) sanitizeCreatedEmployee(req,locationId);
      if(req.method==="POST"&&parts[0]==="import"&&Array.isArray(req.body?.records)){
        req.body.records=req.body.records.map((row:any)=>({...row,location_id:locationId,location_name:undefined,roles:["employee"]}));
      }
      const id=parts[0];
      if(id&&isId(id)&&!(await entityInLocation("employees",id,locationId))) return res.status(404).json({error:"A munkatárs nem ehhez az üzlethez tartozik."});
    }

    if(kind==="clients"){
      const id=parts[0];
      if(id&&isId(id)&&!(await entityInLocation("clients",id,locationId))) return res.status(404).json({error:"Az ügyfél nem ehhez az üzlethez tartozik."});
      if(req.method==="PATCH"&&id&&isId(id)) req.body.location_id=locationId;
    }

    if(kind==="appointments"){
      const id=parts[0];
      if(id&&isId(id)&&!(await entityInLocation("appointments",id,locationId))) return res.status(404).json({error:"Az időpont nem ehhez az üzlethez tartozik."});
      if((req.method==="POST"||req.method==="PATCH")&&req.body?.employee_id&&!(await employeeInLocation(req.body.employee_id,locationId))) return res.status(403).json({error:"Csak a saját üzlet munkatársához rögzíthető időpont."});
      if(req.body&&typeof req.body==="object") req.body.location_id=locationId;
    }

    if(kind==="workorders"){
      const id=parts[0]==="workorders"?parts[1]:parts[0];
      if(id&&isId(id)&&!(await entityInLocation("work_orders",id,locationId))) return res.status(404).json({error:"A munkalap nem ehhez az üzlethez tartozik."});
      if((req.method==="POST"||req.method==="PATCH")&&req.body?.employee_id&&!(await employeeInLocation(req.body.employee_id,locationId))) return res.status(403).json({error:"Csak a saját üzlet munkatársához rögzíthető munkalap."});
      if(req.body&&typeof req.body==="object") req.body.location_id=locationId;
    }

    if(kind==="inventory"){
      if(parts[0]==="balances"&&parts[1]&&isId(parts[1])&&!(await entityInLocation("product_stock_balances",parts[1],locationId))) return res.status(404).json({error:"A készletegyenleg nem ehhez az üzlethez tartozik."});
    }

    if(kind==="procurement"){
      if(parts[0]==="orders"&&parts[1]&&isId(parts[1])&&!(await entityInLocation("purchase_orders",parts[1],locationId))) return res.status(404).json({error:"A beszerzési rendelés nem ehhez az üzlethez tartozik."});
      if(req.body&&typeof req.body==="object") req.body.location_id=locationId;
    }

    if(kind==="timetable"){
      if(parts[0]==="profiles"&&parts[1]&&!(await employeeInLocation(parts[1],locationId))) return res.status(404).json({error:"A munkatárs nem ehhez az üzlethez tartozik."});
      if(parts[0]==="shifts"&&parts[1]&&isId(parts[1])&&!(await shiftInLocation(parts[1],locationId))) return res.status(404).json({error:"A műszak nem ehhez az üzlethez tartozik."});
      if(req.method==="POST"&&parts[0]==="shifts"&&req.body?.employee_id&&!(await employeeInLocation(req.body.employee_id,locationId))) return res.status(403).json({error:"Csak a saját üzlet munkatársának készíthető beosztás."});
      if(req.method==="POST"&&parts[0]==="publish"&&Array.isArray(req.body?.shift_ids)){
        for(const id of req.body.shift_ids) if(!(await shiftInLocation(String(id),locationId))) return res.status(403).json({error:"A közzététel másik üzlet műszakát is tartalmazza."});
      }
      if(req.body&&typeof req.body==="object") req.body.location_id=locationId;
    }

    return next();
  }catch(error){return next(error);}
}

export function locationManagerScope(kind:LocationScopeKind){
  return (req:AuthRequest,res:Response,next:NextFunction)=>{
    if(req.user) return void guard(req,res,next,kind);
    return requireAuth(req,res,()=>void guard(req,res,next,kind));
  };
}
