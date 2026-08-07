import { Router, Request, Response, NextFunction } from "express";
import PDFDocument from "pdfkit";
import pool from "../db";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { sendEmail } from "../mailer";

const router = Router();
router.use(requireAuth);
const asyncRoute = (fn:(req:any,res:Response)=>Promise<any>) => (req:Request,res:Response,next:NextFunction) => fn(req,res).catch(next);
const n=(v:any)=>Number(v||0);
const money=(v:any)=>Math.round(n(v));

async function rules(date:string){
  const y=Number(date.slice(0,4));
  const {rows}=await pool.query(`SELECT code,rate,amount,config FROM payroll_legal_rules WHERE tax_year=$1 AND active AND valid_from<=$2::date AND (valid_to IS NULL OR valid_to>=$2::date) ORDER BY valid_from DESC`,[y,date]);
  return Object.fromEntries(rows.map((x:any)=>[x.code,x]));
}
async function declarations(employeeId:string,date:string){
  const {rows}=await pool.query(`SELECT * FROM employee_tax_declarations WHERE employee_id=$1 AND status='active' AND valid_from<=$2::date AND (valid_to IS NULL OR valid_to>=$2::date)`,[employeeId,date]);
  return rows;
}
async function statutory(employeeId:string,periodTo:string,grossValue:any,otherDeductions=0){
  const r:any=await rules(periodTo);
  const dec=await declarations(employeeId,periodTo);
  const gross=money(grossValue);
  const pitRate=n(r.PIT?.rate||0.15),tbRate=n(r.TB?.rate||0.185),szochoRate=n(r.SZOCHO?.rate||0.13);
  const allowance=money(dec.reduce((s:number,x:any)=>s+n(x.monthly_amount),0));
  const pitBase=Math.max(0,gross-allowance);
  const pit=money(pitBase*pitRate),tb=money(gross*tbRate),other=money(otherDeductions);
  const net=money(gross-pit-tb-other),employerSzocho=money(gross*szochoRate);
  return {gross_pay:gross,tax_base_allowance:allowance,pit_base:pitBase,pit,tb,other_deductions:other,net_pay:net,employer_szocho:employerSzocho,total_employer_cost:gross+employerSzocho,rates:{pit:pitRate,tb:tbRate,szocho:szochoRate},declarations:dec};
}

router.get('/legal-rules',asyncRoute(async(req,res)=>{res.json(await rules(String(req.query.date||new Date().toISOString().slice(0,10))));}));
router.get('/employees/:id/declarations',asyncRoute(async(req,res)=>{res.json(await declarations(req.params.id,String(req.query.date||new Date().toISOString().slice(0,10))));}));
router.post('/employees/:id/declarations',asyncRoute(async(req,res)=>{const b=req.body||{};const {rows}=await pool.query(`INSERT INTO employee_tax_declarations(employee_id,declaration_type,valid_from,valid_to,monthly_amount,data,status,document_ref) VALUES($1,$2,$3,$4,$5,$6::jsonb,COALESCE($7,'active'),$8) RETURNING *`,[req.params.id,b.declaration_type,b.valid_from,b.valid_to||null,b.monthly_amount||null,JSON.stringify(b.data||{}),b.status,b.document_ref||null]);res.status(201).json(rows[0]);}));
router.post('/calculate-statutory',asyncRoute(async(req,res)=>{const b=req.body||{};if(!b.employee_id||!b.period_to)return res.status(400).json({error:'employee_id és period_to kötelező'});const result=await statutory(b.employee_id,b.period_to,b.gross_pay,b.other_deductions);res.json({...result,warning:'A kedvezmények jogosultságát és sorrendjét véglegesítés előtt ellenőrizni kell.'});}));

async function payslipData(runId:string,employeeId:string){
  const {rows}=await pool.query(`SELECT r.id run_id,r.period_from,r.period_to,r.status,r.location_id,i.*,e.full_name,e.email FROM payroll_runs r JOIN payroll_items i ON i.payroll_run_id=r.id JOIN employees e ON e.id=i.employee_id WHERE r.id=$1 AND e.id=$2`,[runId,employeeId]);
  if(!rows[0])throw Object.assign(new Error('Bérjegyzék adat nem található'),{status:404});
  return rows[0];
}
function pdfBuffer(x:any,legal?:any){return new Promise<Buffer>((resolve,reject)=>{const doc=new PDFDocument({size:'A4',margin:45});const chunks:Buffer[]=[];doc.on('data',(c)=>chunks.push(c));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);doc.fontSize(18).text('KLEOPATRA SZEPSEGSZALONOK - BERJEGYZEK',{align:'center'});doc.moveDown().fontSize(11).text(`Munkavallalo: ${x.full_name}`).text(`Idoszak: ${x.period_from} - ${x.period_to}`).text(`Berszamfejtes: ${x.run_id}`);doc.moveDown();const line=(a:string,b:any)=>doc.text(`${a}: ${money(b).toLocaleString('hu-HU')} Ft`);line('Alapber',x.base_pay);line('Tulora',x.overtime_pay);line('Szolgaltatasi jutalek',x.service_commission);line('Termek jutalek',x.product_commission);line('Brutto ber',x.gross_pay);if(legal){line('SZJA',legal.pit);line('TB jarulek',legal.tb);line('Adokedvezmeny alap',legal.tax_base_allowance);line('Netto kifizetendo',legal.net_pay);line('Munkaltatoi szocho',legal.employer_szocho);line('Teljes munkaltatoi koltseg',legal.total_employer_cost);}else{line('Levonasok',x.deductions);line('Netto kifizetendo',x.net_pay);}doc.moveDown().fontSize(9).text('A dokumentum a VIR rendszerben rogzitett es jovahagyott szamfejtes alapjan keszult. A jogszabalyi kedvezmenyek jogosultsagat veglegesites elott ellenorizni kell.');doc.end();});}

router.get('/runs/:runId',asyncRoute(async(req,res)=>{
  const runRes=await pool.query(`SELECT * FROM payroll_runs WHERE id=$1`,[req.params.runId]);
  const run=runRes.rows[0]; if(!run)return res.status(404).json({error:'Számfejtés nem található'});
  const {rows}=await pool.query(`SELECT i.*,e.full_name,e.email,p.document_no,p.email_status,p.emailed_at FROM payroll_items i JOIN employees e ON e.id=i.employee_id LEFT JOIN payroll_payslips p ON p.payroll_run_id=i.payroll_run_id AND p.employee_id=i.employee_id WHERE i.payroll_run_id=$1 ORDER BY e.full_name`,[run.id]);
  const items=[] as any[];
  for(const x of rows){items.push({...x,statutory:await statutory(x.employee_id,run.period_to,x.gross_pay,0)});}
  const jr=await pool.query(`SELECT je.*,COALESCE(json_agg(jl ORDER BY jl.id) FILTER(WHERE jl.id IS NOT NULL),'[]') lines FROM accounting_journal_entries je LEFT JOIN accounting_journal_lines jl ON jl.journal_entry_id=je.id WHERE je.source_type='payroll' AND je.source_id=$1 GROUP BY je.id ORDER BY je.created_at DESC`,[run.id]);
  res.json({run,items,journals:jr.rows});
}));

router.get('/runs/:runId/employees/:employeeId/payslip.pdf',asyncRoute(async(req,res)=>{const x=await payslipData(req.params.runId,req.params.employeeId);if(!['approved','paid'].includes(x.status))return res.status(409).json({error:'PDF csak jóváhagyott vagy kifizetett számfejtésből készíthető.'});const legal=await statutory(x.employee_id,x.period_to,x.gross_pay,0);const pdf=await pdfBuffer(x,legal);res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Disposition',`attachment; filename="berjegyzek-${x.period_to}-${x.employee_id}.pdf"`);res.send(pdf);}));

async function emailPayslip(runId:string,employeeId:string,emailOverride?:string){
  const x=await payslipData(runId,employeeId);if(!['approved','paid'].includes(x.status))throw Object.assign(new Error('Csak jóváhagyott számfejtés küldhető.'),{status:409});
  const to=String(emailOverride||x.email||'').trim();if(!to)throw Object.assign(new Error('A munkavállalónak nincs e-mail címe.'),{status:400});
  const legal=await statutory(x.employee_id,x.period_to,x.gross_pay,0);const pdf=await pdfBuffer(x,legal);const docNo=`PAY-${String(x.period_to).slice(0,7)}-${String(x.employee_id).slice(0,8)}`;
  await pool.query(`INSERT INTO payroll_payslips(payroll_run_id,payroll_item_id,employee_id,period_from,period_to,document_no,payload,generated_at,email_to,email_status) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,now(),$8,'pending') ON CONFLICT(payroll_run_id,employee_id) DO UPDATE SET payload=EXCLUDED.payload,generated_at=now(),email_to=EXCLUDED.email_to,email_status='pending',email_error=NULL,updated_at=now()`,[x.run_id,x.id,x.employee_id,x.period_from,x.period_to,docNo,JSON.stringify({...x,statutory:legal}),to]);
  try{const result=await sendEmail({to,subject:`Bérjegyzék - ${String(x.period_to).slice(0,7)}`,text:`Tisztelt ${x.full_name}!\nMellékelten küldjük a ${x.period_from} - ${x.period_to} időszak bérjegyzékét.\nDokumentum: ${docNo}`,attachments:[{filename:`berjegyzek-${String(x.period_to).slice(0,7)}-${x.employee_id}.pdf`,content:pdf,contentType:'application/pdf'}]});await pool.query(`UPDATE payroll_payslips SET emailed_at=now(),email_status=$3,updated_at=now() WHERE payroll_run_id=$1 AND employee_id=$2`,[x.run_id,x.employee_id,(result as any).sent?'sent':'logged']);return {ok:true,to,employee_id:x.employee_id,document_no:docNo,email:result,pdf_bytes:pdf.length};}catch(e:any){await pool.query(`UPDATE payroll_payslips SET email_status='failed',email_error=$3,updated_at=now() WHERE payroll_run_id=$1 AND employee_id=$2`,[x.run_id,x.employee_id,String(e?.message||e)]);throw e;}
}
router.post('/runs/:runId/employees/:employeeId/email-payslip',asyncRoute(async(req,res)=>{res.json(await emailPayslip(req.params.runId,req.params.employeeId,req.body?.email));}));
router.post('/runs/:runId/email-all-payslips',asyncRoute(async(req,res)=>{const {rows}=await pool.query(`SELECT employee_id FROM payroll_items WHERE payroll_run_id=$1 ORDER BY employee_id`,[req.params.runId]);const results:any[]=[];for(const row of rows){try{results.push(await emailPayslip(req.params.runId,row.employee_id));}catch(e:any){results.push({ok:false,employee_id:row.employee_id,error:String(e?.message||e)});}}res.json({ok:results.every(x=>x.ok),sent:results.filter(x=>x.ok).length,failed:results.filter(x=>!x.ok).length,results});}));

router.post('/runs/:runId/post-to-ledger',asyncRoute(async(req:AuthRequest,res)=>{const {rows}=await pool.query(`SELECT * FROM payroll_runs WHERE id=$1`,[req.params.runId]);const r=rows[0];if(!r)return res.status(404).json({error:'Számfejtés nem található'});if(!['approved','paid'].includes(r.status))return res.status(409).json({error:'Csak jóváhagyott számfejtés könyvelhető.'});const exists=await pool.query(`SELECT * FROM accounting_journal_entries WHERE source_type='payroll' AND source_id=$1 LIMIT 1`,[r.id]);if(exists.rows[0])return res.status(409).json({error:'Ez a számfejtés már fel lett adva a főkönyvbe.',journal:exists.rows[0]});const client=await pool.connect();try{await client.query('BEGIN');const j=await client.query(`INSERT INTO accounting_journal_entries(location_id,entry_date,document_no,source_type,source_id,description,status,created_by) VALUES($1,$2,$3,'payroll',$4,$5,'posted',$6) RETURNING *`,[r.location_id,r.period_to,`PAY-${String(r.period_to).slice(0,7)}`,r.id,`Bérszámfejtés ${r.period_from} - ${r.period_to}`,String(req.user?.id||'')]);const id=j.rows[0].id;const legal:any=await rules(r.period_to);const szocho=money(n(r.gross_total)*n(legal.SZOCHO?.rate||0.13));const taxes=Math.max(0,n(r.gross_total)-n(r.net_total));await client.query(`INSERT INTO accounting_journal_lines(journal_entry_id,account_code,account_name,debit,credit) VALUES($1,'54','Bérköltség',$2,0),($1,'56','Bérjárulékok',$3,0),($1,'471','Jövedelem elszámolási számla',0,$4),($1,'46','Adók és járulékok',0,$5)`,[id,n(r.gross_total),szocho,n(r.net_total),taxes+szocho]);await client.query('COMMIT');res.status(201).json(j.rows[0]);}catch(e){await client.query('ROLLBACK');throw e}finally{client.release();}}));
export default router;
