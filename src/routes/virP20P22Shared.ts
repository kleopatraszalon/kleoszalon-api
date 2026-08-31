import { Response } from "express";
import pool from "../db";
import type { AuthRequest } from "../middleware/auth";
import { locationBelongsToTenant } from "../saas/tenantAccess";

export const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function tenantId(req:AuthRequest,res:Response):string|undefined{
  const value=String(req.user?.tenant_id??"").trim();
  if(!/^\d+$/.test(value)||Number(value)<=0){res.status(403).json({ok:false,error:"tenant_context_required"});return;}
  return value;
}
export function actorId(req:AuthRequest):string{return String(req.user?.id??req.user?.employee_id??"system");}
export function clamp(n:number,min:number,max:number):number{return Math.max(min,Math.min(max,n));}
export function average(values:number[]):number{return values.length?values.reduce((a,b)=>a+b,0)/values.length:0;}
export async function safeRows(sql:string,args:any[]=[]):Promise<any[]>{try{return (await pool.query(sql,args)).rows;}catch{return [];}}
export async function validateLocation(value:unknown,tenant:string,res:Response):Promise<string|null|undefined>{
  const id=String(value??"").trim();
  if(!id)return null;
  if(!UUID.test(id)){res.status(400).json({ok:false,error:"invalid_location_id"});return;}
  if(!(await locationBelongsToTenant(id,tenant))){res.status(403).json({ok:false,error:"tenant_location_mismatch"});return;}
  return id;
}
export function parseHorizon(value:unknown):7|30|90{const n=Number(value);return n===30?30:n===90?90:7;}
export function parseObservationDays(value:unknown):7|14|30{const n=Number(value);return n===14?14:n===30?30:7;}

export async function readKpis(tenant:string,location:string|null,days:number){
  const row=(await safeRows(`SELECT COUNT(DISTINCT a.id)::int bookings,COALESCE(SUM(CASE WHEN a.status NOT IN ('cancelled','no_show') THEN COALESCE(aps.price,0) ELSE 0 END),0)::numeric revenue,COUNT(DISTINCT a.id) FILTER(WHERE a.status='no_show')::int no_shows,COUNT(DISTINCT a.id) FILTER(WHERE a.status='cancelled')::int cancellations FROM appointments a LEFT JOIN appointment_services aps ON aps.appointment_id=a.id WHERE a.tenant_id::text=$1 AND ($2::uuid IS NULL OR a.location_id=$2::uuid) AND a.start_time>=now()-($3::text||' days')::interval AND a.start_time<now()`,[tenant,location,String(days)]))[0]||{};
  const bookings=Number(row.bookings||0),noShows=Number(row.no_shows||0);
  return {days,bookings,revenue:Number(row.revenue||0),no_shows:noShows,cancellations:Number(row.cancellations||0),no_show_percent:bookings>0?Number((noShows/bookings*100).toFixed(3)):0};
}
