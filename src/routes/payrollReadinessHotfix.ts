import { Router, Response } from "express";
import db from "../db";
import { requireAuth, type AuthRequest } from "../middleware/auth";
import { parseRoleKeys } from "../security/roles";

const router = Router();
router.use(requireAuth);

const ISO_DATE=/^\d{4}-\d{2}-\d{2}$/;

type Warning={section:string;code:string;message:string};

function resolveScope(req:AuthRequest){
  const roles=parseRoleKeys(req.user?.role);
  if(roles.includes("admin")||roles.includes("manager")){
    return {ok:true,admin:true,location:String(req.query.location_id||"").trim()||null};
  }
  if(roles.includes("location_manager")){
    const own=req.user?.location_id?String(req.user.location_id):"";
    if(!own)return {ok:false,status:403,message:"A felhasználóhoz nincs szalon rendelve."};
    return {ok:true,admin:false,location:own};
  }
  return {ok:false,status:403,message:"A bérszámfejtési állapothoz adminisztrátori vagy üzletvezetői jogosultság szükséges."};
}

function isRecoverablePgError(code:string){
  if(!/^[0-9A-Z]{5}$/.test(code))return false;
  if(code.startsWith("08"))return false;
  if(["57P01","57P02","57P03"].includes(code))return false;
  return true;
}

async function safeOne(section:string,sql:string,params:any[],fallback:any,warnings:Warning[]){
  try{return (await db.query(sql,params)).rows[0]||fallback}
  catch(error:any){
    const code=String(error?.code||"unknown");
    if(isRecoverablePgError(code)){
      console.warn(`[payroll-readiness] ${section} partial fallback`,code,error?.message||error);
      warnings.push({section,code,message:String(error?.message||error)});
      return fallback;
    }
    throw error;
  }
}

router.get("/readiness",async(req:AuthRequest,res:Response,next)=>{
  try{
    const scope:any=resolveScope(req);
    if(!scope.ok)return res.status(scope.status||403).json({error:scope.message});
    const from=String(req.query.from||new Date().toISOString().slice(0,8)+"01");
    const to=String(req.query.to||new Date().toISOString().slice(0,10));
    if(!ISO_DATE.test(from)||!ISO_DATE.test(to))return res.status(400).json({error:"Érvénytelen dátumtartomány."});
    const location=String(scope.location||"");
    const params=[from,to,location];
    const warnings:Warning[]=[];

    const staff=await safeOne("staff",`
      SELECT COUNT(*)::int active_employees,
             COUNT(*) FILTER(WHERE c.id IS NULL)::int missing_contract,
             COUNT(*) FILTER(WHERE ca.id IS NULL)::int missing_compensation
        FROM employees e
        LEFT JOIN LATERAL(
          SELECT id FROM employment_contracts c
           WHERE c.employee_id=e.id AND COALESCE(c.is_active,true) LIMIT 1
        ) c ON true
        LEFT JOIN LATERAL(
          SELECT id FROM employee_compensation_assignments a
           WHERE a.employee_id=e.id AND COALESCE(a.is_active,true) LIMIT 1
        ) ca ON true
       WHERE COALESCE(e.active,true) AND ($3='' OR e.location_id::text=$3)`,params,
      {active_employees:0,missing_contract:0,missing_compensation:0},warnings);

    const attendance=await safeOne("attendance",`
      SELECT COUNT(*) FILTER(WHERE COALESCE(t.status,'draft')<>'approved')::int unapproved_timesheets,
             COUNT(*) FILTER(WHERE t.status='approved')::int approved_timesheets,
             COALESCE(SUM(COALESCE(t.overtime_minutes,0)) FILTER(WHERE t.status='approved'),0)::int approved_overtime_minutes
        FROM timesheets t
       WHERE t.work_date BETWEEN $1::date AND $2::date AND ($3='' OR t.location_id::text=$3)`,params,
      {unapproved_timesheets:0,approved_timesheets:0,approved_overtime_minutes:0},warnings);

    const leave=await safeOne("leave",`
      SELECT COUNT(*) FILTER(WHERE r.status='pending')::int pending_leave,
             COUNT(*) FILTER(WHERE r.status='approved' AND COALESCE(lt.is_paid,false))::int approved_paid_leave
        FROM leave_requests r
        JOIN leave_types lt ON lt.id=r.leave_type_id
        JOIN employees e ON e.id=r.employee_id
       WHERE r.date_from<=$2::date AND r.date_to>=$1::date AND ($3='' OR e.location_id::text=$3)`,params,
      {pending_leave:0,approved_paid_leave:0},warnings);

    const commission=await safeOne("commission",`
      SELECT COUNT(*) FILTER(WHERE ce.status='open')::int open_commissions,
             COUNT(*) FILTER(WHERE ce.status='included')::int included_commissions,
             COUNT(*) FILTER(WHERE ce.status='paid')::int paid_commissions,
             COALESCE(SUM(COALESCE(ce.base_amount,0)) FILTER(WHERE ce.status='open'),0)::numeric open_commission_base,
             COALESCE(SUM(COALESCE(ce.tip_amount,0)) FILTER(WHERE ce.status='open'),0)::numeric open_tips
        FROM work_order_commission_events ce
        JOIN work_orders w ON w.id=ce.work_order_id
       WHERE ce.created_at::date BETWEEN $1::date AND $2::date AND ($3='' OR w.location_id::text=$3)`,params,
      {open_commissions:0,included_commissions:0,paid_commissions:0,open_commission_base:0,open_tips:0},warnings);

    const data={...staff,...attendance,...leave,...commission};
    const businessReady=Number(data.missing_contract||0)===0&&Number(data.missing_compensation||0)===0&&Number(data.unapproved_timesheets||0)===0&&Number(data.pending_leave||0)===0;
    return res.json({
      from,to,
      scope:{admin:Boolean(scope.admin),location:scope.location||null},
      ...data,
      ready:businessReady&&warnings.length===0,
      schema_ready:warnings.length===0,
      schema_warnings:warnings.map(w=>({section:w.section,code:w.code})),
      message:warnings.length?"A readiness részben elérhető; egy vagy több HR/bér tábla vagy mező még nincs a live adatbázisban.":undefined,
    });
  }catch(error){next(error)}
});

export default router;