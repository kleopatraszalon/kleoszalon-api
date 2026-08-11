import {Router} from 'express';
import db from '../db';
import {requireAuth,AuthRequest} from '../middleware/auth';

const router=Router();
router.use(requireAuth);
const actor=(r:AuthRequest)=>r.user?.email||String(r.user?.id||'');
const money=(v:any)=>Math.round(Number(v||0)*100)/100;
const add=(arr:any[],code:string,message:string,field?:string)=>arr.push({code,message,field:field||null});

async function invoiceBundle(id:string){
  const inv=(await db.query(`SELECT * FROM finance_invoices WHERE id=$1::uuid`,[id])).rows[0];
  if(!inv)return null;
  const lines=(await db.query(`SELECT * FROM finance_invoice_lines WHERE invoice_id=$1::uuid ORDER BY line_number`,[id])).rows;
  return {inv,lines};
}

function validate(inv:any,lines:any[]){
  const errors:any[]=[],warnings:any[]=[];
  const invoiceType=String(inv.invoice_type||'NORMAL').toUpperCase();
  if(!String(inv.invoice_no||'').trim())add(errors,'INVOICE_NO_MISSING','A számlaszám hiányzik.','invoice_no');
  if(!String(inv.partner_name||inv.customer_name||'').trim())add(errors,'CUSTOMER_NAME_MISSING','A vevő neve hiányzik.','partner_name');
  if(!String(inv.issue_date||'').trim())add(errors,'ISSUE_DATE_MISSING','A kiállítás dátuma hiányzik.','issue_date');
  if(!String(inv.performance_date||'').trim())add(errors,'PERFORMANCE_DATE_MISSING','A teljesítés dátuma hiányzik.','performance_date');
  if(!String(inv.currency||'').trim())add(errors,'CURRENCY_MISSING','A pénznem hiányzik.','currency');
  if(!lines.length)add(errors,'LINES_MISSING','A számlának nincs tétele.');
  let net=0,vat=0,gross=0;
  for(const [i,l] of lines.entries()){
    if(!String(l.description||'').trim())add(errors,'LINE_DESCRIPTION_MISSING',`${i+1}. tétel megnevezése hiányzik.`);
    if(!(Number(l.quantity)>0))add(errors,'LINE_QUANTITY_INVALID',`${i+1}. tétel mennyisége nem pozitív.`);
    if(!Number.isFinite(Number(l.net_amount))||!Number.isFinite(Number(l.vat_amount))||!Number.isFinite(Number(l.gross_amount)))add(errors,'LINE_AMOUNT_INVALID',`${i+1}. tétel összege hibás.`);
    if(Math.abs((Number(l.net_amount||0)+Number(l.vat_amount||0))-Number(l.gross_amount||0))>.02)add(errors,'LINE_TOTAL_MISMATCH',`${i+1}. tételnél nettó + ÁFA nem egyezik a bruttóval.`);
    const rate=Number(l.vat_rate);
    if(!(rate>=0&&rate<=1))add(errors,'VAT_RATE_INVALID',`${i+1}. tétel ÁFA kulcsa hibás.`);
    if(['MODIFY','STORNO'].includes(invoiceType)&&!(Number(l.nav_line_number_reference)>0))add(errors,'NAV_LINE_REFERENCE_MISSING',`${i+1}. korrekciós tétel NAV sorhivatkozása hiányzik.`,'nav_line_number_reference');
    net+=Number(l.net_amount||0);vat+=Number(l.vat_amount||0);gross+=Number(l.gross_amount||0);
  }
  if(Math.abs(money(net)-money(inv.net_total))>.02)add(errors,'NET_TOTAL_MISMATCH','A számla nettó végösszege nem egyezik a tételekkel.','net_total');
  if(Math.abs(money(vat)-money(inv.vat_total))>.02)add(errors,'VAT_TOTAL_MISMATCH','A számla ÁFA végösszege nem egyezik a tételekkel.','vat_total');
  if(Math.abs(money(gross)-money(inv.gross_total))>.02)add(errors,'GROSS_TOTAL_MISMATCH','A számla bruttó végösszege nem egyezik a tételekkel.','gross_total');
  const tax=String(inv.customer_tax_number||inv.partner_tax_no||'').replace(/\D/g,'');
  if(tax&&tax.length<8)add(errors,'CUSTOMER_TAX_NUMBER_INVALID','A vevő adószáma túl rövid.','customer_tax_number');
  if(!tax&&String(inv.customer_vat_status||'').toUpperCase()==='DOMESTIC')add(errors,'DOMESTIC_TAX_NUMBER_MISSING','Belföldi adóalany vevőhöz adószám szükséges.','customer_tax_number');
  if(!String(inv.customer_postal_code||'').trim()&&!tax)add(warnings,'PRIVATE_ADDRESS_INCOMPLETE','Magánszemély vevő címe nincs teljesen kitöltve.');
  if(['MODIFY','STORNO'].includes(invoiceType)){
    if(!inv.original_invoice_id)add(errors,'ORIGINAL_INVOICE_MISSING','Módosító/sztornó számlához eredeti számla szükséges.','original_invoice_id');
    if(!String(inv.original_invoice_number||'').trim())add(errors,'ORIGINAL_INVOICE_NUMBER_MISSING','Módosító/sztornó számlához eredeti számlaszám szükséges.','original_invoice_number');
    if(!(Number(inv.modification_index)>0))add(errors,'MODIFICATION_INDEX_INVALID','Módosító/sztornó számlához pozitív módosítási index szükséges.','modification_index');
  }
  return {errors,warnings,status:errors.length?'failed':warnings.length?'warning':'passed'};
}

router.get('/dashboard',async(req:AuthRequest,res,next)=>{try{
  const locationId=String(req.query.location_id||req.user?.location_id||'').trim();
  const stats=await db.query(`SELECT COUNT(*)::int total,COUNT(*) FILTER(WHERE nav_status='done')::int done,COUNT(*) FILTER(WHERE nav_status IN ('error','aborted'))::int failed,COUNT(*) FILTER(WHERE nav_status IN ('submitted','processing','prepared'))::int pending,COUNT(*) FILTER(WHERE nav_validation_status='failed')::int invalid FROM finance_invoices WHERE ($1::text='' OR location_id::text=$1 OR location_id IS NULL)`,[locationId]);
  const invoices=await db.query(`SELECT id,invoice_no,partner_name,gross_total,issue_date,status,nav_status,nav_validation_status,invoice_type,original_invoice_number,nav_transaction_id FROM finance_invoices WHERE ($1::text='' OR location_id::text=$1 OR location_id IS NULL) ORDER BY created_at DESC LIMIT 50`,[locationId]);
  const queue=await db.query(`SELECT q.*,i.invoice_no,i.partner_name FROM nav_invoice_queue q JOIN finance_invoices i ON i.id=q.invoice_id WHERE ($1::text='' OR i.location_id::text=$1 OR i.location_id IS NULL) ORDER BY q.created_at DESC LIMIT 50`,[locationId]);
  res.json({stats:stats.rows[0],invoices:invoices.rows,queue:queue.rows});
}catch(e){next(e)}});

router.post('/invoices/:id/validate',async(req:AuthRequest,res,next)=>{try{
  const b=await invoiceBundle(req.params.id);if(!b)return res.status(404).json({message:'A számla nem található.'});
  const result=validate(b.inv,b.lines);
  const run=(await db.query(`INSERT INTO nav_invoice_validation_runs(invoice_id,status,errors,warnings,snapshot,created_by) VALUES($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6) RETURNING *`,[b.inv.id,result.status,JSON.stringify(result.errors),JSON.stringify(result.warnings),JSON.stringify({invoice:b.inv,lines:b.lines}),actor(req)])).rows[0];
  await db.query(`UPDATE finance_invoices SET nav_validation_status=$2,nav_validated_at=now(),nav_validation_errors=$3::jsonb WHERE id=$1`,[b.inv.id,result.status,JSON.stringify(result.errors)]);
  res.json({run,...result});
}catch(e){next(e)}});

router.post('/invoices/:id/correction-draft',async(req:AuthRequest,res)=>{
  const c=await db.connect();
  try{
    await c.query('BEGIN');
    const mode=String(req.body?.mode||'MODIFY').toUpperCase();
    if(!['MODIFY','STORNO'].includes(mode)){
      await c.query('ROLLBACK');
      return res.status(400).json({message:'A mód MODIFY vagy STORNO lehet.'});
    }
    const source=(await c.query(`SELECT * FROM finance_invoices WHERE id=$1::uuid FOR UPDATE`,[req.params.id])).rows[0];
    if(!source)throw new Error('A kiinduló számla nem található.');
    const rootId=source.original_invoice_id||source.id;
    const root=source.original_invoice_id?(await c.query(`SELECT * FROM finance_invoices WHERE id=$1::uuid FOR UPDATE`,[rootId])).rows[0]:source;
    if(!root)throw new Error('Az eredeti számla nem található.');
    if(!['done','warning','submitted'].includes(String(root.nav_status||'')))throw new Error('Csak NAV felé már beküldött eredeti számlából készíthető módosító/sztornó bizonylat.');
    const idx=Number((await c.query(`SELECT COALESCE(MAX(modification_index),0)+1 n FROM finance_invoices WHERE original_invoice_id=$1::uuid`,[root.id])).rows[0]?.n||1);
    const no=`${String(root.invoice_no||'KLEO-SZ')}-${mode==='STORNO'?'S':'M'}${idx}`;
    const negative=mode==='STORNO'?-1:1;
    const created=(await c.query(`INSERT INTO finance_invoices(location_id,direction,invoice_no,partner_name,partner_tax_no,customer_tax_number,customer_address,issue_date,performance_date,due_date,currency,net_total,vat_total,gross_total,status,work_order_id,note,created_by,invoice_type,original_invoice_id,original_invoice_number,modification_index,correction_reason,nav_status,nav_validation_status) VALUES($1,$2,$3,$4,$5,$6,$7,CURRENT_DATE,CURRENT_DATE,CURRENT_DATE,$8,$9,$10,$11,'draft',$12,$13,$14,$15,$16,$17,$18,$19,'not_submitted','not_validated') RETURNING *`,[source.location_id,source.direction,no,source.partner_name,source.partner_tax_no,source.customer_tax_number,source.customer_address,source.currency,money(Number(source.net_total||0)*negative),money(Number(source.vat_total||0)*negative),money(Number(source.gross_total||0)*negative),source.work_order_id,req.body?.reason||`${mode} bizonylat`,actor(req),mode,root.id,root.invoice_no,idx,req.body?.reason||null])).rows[0];
    const lines=(await c.query(`SELECT * FROM finance_invoice_lines WHERE invoice_id=$1 ORDER BY line_number`,[source.id])).rows;
    const usedRefs=Number((await c.query(`SELECT
      (SELECT count(*) FROM finance_invoice_lines WHERE invoice_id=$1::uuid)
      +(SELECT count(*) FROM finance_invoice_lines l JOIN finance_invoices i ON i.id=l.invoice_id WHERE i.original_invoice_id=$1::uuid AND i.id<>$2::uuid) AS n`,[root.id,created.id])).rows[0]?.n||0);
    for(let i=0;i<lines.length;i++){
      const l=lines[i];
      const navRef=usedRefs+i+1;
      await c.query(`INSERT INTO finance_invoice_lines(invoice_id,line_number,description,quantity,unit_of_measure,unit_price_net,vat_rate,net_amount,vat_amount,gross_amount,service_id,product_id,nav_line_number_reference) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[created.id,l.line_number,l.description,l.quantity,l.unit_of_measure,mode==='STORNO'?Number(l.unit_price_net||0)*-1:l.unit_price_net,l.vat_rate,mode==='STORNO'?Number(l.net_amount||0)*-1:l.net_amount,mode==='STORNO'?Number(l.vat_amount||0)*-1:l.vat_amount,mode==='STORNO'?Number(l.gross_amount||0)*-1:l.gross_amount,l.service_id,l.product_id,navRef]);
    }
    await c.query('COMMIT');
    res.status(201).json({...created,nav_line_reference_start:lines.length?usedRefs+1:null,nav_line_reference_end:lines.length?usedRefs+lines.length:null});
  }catch(e:any){
    await c.query('ROLLBACK').catch(()=>undefined);
    res.status(409).json({message:e.message});
  }finally{c.release()}
});

router.post('/invoices/:id/queue',async(req:AuthRequest,res,next)=>{try{
  const b=await invoiceBundle(req.params.id);if(!b)return res.status(404).json({message:'A számla nem található.'});
  const v=validate(b.inv,b.lines);if(v.errors.length)return res.status(409).json({message:'A számla NAV validációja hibás.',errors:v.errors});
  const op=String(req.body?.operation||b.inv.invoice_type||'CREATE').toUpperCase();const operation=op==='NORMAL'?'CREATE':op;
  if(!['CREATE','MODIFY','STORNO'].includes(operation))return res.status(400).json({message:'Érvénytelen NAV számlaművelet.'});
  const q=(await db.query(`INSERT INTO nav_invoice_queue(invoice_id,operation,status,created_by) VALUES($1,$2,'queued',$3) ON CONFLICT DO NOTHING RETURNING *`,[b.inv.id,operation,actor(req)])).rows[0];
  await db.query(`UPDATE finance_invoices SET nav_queue_status='queued',nav_queued_at=now(),nav_validation_status=$2,nav_validated_at=now() WHERE id=$1`,[b.inv.id,v.status]);
  res.status(201).json(q||{already_queued:true});
}catch(e){next(e)}});

export default router;
