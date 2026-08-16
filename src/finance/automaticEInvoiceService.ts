import db from '../db';
import {prepareQueuedInvoice} from '../nav/navQueueWorker';

const money=(v:any)=>Math.round(Number(v||0)*100)/100;
const digits=(v:any)=>String(v||'').replace(/\D/g,'');
const PAYMENT_MAP:Record<string,string>={cash:'CASH',card:'CARD',transfer:'TRANSFER',voucher:'OTHER',other:'OTHER'};

async function tableExists(name:string){
  const q=await db.query(`SELECT to_regclass($1) IS NOT NULL ok`,[`public.${name}`]);
  return Boolean(q.rows[0]?.ok);
}
async function activeNavConfig(c:any,locationId:any){
  return (await c.query(`SELECT * FROM nav_online_invoice_settings WHERE active=true AND ($1::text='' OR location_id::text=$1 OR location_id IS NULL) ORDER BY CASE WHEN location_id::text=$1 THEN 0 ELSE 1 END LIMIT 1`,[String(locationId||'')])).rows[0]||null;
}
async function nextOfficialNumber(c:any){
  const fn=(await c.query(`SELECT to_regprocedure('next_internal_invoice_number()') IS NOT NULL ok`)).rows[0]?.ok;
  if(!fn)throw Object.assign(new Error('A hivatalos számlaszám-generátor nem érhető el.'),{code:'INVOICE_NUMBER_GENERATOR_MISSING',status:503});
  const value=String((await c.query(`SELECT next_internal_invoice_number() invoice_no`)).rows[0]?.invoice_no||'');
  if(!value)throw Object.assign(new Error('A számlaszám-generátor nem adott vissza számlaszámot.'),{code:'INVOICE_NUMBER_EMPTY',status:503});
  return value;
}
function finalized(wo:any){
  const j=wo?._json||wo||{};
  return Boolean(j.locked_at||j.archived_at||j.completed_at||j.closed_at)||String(j.status||wo?.status||'')==='completed'||String(j.document_status||'')==='completed';
}
function billing(wo:any){
  const j=wo?._json||wo||{};
  const tax=digits(j.billing_tax_number);
  return{
    name:String(j.billing_name||j.client_name||'').trim(),
    vat_status:String(j.billing_vat_status||(tax?'DOMESTIC':'PRIVATE_PERSON')).toUpperCase(),
    tax_number:tax,
    country_code:String(j.billing_country_code||'HU').trim().toUpperCase(),
    postal_code:String(j.billing_postal_code||'').trim(),
    city:String(j.billing_city||'').trim(),
    address:String(j.billing_address||'').trim(),
    email:String(j.client_email||j.billing_email||'').trim(),
  };
}
function billingErrors(b:any){
  const errors:string[]=[];
  if(!['PRIVATE_PERSON','DOMESTIC'].includes(b.vat_status))errors.push('Jelenleg csak magyar magánszemély vagy belföldi adóalany számlázható automatikusan.');
  if(!b.name)errors.push('A számlázási név hiányzik.');
  if(!b.country_code)errors.push('A számlázási országkód hiányzik.');
  if(!b.postal_code)errors.push('A számlázási irányítószám hiányzik.');
  if(!b.city)errors.push('A számlázási város hiányzik.');
  if(!b.address)errors.push('A számlázási cím hiányzik.');
  if(b.vat_status==='DOMESTIC'&&b.tax_number.length!==11)errors.push('Belföldi adóalanynál 11 számjegyű magyar adószám szükséges.');
  if(b.vat_status==='PRIVATE_PERSON'&&b.tax_number)errors.push('Magánszemély vevőhöz ne legyen kitöltve adószám.');
  return errors;
}

export async function validateWorkOrderEInvoicePreconditions(workOrderId:string){
  if(!(await tableExists('finance_invoices'))||!(await tableExists('finance_invoice_lines')))return ['A számlázási adatbázisséma nem érhető el.'];
  const wo=(await db.query(`SELECT w.*,to_jsonb(w) _json FROM work_orders w WHERE w.id::text=$1 LIMIT 1`,[workOrderId])).rows[0];
  if(!wo)return ['A munkalap nem található.'];
  const errors=billingErrors(billing(wo));
  const itemCount=Number((await db.query(`SELECT COUNT(*)::int n FROM work_order_items WHERE work_order_id::text=$1`,[workOrderId])).rows[0]?.n||0);
  if(!itemCount)errors.push('A munkalapon nincs számlázható tétel.');
  const cfg=await activeNavConfig(db,wo.location_id);
  if(!cfg)errors.push('Ehhez a szalonhoz nincs aktív NAV/kibocsátói konfiguráció.');
  return errors;
}

export async function issueWorkOrderEInvoice(workOrderId:string,createdBy='automatic-e-invoice'){
  const c=await db.connect();
  let invoice:any=null;
  try{
    await c.query('BEGIN');
    const wo=(await c.query(`SELECT w.*,to_jsonb(w) _json FROM work_orders w WHERE w.id::text=$1 FOR UPDATE`,[workOrderId])).rows[0];
    if(!wo)throw Object.assign(new Error('A munkalap nem található.'),{code:'WORKORDER_NOT_FOUND',status:404});
    if(!finalized(wo))throw Object.assign(new Error('E-számla csak véglegesített munkalapból állítható ki.'),{code:'WORKORDER_NOT_FINALIZED',status:409});
    const j=wo._json||wo;
    if(String(j.payment_status||'')!=='paid'&&!j.fully_paid)throw Object.assign(new Error('E-számla csak teljesen kifizetett munkalapból állítható ki.'),{code:'WORKORDER_NOT_PAID',status:409});
    const b=billing(wo),errors=billingErrors(b);
    if(errors.length)throw Object.assign(new Error('Az automatikus e-számlához hiányosak a számlázási adatok.'),{code:'BILLING_INCOMPLETE',status:409,errors});
    const cfg=await activeNavConfig(c,wo.location_id);
    if(!cfg)throw Object.assign(new Error('Nincs aktív NAV/kibocsátói konfiguráció ehhez a szalonhoz.'),{code:'NAV_CONFIG_MISSING',status:409});

    const existing=(await c.query(`SELECT * FROM finance_invoices WHERE work_order_id::text=$1 AND direction='outgoing' ORDER BY created_at DESC LIMIT 1`,[workOrderId])).rows[0];
    if(existing?.issued_at&&String(existing.document_kind)==='tax_invoice'){
      invoice=existing;
      await c.query(`UPDATE work_orders SET invoice_status='issued' WHERE id::text=$1`,[workOrderId]).catch(()=>undefined);
      await c.query('COMMIT');
    }else{
      const items=(await c.query(`SELECT * FROM work_order_items WHERE work_order_id::text=$1 ORDER BY created_at,id`,[workOrderId])).rows;
      if(!items.length)throw Object.assign(new Error('A munkalapon nincs számlázható tétel.'),{code:'NO_INVOICE_ITEMS',status:409});
      const defaultVatRate=Number(cfg?.default_vat_rate??0.27);
      const rawGross=money(items.reduce((s:number,x:any)=>s+Number(x.line_total||0),0));
      const discount=Math.max(0,money(j.discount_amount||0));
      const invoiceGross=money(Math.max(0,rawGross-discount));
      if(!(invoiceGross>0))throw Object.assign(new Error('A számla végösszegének pozitívnak kell lennie.'),{code:'INVALID_INVOICE_TOTAL',status:409});
      let allocated=0;const lines:any[]=[];
      for(let i=0;i<items.length;i++){
        const x=items[i],qty=Math.max(Number(x.quantity||1),0.0001),raw=money(x.line_total||0),rate=Number(x.vat_rate??defaultVatRate);
        if(!Number.isFinite(rate)||rate<0||rate>1)throw Object.assign(new Error(`${i+1}. tétel ÁFA-kulcsa érvénytelen.`),{code:'INVALID_VAT_RATE',status:409});
        const gross=i===items.length-1?money(invoiceGross-allocated):money(rawGross>0?raw-(discount*raw/rawGross):raw);allocated=money(allocated+gross);
        const net=money(gross/(1+rate)),vat=money(gross-net);
        lines.push({line_number:i+1,description:String(x.item_name||'Tétel'),quantity:qty,unit_price_net:Number((net/qty).toFixed(4)),vat_rate:rate,net_amount:net,vat_amount:vat,gross_amount:gross,service_id:x.service_id?String(x.service_id):null,product_id:x.product_id?String(x.product_id):null});
      }
      const totalNet=money(lines.reduce((s,x)=>s+x.net_amount,0)),totalVat=money(invoiceGross-totalNet);
      const diff=money(totalVat-lines.reduce((s,x)=>s+x.vat_amount,0));if(lines.length&&diff){const l=lines[lines.length-1];l.vat_amount=money(l.vat_amount+diff);l.net_amount=money(l.gross_amount-l.vat_amount);l.unit_price_net=Number((l.net_amount/l.quantity).toFixed(4));}
      const pay=(await c.query(`SELECT payment_method FROM work_order_payments WHERE work_order_id::text=$1 ORDER BY COALESCE(paid_at,created_at) DESC NULLS LAST LIMIT 1`,[workOrderId]).catch(()=>({rows:[]} as any))).rows[0];
      const method=PAYMENT_MAP[String(pay?.payment_method||'other').toLowerCase()]||'OTHER';
      const invoiceNo=await nextOfficialNumber(c);
      if(existing){
        invoice=(await c.query(`UPDATE finance_invoices SET invoice_no=$2,partner_name=$3,customer_name=$3,partner_tax_no=$4,customer_tax_number=$4,customer_vat_status=$5,customer_country_code=$6,customer_postal_code=$7,customer_city=$8,customer_address=$9,issue_date=CURRENT_DATE,performance_date=CURRENT_DATE,due_date=CURRENT_DATE,currency='HUF',net_total=$10,vat_total=$11,gross_total=$12,status='paid',document_kind='tax_invoice',invoice_type='NORMAL',nav_status='not_submitted',nav_validation_status='not_validated',payment_method=$13,payment_date=CURRENT_DATE,issued_at=now(),issued_by=$14,updated_at=now() WHERE id=$1 RETURNING *`,[existing.id,invoiceNo,b.name,b.tax_number||null,b.vat_status,b.country_code,b.postal_code,b.city,b.address,totalNet,totalVat,invoiceGross,method,createdBy])).rows[0];
        await c.query(`DELETE FROM finance_invoice_lines WHERE invoice_id=$1`,[existing.id]);
      }else{
        invoice=(await c.query(`INSERT INTO finance_invoices(location_id,direction,invoice_no,partner_name,customer_name,partner_tax_no,customer_tax_number,customer_vat_status,customer_country_code,customer_postal_code,customer_city,customer_address,issue_date,performance_date,due_date,currency,net_total,vat_total,gross_total,status,work_order_id,note,created_by,document_kind,invoice_type,nav_status,nav_validation_status,payment_method,payment_date,issued_at,issued_by) VALUES($1,'outgoing',$2,$3,$3,$4,$4,$5,$6,$7,$8,$9,CURRENT_DATE,CURRENT_DATE,CURRENT_DATE,'HUF',$10,$11,$12,'paid',$13,$14,$15,'tax_invoice','NORMAL','not_submitted','not_validated',$16,CURRENT_DATE,now(),$15) RETURNING *`,[wo.location_id||null,invoiceNo,b.name,b.tax_number||null,b.vat_status,b.country_code,b.postal_code,b.city,b.address,totalNet,totalVat,invoiceGross,wo.id,`Automatikusan kiállított e-számla a ${wo.work_order_number||wo.id} munkalaphoz.`,createdBy,method])).rows[0];
      }
      for(const l of lines)await c.query(`INSERT INTO finance_invoice_lines(invoice_id,line_number,description,quantity,unit_of_measure,unit_price_net,vat_rate,net_amount,vat_amount,gross_amount,service_id,product_id) VALUES($1,$2,$3,$4,'PIECE',$5,$6,$7,$8,$9,$10,$11)`,[invoice.id,l.line_number,l.description,l.quantity,l.unit_price_net,l.vat_rate,l.net_amount,l.vat_amount,l.gross_amount,l.service_id,l.product_id]);
      await c.query(`UPDATE work_orders SET invoice_status='issued' WHERE id::text=$1`,[workOrderId]);
      await c.query('COMMIT');
    }
  }catch(e){await c.query('ROLLBACK').catch(()=>undefined);throw e}finally{c.release()}

  let nav:any=null,nav_error:string|null=null;
  try{nav=await prepareQueuedInvoice(String(invoice.id),createdBy)}catch(e:any){nav_error=String(e?.message||e);console.error('[automatic-e-invoice] NAV queue prepare failed',invoice?.id,e?.code||'',nav_error)}
  return{invoice,nav,nav_error,e_invoice:true};
}
