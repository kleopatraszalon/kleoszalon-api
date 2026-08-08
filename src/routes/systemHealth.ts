import { Router } from "express";
import db from "../db";
import { requireAuth, AuthRequest } from "../middleware/auth";

const router = Router();
router.use(requireAuth);

type Status = "ok" | "warning" | "error";
type Result = { key:string; group:string; label:string; status:Status; count?:number|null; latency_ms?:number; message:string };

function roles(req:AuthRequest){const raw:any=req.user?.role;const arr=Array.isArray(raw)?raw:String(raw||"").replace(/[\[\]"]/g,"").split(",");return arr.map((x:any)=>String(x).trim().toLowerCase()).filter(Boolean);}
function canUse(req:AuthRequest){const r=roles(req);return r.includes("admin")||r.includes("manager");}
async function exists(table:string){const {rows}=await db.query(`SELECT to_regclass($1) IS NOT NULL ok`,[`public.${table}`]);return Boolean(rows[0]?.ok)}
async function count(sql:string,params:any[]=[]){const {rows}=await db.query(sql,params);return Number(Object.values(rows[0]||{})[0]||0)}

router.get("/",async(req:AuthRequest,res,next)=>{
 if(!canUse(req))return res.status(403).json({message:"A rendszerellenőrzés csak adminisztrátor vagy vezető számára érhető el."});
 const startedAll=Date.now();
 try{
  const results:Result[]=[];const locationId=String(req.query.location_id||req.user?.location_id||"").trim();const add=(x:Result)=>results.push(x);
  try{const s=Date.now();await db.query("SELECT 1");add({key:"database",group:"Alaprendszer",label:"PostgreSQL kapcsolat",status:"ok",latency_ms:Date.now()-s,message:"Az adatbázis elérhető."});}
  catch(e:any){add({key:"database",group:"Alaprendszer",label:"PostgreSQL kapcsolat",status:"error",message:e?.message||String(e)});return res.json({generated_at:new Date().toISOString(),status:"error",duration_ms:Date.now()-startedAll,summary:{total:1,ok:0,warnings:0,errors:1},checks:results});}

  const required:[string,string,string][]=[
   ["menus","Adatbázis-séma","Menürendszer"],["role_menu_permissions","Adatbázis-séma","Menüjogosultságok"],
   ["locations","Alapadatok","Telephelyek"],["employees","HR","Munkatársak"],["services","Foglalás","Szolgáltatások"],
   ["appointments","Foglalás","Időpontok"],["work_orders","Munkalap","Munkalapok"],
   ["financial_accounts","Pénzügy","Pénztárak / bankszámlák"],["finance_invoices","Pénzügy","Bejövő/kimenő számlák"],
   ["accounting_journal_entries","Könyvelés","Főkönyvi napló"],["accounting_journal_lines","Könyvelés","Főkönyvi sorok"],
   ["nav_online_invoice_settings","NAV Online Számla","NAV technikai beállítások"],["nav_invoice_submissions","NAV Online Számla","NAV beküldések"],
   ["nav_invoice_validation_runs","NAV Online Számla","NAV validációk"],["nav_invoice_queue","NAV Online Számla","NAV beküldési sor"],
   ["payroll_runs","Bérszámfejtés","Számfejtési futások"],["payroll_items","Bérszámfejtés","Számfejtési tételek"],
   ["purchase_orders","Beszerzés","Beszerzési rendelések"],["suppliers","Beszerzés","Beszállítók"],
   ["booking_communication_queue","Kommunikáció","Foglalási üzenetsor"],["audit_log","Biztonság","Auditnapló"],["notifications","Kommunikáció","Értesítések"]
  ];
  const tableMap=new Map<string,boolean>();
  for(const [table,group,label] of required){const s=Date.now();const ok=await exists(table);tableMap.set(table,ok);add({key:`table.${table}`,group,label,status:ok?"ok":"error",latency_ms:Date.now()-s,message:ok?`${table}: rendben`:`${table} tábla hiányzik; migráció szükséges.`});}

  const dataChecks:[string,string,string][]=[["locations","Alapadatok","Telephelyek"],["employees","HR","Munkatársak"],["services","Foglalás","Szolgáltatások"],["appointments","Foglalás","Időpontok"],["work_orders","Munkalap","Munkalapok"],["suppliers","Beszerzés","Beszállítók"]];
  for(const [table,group,label] of dataChecks){if(!tableMap.get(table))continue;const c=await count(`SELECT COUNT(*) FROM ${table}`);add({key:`data.${table}`,group,label,status:c>0?"ok":"warning",count:c,message:c>0?`${c} rekord található.`:"A tábla üres; tesztadatra lehet szükség."});}

  if(tableMap.get("menus")){
   const c=await count(`SELECT COUNT(*) FROM menus WHERE COALESCE(is_active,true)`);add({key:"menu.active",group:"Menü és jogosultság",label:"Aktív menüpontok",status:c>0?"ok":"error",count:c,message:c?`${c} aktív menüpont.`:"Nincs aktív menüpont."});
   const workorders=await count(`SELECT COUNT(*) FROM menus WHERE COALESCE(is_active,true) AND code='appointments.workorders' AND route='/workorders'`);add({key:"menu.workorders",group:"Menü és jogosultság",label:"Munkalapok menü",status:workorders?"ok":"error",count:workorders,message:workorders?"A Munkalapok menüpont aktív és jó route-ra mutat.":"A Munkalapok menüpont hiányzik vagy hibás route-ra mutat."});
   const nav=await count(`SELECT COUNT(*) FROM menus WHERE COALESCE(is_active,true) AND code='finance.nav_online_invoice' AND route='/finance/nav-online-invoice'`);add({key:"menu.nav",group:"NAV Online Számla",label:"NAV Online Számla menü",status:nav?"ok":"error",count:nav,message:nav?"A NAV Online Számla menüpont aktív.":"A NAV Online Számla menüpont hiányzik vagy hibás route-ra mutat."});
  }
  if(tableMap.get("menus")&&tableMap.get("role_menu_permissions")){const c=await count(`SELECT COUNT(*) FROM menus m LEFT JOIN role_menu_permissions p ON p.menu_id=m.id WHERE COALESCE(m.is_active,true) AND p.menu_id IS NULL`);add({key:"menu.coverage",group:"Menü és jogosultság",label:"Jogosultsági lefedettség",status:c?"warning":"ok",count:c,message:c?`${c} aktív menüpontnak nincs szerepkör-hozzárendelése.`:"Minden aktív menüponthoz tartozik jogosultsági rekord."});}

  if(tableMap.get("nav_online_invoice_settings")){
   const cfg=await count(`SELECT COUNT(*) FROM nav_online_invoice_settings WHERE active=true`);add({key:"nav.config",group:"NAV Online Számla",label:"Aktív NAV konfiguráció",status:cfg?"ok":"warning",count:cfg,message:cfg?`${cfg} aktív NAV konfiguráció található.`:"A NAV modul technikailag rendelkezésre áll, de még nincs aktív technikai felhasználói konfiguráció."});
  }

  if(tableMap.get("finance_invoices")){
   const where=locationId?` AND (location_id::text=$1 OR location_id IS NULL)`:"";const p=locationId?[locationId]:[];
   const overdue=await count(`SELECT COUNT(*) FROM finance_invoices WHERE status IN ('approved','overdue') AND due_date<CURRENT_DATE${where}`,p);
   const missingNo=await count(`SELECT COUNT(*) FROM finance_invoices WHERE status<>'cancelled' AND invoice_no IS NULL${where}`,p);
   const unposted=await count(`SELECT COUNT(*) FROM finance_invoices WHERE status IN ('approved','paid','overdue') AND journal_entry_id IS NULL${where}`,p);
   const badVat=await count(`SELECT COUNT(*) FROM finance_invoices WHERE status<>'cancelled' AND ABS((net_total+vat_total)-gross_total)>0.01${where}`,p);
   add({key:"finance.overdue",group:"Pénzügy",label:"Lejárt nyitott számlák",status:overdue?"warning":"ok",count:overdue,message:overdue?`${overdue} lejárt számla beavatkozást igényel.`:"Nincs lejárt nyitott számla."});
   add({key:"finance.invoice_no",group:"Pénzügy",label:"Hiányzó számlaszám",status:missingNo?"warning":"ok",count:missingNo,message:missingNo?`${missingNo} aktív számlán nincs számlaszám.`:"Számlaszámok rendben."});
   add({key:"finance.ledger",group:"Könyvelés",label:"Nem könyvelt számlák",status:unposted?"warning":"ok",count:unposted,message:unposted?`${unposted} számla még nincs főkönyvben.`:"A releváns számlák könyveltek."});
   add({key:"finance.vat",group:"Pénzügy",label:"Nettó + ÁFA = bruttó",status:badVat?"error":"ok",count:badVat,message:badVat?`${badVat} számla összege matematikailag eltér.`:"A számlaösszegek konzisztensen zárnak."});
  }

  if(tableMap.get("accounting_journal_entries")&&tableMap.get("accounting_journal_lines")){const c=await count(`SELECT COUNT(*) FROM (SELECT je.id FROM accounting_journal_entries je JOIN accounting_journal_lines jl ON jl.journal_entry_id=je.id GROUP BY je.id HAVING ABS(COALESCE(SUM(jl.debit),0)-COALESCE(SUM(jl.credit),0))>0.01) q`);add({key:"ledger.balance",group:"Könyvelés",label:"Tartozik / Követel egyensúly",status:c?"error":"ok",count:c,message:c?`${c} kiegyensúlyozatlan naplótétel.`:"A főkönyvi tételek egyensúlyban vannak."});}
  if(tableMap.get("payroll_runs")){const c=await count(`SELECT COUNT(*) FROM payroll_runs WHERE status IN ('draft','calculated')`);add({key:"payroll.pending",group:"Bérszámfejtés",label:"Nyitott számfejtések",status:c?"warning":"ok",count:c,message:c?`${c} számfejtési futás nincs még jóváhagyva.`:"Nincs függő számfejtési futás."});}
  if(tableMap.get("booking_communication_queue")){const c=await count(`SELECT COUNT(*) FROM booking_communication_queue WHERE status='failed'`);add({key:"booking.failed_messages",group:"Kommunikáció",label:"Sikertelen foglalási értesítések",status:c?"warning":"ok",count:c,message:c?`${c} sikertelen üzenet található.`:"A foglalási üzenetsorban nincs sikertelen tétel."});}
  if(tableMap.get("purchase_orders")&&tableMap.get("finance_invoices")){const c=await count(`SELECT COUNT(*) FROM purchase_orders po LEFT JOIN finance_invoices fi ON fi.purchase_order_id=po.id::text AND fi.direction='incoming' AND fi.status<>'cancelled' WHERE po.status IN ('partially_received','received') AND fi.id IS NULL`);add({key:"procurement.invoice_link",group:"Beszerzés",label:"Bevételezés → bejövő számla",status:c?"warning":"ok",count:c,message:c?`${c} bevételezett rendeléshez nincs kapcsolt bejövő számla.`:"A bevételezett rendelések számlakapcsolata rendben."});}
  if(tableMap.get("work_orders")&&tableMap.get("finance_invoices")){const c=await count(`SELECT COUNT(*) FROM work_orders wo LEFT JOIN finance_invoices fi ON fi.work_order_id=wo.id::text AND fi.direction='outgoing' AND fi.status<>'cancelled' WHERE wo.financial_closed_at IS NOT NULL AND COALESCE(wo.invoice_status,'not_requested') IN ('requested','issued') AND fi.id IS NULL`);add({key:"workorder.invoice_link",group:"Munkalap",label:"Munkalap → kimenő számla",status:c?"warning":"ok",count:c,message:c?`${c} lezárt, számlás munkalaphoz nincs kapcsolt számla.`:"A számlás munkalapok kapcsolata rendben."});}

  const errors=results.filter(x=>x.status==="error").length,warnings=results.filter(x=>x.status==="warning").length,ok=results.filter(x=>x.status==="ok").length;
  res.json({generated_at:new Date().toISOString(),duration_ms:Date.now()-startedAll,status:errors?"error":warnings?"warning":"ok",summary:{total:results.length,ok,warnings,errors},checks:results});
 }catch(err){next(err)}
});

export default router;
