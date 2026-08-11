import {Router} from 'express';
import PDFDocument from 'pdfkit';
import db from '../db';
import {requireAuth,AuthRequest} from '../middleware/auth';

const router=Router();
router.use(requireAuth);
const actor=(r:AuthRequest)=>r.user?.email||String(r.user?.id||'');
const money=(v:any)=>Math.round(Number(v||0)*100)/100;

async function tableExists(name:string){const q=await db.query(`SELECT to_regclass($1) IS NOT NULL ok`,[`public.${name}`]);return Boolean(q.rows[0]?.ok)}
async function nextNumber(c:any,workOrderId:string){
  const fn=(await c.query(`SELECT to_regprocedure('next_internal_invoice_number()') IS NOT NULL ok`)).rows[0]?.ok;
  if(fn)return String((await c.query(`SELECT next_internal_invoice_number() invoice_no`)).rows[0]?.invoice_no);
  return `KLEO-SZT-${new Date().getFullYear()}-${workOrderId.replace(/-/g,'').slice(0,10).toUpperCase()}`;
}

router.get('/workorders/:id',async(req,res,next)=>{
  try{
    if(!(await tableExists('finance_invoices')))return res.json(null);
    const q=await db.query(`SELECT i.*,wo.work_order_number,wo.client_email FROM finance_invoices i JOIN work_orders wo ON wo.id=i.work_order_id WHERE i.work_order_id::text=$1 AND i.direction='outgoing' ORDER BY i.created_at DESC LIMIT 1`,[req.params.id]);
    return res.json(q.rows[0]||null);
  }catch(e){next(e)}
});

router.post('/workorders/:id/draft',async(req:AuthRequest,res,next)=>{
  const c=await db.connect();
  try{
    if(!(await tableExists('finance_invoices')))return res.status(503).json({message:'A számlatervezet alaptáblája még nem áll rendelkezésre.',code:'WORKORDER_INVOICE_SCHEMA_MISSING'});
    await c.query('BEGIN');
    const existing=(await c.query(`SELECT * FROM finance_invoices WHERE work_order_id::text=$1 AND direction='outgoing' ORDER BY created_at DESC LIMIT 1`,[req.params.id])).rows[0];
    if(existing){await c.query('COMMIT');return res.json(existing)}
    const wo=(await c.query(`SELECT w.*,to_jsonb(w) _json FROM work_orders w WHERE w.id::text=$1`,[req.params.id])).rows[0];
    if(!wo){await c.query('ROLLBACK');return res.status(404).json({message:'A munkalap nem található.'})}
    const j=wo._json||{};
    if(String(j.payment_status||'')!=='paid'&&!j.fully_paid){await c.query('ROLLBACK');return res.status(409).json({message:'Számlatervezet csak teljesen kifizetett munkalaphoz készíthető.'})}
    const gross=money(j.amount_due||j.gross_total||0),vatRate=27,net=money(gross/(1+vatRate/100)),vat=money(gross-net),invoiceNo=await nextNumber(c,req.params.id);
    const inv=(await c.query(`INSERT INTO finance_invoices(location_id,direction,invoice_no,partner_name,issue_date,performance_date,due_date,currency,net_total,vat_total,gross_total,status,work_order_id,note,created_by,document_kind) VALUES($1,'outgoing',$2,$3,CURRENT_DATE,CURRENT_DATE,CURRENT_DATE,'HUF',$4,$5,$6,'draft',$7::uuid,$8,$9,'internal_draft') RETURNING *`,[j.location_id||null,invoiceNo,j.client_name||'Magánszemély',net,vat,gross,req.params.id,`Belső számlatervezet a ${j.work_order_number||wo.id} munkalaphoz.`,actor(req)])).rows[0];
    await c.query('COMMIT');return res.json(inv);
  }catch(e:any){await c.query('ROLLBACK').catch(()=>undefined);console.error('[workorder-invoice-fast] draft failed',e?.code||'',e?.message||e);next(e)}finally{c.release()}
});

router.get('/invoices/:id/pdf',async(req,res,next)=>{
  try{
    const q=await db.query(`SELECT i.*,wo.work_order_number,wo.client_name,wo.client_email,wo.client_phone FROM finance_invoices i JOIN work_orders wo ON wo.id=i.work_order_id WHERE i.id::text=$1`,[req.params.id]);
    const inv=q.rows[0];if(!inv)return res.status(404).json({message:'A számlatervezet nem található.'});
    const items=(await db.query(`SELECT item_name,quantity,unit_price,line_total FROM work_order_items WHERE work_order_id=$1 ORDER BY created_at`,[inv.work_order_id])).rows;
    res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Disposition',`attachment; filename="${String(inv.invoice_no||'szamlatervezet').replace(/[^A-Za-z0-9._-]/g,'_')}.pdf"`);
    const doc=new PDFDocument({size:'A4',margin:48});doc.pipe(res);
    doc.fontSize(9).text('KLEOPÁTRA SZÉPSÉGSZALONOK',{align:'center'});doc.moveDown(.3).fontSize(20).text('SZÁMLATERVEZET',{align:'center'});doc.fontSize(9).fillColor('#a00000').text('Belső bizonylat – nem NAV Online Számla adóügyi számla.',{align:'center'}).fillColor('black');doc.moveDown();
    doc.fontSize(11).text(`Bizonylatszám: ${inv.invoice_no}`);doc.text(`Munkalap: ${inv.work_order_number}`);doc.text(`Kiállítás: ${String(inv.issue_date).slice(0,10)}`);doc.moveDown();doc.fontSize(12).text('Vevő',{underline:true});doc.fontSize(10).text(inv.partner_name||inv.client_name||'Magánszemély');if(inv.client_email)doc.text(inv.client_email);if(inv.client_phone)doc.text(inv.client_phone);doc.moveDown();doc.fontSize(12).text('Tételek',{underline:true});
    items.forEach((x:any)=>doc.fontSize(9).text(`${x.item_name} · ${Number(x.quantity)} × ${money(x.unit_price).toLocaleString('hu-HU')} Ft = ${money(x.line_total).toLocaleString('hu-HU')} Ft`));
    doc.moveDown();doc.fontSize(11).text(`Nettó: ${money(inv.net_total).toLocaleString('hu-HU')} Ft`,{align:'right'});doc.text(`ÁFA: ${money(inv.vat_total).toLocaleString('hu-HU')} Ft`,{align:'right'});doc.fontSize(14).text(`Bruttó: ${money(inv.gross_total).toLocaleString('hu-HU')} Ft`,{align:'right'});doc.end();
    await db.query(`UPDATE finance_invoices SET pdf_generated_at=now(),updated_at=now() WHERE id::text=$1`,[req.params.id]).catch(()=>undefined);
  }catch(e){next(e)}
});

export default router;
