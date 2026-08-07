import { Router } from "express";
import db from "../db";
import { requireAuth, AuthRequest } from "../middleware/auth";

const router = Router();
router.use(requireAuth);

function isAdmin(req: AuthRequest) {
  const raw:any=req.user?.role;
  const roles=Array.isArray(raw)?raw:String(raw||"").replace(/[\[\]"]/g,"").split(",");
  return roles.map((x:any)=>String(x).trim().toLowerCase()).includes("admin");
}

const checks=[
  ["database","Adatbázis kapcsolat","SELECT 1 ok"],
  ["menus","Menürendszer","SELECT count(*)::int count FROM menus WHERE COALESCE(is_active,true)"],
  ["permissions","Jogosultságok","SELECT count(*)::int count FROM role_menu_permissions"],
  ["employees","HR / munkatársak","SELECT count(*)::int count FROM employees"],
  ["services","Szolgáltatások","SELECT count(*)::int count FROM services"],
  ["workorders","Munkalapok","SELECT count(*)::int count FROM work_orders"],
  ["finance","Pénzügyi számlák","SELECT count(*)::int count FROM finance_invoices"],
  ["accounts","Pénztár / bankszámlák","SELECT count(*)::int count FROM financial_accounts"],
  ["procurement","Beszerzés","SELECT count(*)::int count FROM purchase_orders"],
  ["suppliers","Beszállítók","SELECT count(*)::int count FROM suppliers"],
  ["payroll","Bérszámfejtés","SELECT count(*)::int count FROM payroll_runs"],
  ["audit","Auditnapló","SELECT count(*)::int count FROM audit_log"],
  ["notifications","Értesítések","SELECT count(*)::int count FROM notifications"]
] as const;

router.get("/",async(req:AuthRequest,res)=>{
 if(!isAdmin(req)) return res.status(403).json({message:"A rendszerellenőrzés csak adminisztrátornak érhető el."});
 const results:any[]=[];
 for(const [key,label,sql] of checks){
   const started=Date.now();
   try{const q=await db.query(sql);const count=q.rows?.[0]?.count;results.push({key,label,status:"ok",count:count==null?null:Number(count),latency_ms:Date.now()-started,message:count==null?"Elérhető":`${count} rekord`});}
   catch(e:any){results.push({key,label,status:"error",count:null,latency_ms:Date.now()-started,message:e?.message||String(e)});}
 }
 // üzleti konzisztencia ellenőrzések
 try{const q=await db.query(`SELECT count(*)::int count FROM finance_invoices WHERE status='approved' AND due_date<CURRENT_DATE AND paid_at IS NULL`);results.push({key:"overdue_invoices",label:"Lejárt számlák",status:Number(q.rows[0].count)>0?"warning":"ok",count:Number(q.rows[0].count),message:Number(q.rows[0].count)>0?"Beavatkozást igényel":"Nincs lejárt nyitott számla"});}catch{}
 try{const q=await db.query(`SELECT count(*)::int count FROM menus m LEFT JOIN role_menu_permissions p ON p.menu_id=m.id WHERE COALESCE(m.is_active,true) AND p.menu_id IS NULL`);results.push({key:"menu_permissions",label:"Menü-jogosultság lefedettség",status:Number(q.rows[0].count)>0?"warning":"ok",count:Number(q.rows[0].count),message:Number(q.rows[0].count)>0?"Van jogosultság nélküli menüpont":"Rendben"});}catch{}
 const errors=results.filter(x=>x.status==='error').length,warnings=results.filter(x=>x.status==='warning').length;
 res.json({generated_at:new Date().toISOString(),status:errors?'error':warnings?'warning':'ok',summary:{total:results.length,ok:results.filter(x=>x.status==='ok').length,warnings,errors},checks:results});
});
export default router;
