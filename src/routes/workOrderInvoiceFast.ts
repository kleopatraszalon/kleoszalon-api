import {Router} from 'express';
import PDFDocument from 'pdfkit';
import db from '../db';
import {requireAuth,AuthRequest} from '../middleware/auth';

const router=Router();
router.use(requireAuth);
const actor=(r:AuthRequest)=>r.user?.email||String(r.user?.id||'');
const money=(v:any)=>Math.round(Number(v||0)*100)/100;
const digits=(v:any)=>String(v||'').replace(/\D/g,'');
const PAYMENT_MAP:Record<string,string>={cash:'CASH',card:'CARD',transfer:'TRANSFER',voucher:'OTHER',other:'OTHER'};

async function tableExists(name:string){const q=await db.query(`SELECT to_regclass($1) IS NOT NULL ok`,[`public.${name}`]);return Boolean(q.rows[0]?.ok)}
async function activeNavConfig(c:any,locationId:any){return (await c.query(`SELECT * FROM nav_online_invoice_settings WHERE active=true AND ($1::text='' OR location_id::text=$1 OR location_id IS NULL) ORDER BY CASE WHEN location_id::text=$1 THEN 0 ELSE 1 END LIMIT 1`,[String(locationId||'')])).rows[0]||null}
async function workOrder(c:any,id:string,lock=false){return (await c.query(`SELECT w.*,to_jsonb(w) _json FROM work_orders w WHERE w.id::text=$1${lock?' FOR UPDATE':''}`,[id])).rows[0]||null}
async function latestInvoice(c:any,id:string){return (await c.query(`SELECT * FROM finance_invoices WHERE work_order_id::text=$1 AND direction='outgoing' ORDER BY created_at DESC LIMIT 1`,[id])).rows[0]||null}
async function nextOfficialNumber(c:any){
  const fn=(await c.query(`SELECT to_regprocedure('next_internal_invoice_number()') IS NOT NULL ok`)).rows[0]?.ok;
  if(!fn)throw new Error('A hivatalos számlaszám-generátor nem érhető el.');
  return String((await c.query(`SELECT next_internal_invoice_number() invoice_no`)).rows[0]?.invoice_no||'');
}
function draftNumber(workOrderId:string){return `KLEO-TERV-${new Date().getFullYear()}-${workOrderId.replace(/-/g,'').slice(0,12).toUpperCase()}`}
function billing(wo:any){
  const j=wo?._json||wo||{};
  const tax=digits(j.billing_tax_number);
  const vatStatus=String(j.billing_vat_status|| (tax?'DOMESTIC':'PRIVATE_PERSON')).toUpperCase();
  return{
    name:String(j.billing_name||j.client_name||'').trim(),
    vat_status:vatStatus,
    tax_number:tax,
    country_code:String(j.billing_country_code||'HU').trim().toUpperCase(),
    postal_code:String(j.billing_postal_code||'').trim(),
    city:String(j.billing_city||'').trim(),
    address:String(j.billing_address||'').trim()
  }
}
function billingErrors(b:any){
  const errors:string[]=[];
  if(!['PRIVATE_PERSON','DOMESTIC'].includes(b.vat_status))errors.push('Jelenleg csak magyar magánszemély vagy belföldi adóalany számlázása élesíthető.');
  if(!b.name)errors.push('A számlázási név hiányzik.');
  if(!b.country_code)errors.push('A számlázási országkód hiányzik.');
  if(!b.postal_code)errors.push('A számlázási irányítószám hiányzik.');
  if(!b.city)errors.push('A számlázási város hiányzik.');
  if(!b.address)errors.push('A számlázási cím hiányzik.');
  if(b.vat_status==='DOMESTIC'&&b.tax_number.length!==11)errors.push('Belföldi adóalanynál 11 számjegyű magyar adószám szükséges.');
  if(b.vat_status==='PRIVATE_PERSON'&&b.tax_number)errors.push('Magánszemély vevőhöz ne legyen kitöltve adószám.');
  return errors
}
async function paymentMethod(c:any,workOrderId:string){
  const exists=await tableExists('work_order_payments');
  if(!exists)return'OTHER';
  const row=(await c.query(`SELECT payment_method FROM work_order_payments WHERE work_order_id::text=$1 ORDER BY COALESCE(paid_at,created_at) DESC NULLS LAST LIMIT 1`,[workOrderId]).catch(()=>({rows:[]} as any))).rows[0];
  return PAYMENT_MAP[String(row?.payment_method||'other').toLowerCase()]||'OTHER'
}
async function syncInvoiceFromWorkOrder(c:any,inv:any,wo:any){
  if(inv.issued_at||String(inv.document_kind)==='tax_invoice')throw new Error('A kiállított számla már nem módosítható. Korrekciós bizonylatot kell készíteni.');
  const items=(await c.query(`SELECT * FROM work_order_items WHERE work_order_id::text=$1 ORDER BY created_at,id`,[wo.id])).rows;
  if(!items.length)throw new Error('A munkalapon nincs számlázható tétel.');
  const cfg=await activeNavConfig(c,wo.location_id);
  const vatRate=Number(cfg?.default_vat_rate??0.27);
  if(!Number.isFinite(vatRate)||vatRate<0||vatRate>1)throw new Error('Az alapértelmezett ÁFA-kulcs érvénytelen.');
  const rawGross=money(items.reduce((s:number,x:any)=>s+Number(x.line_total||0),0));
  const orderDiscount=Math.max(0,money((wo._json||wo).discount_amount||0));
  const invoiceGross=money(Math.max(0,rawGross-orderDiscount));
  if(!(invoiceGross>0))throw new Error('A számla végösszegének pozitívnak kell lennie.');
  let allocatedGross=0;
  const lines:any[]=[];
  for(let i=0;i<items.length;i++){
    const x=items[i],qty=Math.max(Number(x.quantity||1),0.0001),raw=money(x.line_total||0);
    const adjustedGross=i===items.length-1?money(invoiceGross-allocatedGross):money(rawGross>0?raw-(orderDiscount*raw/rawGross):raw);
    allocatedGross=money(allocatedGross+adjustedGross);
    const net=money(adjustedGross/(1+vatRate)),vat=money(adjustedGross-net);
    lines.push({line_number:i+1,description:String(x.item_name||'Tétel'),quantity:qty,unit_price_net:Number((net/qty).toFixed(4)),vat_rate:vatRate,net_amount:net,vat_amount:vat,gross_amount:adjustedGross,service_id:x.service_id?String(x.service_id):null,product_id:x.product_id?String(x.product_id):null});
  }
  const totalNet=money(lines.reduce((s,x)=>s+x.net_amount,0)),totalVat=money(invoiceGross-totalNet);
  if(lines.length){const diff=money(totalVat-lines.reduce((s,x)=>s+x.vat_amount,0));lines[lines.length-1].vat_amount=money(lines[lines.length-1].vat_amount+diff);lines[lines.length-1].net_amount=money(lines[lines.length-1].gross_amount-lines[lines.length-1].vat_amount);lines[lines.length-1].unit_price_net=Number((lines[lines.length-1].net_amount/lines[lines.length-1].quantity).toFixed(4))}
  const b=billing(wo),method=await paymentMethod(c,String(wo.id));
  const updated=(await c.query(`UPDATE finance_invoices SET partner_name=$2,customer_name=$2,partner_tax_no=$3,customer_tax_number=$3,customer_vat_status=$4,customer_country_code=$5,customer_postal_code=$6,customer_city=$7,customer_address=$8,net_total=$9,vat_total=$10,gross_total=$11,payment_method=$12,payment_date=CURRENT_DATE,currency='HUF',exchange_rate=1,updated_at=now() WHERE id=$1 RETURNING *`,[inv.id,b.name||'Magánszemély',b.tax_number||null,b.vat_status,b.country_code,b.postal_code||null,b.city||null,b.address||null,money(lines.reduce((s,x)=>s+x.net_amount,0)),money(lines.reduce((s,x)=>s+x.vat_amount,0)),invoiceGross,method])).rows[0];
  await c.query(`DELETE FROM finance_invoice_lines WHERE invoice_id=$1`,[inv.id]);
  for(const l of lines)await c.query(`INSERT INTO finance_invoice_lines(invoice_id,line_number,description,quantity,unit_of_measure,unit_price_net,vat_rate,net_amount,vat_amount,gross_amount,service_id,product_id) VALUES($1,$2,$3,$4,'PIECE',$5,$6,$7,$8,$9,$10,$11)`,[inv.id,l.line_number,l.description,l.quantity,l.unit_price_net,l.vat_rate,l.net_amount,l.vat_amount,l.gross_amount,l.service_id,l.product_id]);
  return{invoice:updated,lines,raw_gross:rawGross,discount:orderDiscount,tip_excluded:money((wo._json||wo).tip_amount||0)}
}
async function ensureDraft(c:any,wo:any,req:AuthRequest){
  let inv=await latestInvoice(c,String(wo.id));
  if(inv)return inv;
  const b=billing(wo);
  inv=(await c.query(`INSERT INTO finance_invoices(location_id,direction,invoice_no,partner_name,customer_name,customer_tax_number,customer_vat_status,customer_country_code,customer_postal_code,customer_city,customer_address,issue_date,performance_date,due_date,currency,net_total,vat_total,gross_total,status,work_order_id,note,created_by,document_kind,invoice_type,nav_status,nav_validation_status) VALUES($1,'outgoing',$2,$3,$3,$4,$5,$6,$7,$8,$9,CURRENT_DATE,CURRENT_DATE,CURRENT_DATE,'HUF',0,0,0,'draft',$10,$11,$12,'internal_draft','NORMAL','not_submitted','not_validated') RETURNING *`,[wo.location_id||null,draftNumber(String(wo.id)),b.name||wo.client_name||'Magánszemély',b.tax_number||null,b.vat_status,b.country_code,b.postal_code||null,b.city||null,b.address||null,String(wo.id),`Számlatervezet a ${wo.work_order_number||wo.id} munkalaphoz.`,actor(req)])).rows[0];
  return inv
}

router.get('/workorders/:id/readiness',async(req,res,next)=>{
 try{
  if(!(await tableExists('finance_invoices')))return res.status(503).json({ok:false,message:'A számlázási séma még nem áll rendelkezésre.'});
  const wo=await workOrder(db,req.params.id);if(!wo)return res.status(404).json({message:'A munkalap nem található.'});
  const inv=await latestInvoice(db,req.params.id),b=billing(wo),cfg=await activeNavConfig(db,wo.location_id);
  const itemCount=Number((await db.query(`SELECT COUNT(*)::int n FROM work_order_items WHERE work_order_id::text=$1`,[req.params.id])).rows[0]?.n||0);
  const errors=billingErrors(b);if(String((wo._json||wo).payment_status||'')!=='paid'&&!(wo._json||wo).fully_paid)errors.push('A munkalap nincs teljesen kifizetve.');if(!itemCount)errors.push('Nincs számlázható munkalaptétel.');if(!cfg)errors.push('Nincs aktív NAV konfiguráció ehhez a szalonhoz.');
  res.json({ok:errors.length===0,errors,warnings:Number((wo._json||wo).tip_amount||0)>0?['A borravaló nem kerül a számlára; csak a szolgáltatás/termék ellenértéke számlázódik.']:[],billing:b,work_order:{id:String(wo.id),number:wo.work_order_number,payment_status:(wo._json||wo).payment_status,fully_paid:Boolean((wo._json||wo).fully_paid),invoice_status:(wo._json||wo).invoice_status,item_count:itemCount},invoice:inv,nav_config:{configured:Boolean(cfg),environment:cfg?.environment||null,supplier_name:cfg?.supplier_name||null,supplier_tax_number:cfg?.supplier_tax_number||null,live_submit_enabled:Boolean(cfg?.live_submit_enabled)}})
 }catch(e){next(e)}
});

router.put('/workorders/:id/billing',async(req:AuthRequest,res,next)=>{
 const c=await db.connect();try{
  const wo=await workOrder(c,req.params.id,true);if(!wo)return res.status(404).json({message:'A munkalap nem található.'});
  const inv=await latestInvoice(c,req.params.id);if(inv&&(inv.issued_at||String(inv.document_kind)==='tax_invoice'))return res.status(409).json({message:'Kiállított számla számlázási adatai nem írhatók át; korrekciós bizonylat szükséges.'});
  const vatStatus=String(req.body?.vat_status||'PRIVATE_PERSON').toUpperCase(),tax=digits(req.body?.tax_number),name=String(req.body?.name||'').trim(),country=String(req.body?.country_code||'HU').trim().toUpperCase(),postal=String(req.body?.postal_code||'').trim(),city=String(req.body?.city||'').trim(),address=String(req.body?.address||'').trim();
  const b={name,vat_status:vatStatus,tax_number:tax,country_code:country,postal_code:postal,city,address},errors=billingErrors(b);if(errors.length)return res.status(400).json({message:'A számlázási adatok hiányosak.',errors});
  const updated=(await c.query(`UPDATE work_orders SET billing_name=$2,billing_vat_status=$3,billing_tax_number=$4,billing_country_code=$5,billing_postal_code=$6,billing_city=$7,billing_address=$8 WHERE id::text=$1 RETURNING *`,[req.params.id,name,vatStatus,tax||null,country,postal,city,address])).rows[0];
  res.json({ok:true,billing:billing(updated)})
 }catch(e){next(e)}finally{c.release()}
});

router.get('/workorders/:id',async(req,res,next)=>{
  try{if(!(await tableExists('finance_invoices')))return res.json(null);const q=await db.query(`SELECT i.*,wo.work_order_number,wo.client_email FROM finance_invoices i JOIN work_orders wo ON wo.id::text=i.work_order_id::text WHERE i.work_order_id::text=$1 AND i.direction='outgoing' ORDER BY i.created_at DESC LIMIT 1`,[req.params.id]);return res.json(q.rows[0]||null)}catch(e){next(e)}
});

router.post('/workorders/:id/draft',async(req:AuthRequest,res,next)=>{
  const c=await db.connect();try{
    await c.query('BEGIN');const wo=await workOrder(c,req.params.id,true);if(!wo){await c.query('ROLLBACK');return res.status(404).json({message:'A munkalap nem található.'})}
    const j=wo._json||wo;if(String(j.payment_status||'')!=='paid'&&!j.fully_paid){await c.query('ROLLBACK');return res.status(409).json({message:'Számlatervezet csak teljesen kifizetett munkalaphoz készíthető.'})}
    const inv=await ensureDraft(c,wo,req);if(inv.issued_at||String(inv.document_kind)==='tax_invoice'){await c.query('COMMIT');return res.json(inv)}
    const synced=await syncInvoiceFromWorkOrder(c,inv,wo);await c.query(`UPDATE work_orders SET invoice_status='requested' WHERE id=$1`,[wo.id]);await c.query('COMMIT');return res.json({...synced.invoice,invoice_lines:synced.lines,tip_excluded:synced.tip_excluded})
  }catch(e:any){await c.query('ROLLBACK').catch(()=>undefined);console.error('[workorder-invoice-fast] draft failed',e?.code||'',e?.message||e);next(e)}finally{c.release()}
});

router.post('/workorders/:id/issue',async(req:AuthRequest,res,next)=>{
 const c=await db.connect();try{
  await c.query('BEGIN');const wo=await workOrder(c,req.params.id,true);if(!wo){await c.query('ROLLBACK');return res.status(404).json({message:'A munkalap nem található.'})}
  const j=wo._json||wo;if(String(j.payment_status||'')!=='paid'&&!j.fully_paid){await c.query('ROLLBACK');return res.status(409).json({message:'Számla csak teljesen kifizetett munkalapból állítható ki.'})}
  const b=billing(wo),errors=billingErrors(b);if(errors.length){await c.query('ROLLBACK');return res.status(409).json({message:'A számla kiállításához hiányosak a számlázási adatok.',errors})}
  const cfg=await activeNavConfig(c,wo.location_id);if(!cfg){await c.query('ROLLBACK');return res.status(409).json({message:'A számla kiállításához nincs aktív NAV/kibocsátói konfiguráció.'})}
  let inv=await ensureDraft(c,wo,req);if(inv.issued_at||String(inv.document_kind)==='tax_invoice'){await c.query('COMMIT');return res.json({...inv,idempotent:true})}
  const synced=await syncInvoiceFromWorkOrder(c,inv,wo);const officialNo=await nextOfficialNumber(c);
  inv=(await c.query(`UPDATE finance_invoices SET invoice_no=$2,document_kind='tax_invoice',status='paid',issued_at=now(),issued_by=$3,issue_date=CURRENT_DATE,performance_date=COALESCE(performance_date,CURRENT_DATE),due_date=CURRENT_DATE,note=$4,updated_at=now() WHERE id=$1 RETURNING *`,[inv.id,officialNo,actor(req),`Hivatalos számla a ${wo.work_order_number||wo.id} munkalaphoz; NAV adatszolgáltatás állapota külön követendő.`])).rows[0];
  await c.query(`UPDATE work_orders SET invoice_status='issued' WHERE id=$1`,[wo.id]);await c.query('COMMIT');res.status(201).json({...inv,invoice_lines:synced.lines,nav_next_step:'validate_prepare_submit'})
 }catch(e:any){await c.query('ROLLBACK').catch(()=>undefined);console.error('[workorder-invoice-fast] issue failed',e?.code||'',e?.message||e);if(e?.code==='23505')return res.status(409).json({message:'A számlaszám ütközik egy meglévő bizonylattal. A kiállítás nem történt meg.'});next(e)}finally{c.release()}
});

router.get('/invoices/:id/pdf',async(req,res,next)=>{
  try{
    const q=await db.query(`SELECT i.*,wo.work_order_number,wo.client_name,wo.client_email,wo.client_phone FROM finance_invoices i JOIN work_orders wo ON wo.id::text=i.work_order_id::text WHERE i.id::text=$1`,[req.params.id]);
    const inv=q.rows[0];if(!inv)return res.status(404).json({message:'A számla nem található.'});
    const items=(await db.query(`SELECT line_number,description,quantity,unit_price_net,vat_rate,net_amount,vat_amount,gross_amount FROM finance_invoice_lines WHERE invoice_id=$1 ORDER BY line_number`,[inv.id])).rows;
    const cfg=await activeNavConfig(db,inv.location_id),official=String(inv.document_kind)==='tax_invoice'&&Boolean(inv.issued_at);
    if(official&&!cfg)return res.status(409).json({message:'A hivatalos számla PDF-jéhez hiányzik a kibocsátói NAV konfiguráció.'});
    res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Disposition',`${official?'inline':'attachment'}; filename="${String(inv.invoice_no||'szamlatervezet').replace(/[^A-Za-z0-9._-]/g,'_')}.pdf"`);
    const doc=new PDFDocument({size:'A4',margin:48});doc.pipe(res);
    doc.fontSize(9).text('KLEOPÁTRA SZÉPSÉGSZALONOK',{align:'center'});doc.moveDown(.3).fontSize(20).text(official?'SZÁMLA':'SZÁMLATERVEZET',{align:'center'});if(!official)doc.fontSize(9).fillColor('#a00000').text('Belső tervezet – nem kiállított adóügyi számla.',{align:'center'}).fillColor('black');doc.moveDown();
    if(cfg){doc.fontSize(11).text('Eladó',{underline:true});doc.fontSize(9).text(cfg.supplier_name||'');doc.text(`Adószám: ${cfg.supplier_tax_number||''}`);doc.text(`${cfg.supplier_postal_code||''} ${cfg.supplier_city||''}, ${cfg.supplier_address||''}`);doc.moveDown(.6)}
    doc.fontSize(11).text(`Számlaszám: ${inv.invoice_no}`);doc.text(`Munkalap: ${inv.work_order_number}`);doc.text(`Kiállítás: ${String(inv.issue_date).slice(0,10)}`);doc.text(`Teljesítés: ${String(inv.performance_date).slice(0,10)}`);doc.text(`Fizetési mód: ${inv.payment_method||'OTHER'}`);doc.moveDown();doc.fontSize(12).text('Vevő',{underline:true});doc.fontSize(10).text(inv.customer_name||inv.partner_name||'');if(inv.customer_tax_number)doc.text(`Adószám: ${inv.customer_tax_number}`);doc.text(`${inv.customer_postal_code||''} ${inv.customer_city||''}, ${inv.customer_address||''}`);doc.moveDown();doc.fontSize(12).text('Tételek',{underline:true});
    items.forEach((x:any)=>doc.fontSize(8.5).text(`${x.line_number}. ${x.description} · ${Number(x.quantity)} × ${money(x.unit_price_net).toLocaleString('hu-HU')} Ft nettó · ÁFA ${Number(x.vat_rate||0)*100}% · nettó ${money(x.net_amount).toLocaleString('hu-HU')} Ft · ÁFA ${money(x.vat_amount).toLocaleString('hu-HU')} Ft · bruttó ${money(x.gross_amount).toLocaleString('hu-HU')} Ft`));
    doc.moveDown();doc.fontSize(11).text(`Nettó: ${money(inv.net_total).toLocaleString('hu-HU')} Ft`,{align:'right'});doc.text(`ÁFA: ${money(inv.vat_total).toLocaleString('hu-HU')} Ft`,{align:'right'});doc.fontSize(14).text(`Bruttó: ${money(inv.gross_total).toLocaleString('hu-HU')} Ft`,{align:'right'});if(official){doc.moveDown();doc.fontSize(8).fillColor('#666').text(`NAV állapot: ${inv.nav_status||'not_submitted'}${inv.nav_transaction_id?` · transactionId: ${inv.nav_transaction_id}`:''}`)}doc.end();
    await db.query(`UPDATE finance_invoices SET pdf_generated_at=now(),updated_at=now() WHERE id::text=$1`,[req.params.id]).catch(()=>undefined);
  }catch(e){next(e)}
});

export default router;
