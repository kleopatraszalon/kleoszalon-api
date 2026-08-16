import {Router,Response} from 'express';
import db from '../db';
import {requireTenantRole,TenantAuthRequest} from '../middleware/tenantContext';

const router=Router();
const adminOnly=requireTenantRole('owner','admin');
const money=(v:any)=>Math.round(Number(v||0)*100)/100;
const PERIOD_RE=/^\d{4}-(0[1-9]|1[0-2])$/;

router.get('/receivables',async(req:TenantAuthRequest,res:Response)=>{
  const period=String(req.query.period||'').trim();const params:any[]=[req.tenant!.id];let periodFilter='';
  if(period){if(!PERIOD_RE.test(period))return res.status(400).json({ok:false,error:'A period formátuma YYYY-MM legyen.'});params.push(`${period}-01`);periodFilter=' AND fr.period_start=$2::date';}
  try{
    const rows=await db.query(`SELECT fr.id::text,fr.settlement_id::text,fr.franchise_member_id::text,fr.period_start,fr.period_end,fr.currency,fr.royalty_amount,fr.marketing_fee_amount,fr.net_amount,fr.vat_rate,fr.vat_amount,fr.gross_amount,fr.due_date,fr.status,fr.billing_legal_name,fr.billing_tax_number,fr.billing_email,fr.billing_country_code,fr.billing_postal_code,fr.billing_city,fr.billing_address,fr.finance_invoice_id::text,fr.posted_at,fs.location_id,fn.name network_name,l.name location_name FROM franchise_receivables fr JOIN franchise_settlements fs ON fs.id=fr.settlement_id AND fs.tenant_id=fr.tenant_id JOIN franchise_members fm ON fm.id=fr.franchise_member_id AND fm.tenant_id=fr.tenant_id JOIN franchise_networks fn ON fn.id=fm.franchise_network_id AND fn.tenant_id=fm.tenant_id LEFT JOIN locations l ON l.id::text=fs.location_id WHERE fr.tenant_id=$1::bigint${periodFilter} ORDER BY fr.period_start DESC,fn.name,l.name`,params);
    return res.json({ok:true,rows:rows.rows});
  }catch(error){console.error('[FRANCHISE-ACCOUNTING] receivables',error);return res.status(500).json({ok:false,error:'A franchise követelések nem tölthetők be.'});}
});

router.put('/members/:memberId/billing',adminOnly,async(req:TenantAuthRequest,res:Response)=>{
  const memberId=String(req.params.memberId||'').trim();if(!/^\d+$/.test(memberId))return res.status(400).json({ok:false,error:'Érvénytelen franchise tag azonosító.'});
  const vat=req.body?.billing_vat_rate===null||req.body?.billing_vat_rate===''?null:Number(req.body?.billing_vat_rate);
  if(vat!==null&&(!Number.isFinite(vat)||vat<0||vat>1))return res.status(400).json({ok:false,error:'A billing_vat_rate 0 és 1 közötti decimális érték legyen.'});
  const values=[String(req.body?.billing_legal_name||'').trim()||null,String(req.body?.billing_tax_number||'').trim()||null,String(req.body?.billing_email||'').trim()||null,String(req.body?.billing_country_code||'HU').trim().toUpperCase()||null,String(req.body?.billing_postal_code||'').trim()||null,String(req.body?.billing_city||'').trim()||null,String(req.body?.billing_address||'').trim()||null,vat];
  const client=await db.connect();try{
    await client.query('BEGIN');
    const q=await client.query(`UPDATE franchise_members SET billing_legal_name=$3,billing_tax_number=$4,billing_email=$5,billing_country_code=$6,billing_postal_code=$7,billing_city=$8,billing_address=$9,billing_vat_rate=$10,updated_at=now() WHERE id=$1::bigint AND tenant_id=$2::bigint AND member_type='franchise' RETURNING id::text,location_id,billing_legal_name,billing_tax_number,billing_email,billing_country_code,billing_postal_code,billing_city,billing_address,billing_vat_rate`,[memberId,req.tenant!.id,...values]);
    if(!q.rowCount){await client.query('ROLLBACK');return res.status(404).json({ok:false,error:'A franchise tag nem található ennél a tenantnál.'});}
    await client.query(`UPDATE franchise_receivables SET billing_legal_name=$3,billing_tax_number=$4,billing_email=$5,billing_country_code=$6,billing_postal_code=$7,billing_city=$8,billing_address=$9,vat_rate=$10,vat_amount=CASE WHEN $10::numeric IS NULL THEN NULL ELSE round(net_amount*$10::numeric,2) END,gross_amount=CASE WHEN $10::numeric IS NULL THEN NULL ELSE round(net_amount*(1+$10::numeric),2) END,updated_at=now() WHERE franchise_member_id=$1::bigint AND tenant_id=$2::bigint AND finance_invoice_id IS NULL AND status IN ('posted','paid')`,[memberId,req.tenant!.id,...values]);
    await client.query('COMMIT');return res.json({ok:true,row:q.rows[0]});
  }catch(error){await client.query('ROLLBACK').catch(()=>{});console.error('[FRANCHISE-ACCOUNTING] billing',error);return res.status(500).json({ok:false,error:'A partner számlázási adatai nem menthetők.'});}finally{client.release();}
});

router.post('/settlements/:settlementId/post-receivable',adminOnly,async(req:TenantAuthRequest,res:Response)=>{
  const settlementId=String(req.params.settlementId||'').trim(),dueDate=String(req.body?.due_date||'').trim();
  if(!/^\d+$/.test(settlementId)||!/^\d{4}-\d{2}-\d{2}$/.test(dueDate))return res.status(400).json({ok:false,error:'Érvényes settlement ID és due_date (YYYY-MM-DD) kötelező.'});
  const client=await db.connect();try{
    await client.query('BEGIN');
    const s=await client.query(`SELECT fs.*,fm.billing_legal_name,fm.billing_tax_number,fm.billing_email,fm.billing_country_code,fm.billing_postal_code,fm.billing_city,fm.billing_address,fm.billing_vat_rate FROM franchise_settlements fs JOIN franchise_members fm ON fm.id=fs.franchise_member_id AND fm.tenant_id=fs.tenant_id WHERE fs.id=$1::bigint AND fs.tenant_id=$2::bigint FOR UPDATE`,[settlementId,req.tenant!.id]);
    if(!s.rowCount){await client.query('ROLLBACK');return res.status(404).json({ok:false,error:'Az elszámolás nem található.'});}
    const row=s.rows[0];if(!['approved','paid'].includes(String(row.status))){await client.query('ROLLBACK');return res.status(409).json({ok:false,error:'Követelés csak jóváhagyott vagy már fizetett settlementből készíthető.'});}
    const vatRate=row.billing_vat_rate===null?null:Number(row.billing_vat_rate),net=money(row.total_due),vatAmount=vatRate===null?null:money(net*vatRate),grossAmount=vatRate===null?null:money(net+(vatAmount||0));
    const q=await client.query(`INSERT INTO franchise_receivables(tenant_id,settlement_id,franchise_member_id,period_start,period_end,currency,royalty_amount,marketing_fee_amount,net_amount,vat_rate,vat_amount,gross_amount,due_date,status,billing_legal_name,billing_tax_number,billing_email,billing_country_code,billing_postal_code,billing_city,billing_address,posted_by) VALUES($1::bigint,$2::bigint,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::date,$14,$15,$16,$17,$18,$19,$20,$21,$22) ON CONFLICT(tenant_id,settlement_id) DO NOTHING RETURNING *`,[req.tenant!.id,row.id,row.franchise_member_id,row.period_start,row.period_end,row.currency,row.royalty_amount,row.marketing_fee_amount,net,vatRate,vatAmount,grossAmount,dueDate,row.status==='paid'?'paid':'posted',row.billing_legal_name,row.billing_tax_number,row.billing_email,row.billing_country_code,row.billing_postal_code,row.billing_city,row.billing_address,String(req.user?.id||'')]);
    if(!q.rowCount){const existing=await client.query(`SELECT * FROM franchise_receivables WHERE tenant_id=$1::bigint AND settlement_id=$2::bigint`,[req.tenant!.id,settlementId]);await client.query('COMMIT');return res.json({ok:true,idempotent:true,row:existing.rows[0]});}
    await client.query(`INSERT INTO franchise_receivable_events(tenant_id,receivable_id,event_type,actor_user_id,payload) VALUES($1::bigint,$2,'posted',$3,$4::jsonb)`,[req.tenant!.id,q.rows[0].id,String(req.user?.id||''),JSON.stringify({settlement_id:settlementId,due_date:dueDate})]);
    await client.query('COMMIT');return res.status(201).json({ok:true,row:q.rows[0]});
  }catch(error){await client.query('ROLLBACK').catch(()=>{});console.error('[FRANCHISE-ACCOUNTING] post receivable',error);return res.status(500).json({ok:false,error:'A franchise követelés nem könyvelhető.'});}finally{client.release();}
});

router.post('/receivables/:receivableId/create-invoice-draft',adminOnly,async(req:TenantAuthRequest,res:Response)=>{
  const receivableId=String(req.params.receivableId||'').trim();if(!/^\d+$/.test(receivableId))return res.status(400).json({ok:false,error:'Érvénytelen követelés azonosító.'});
  const client=await db.connect();try{
    await client.query('BEGIN');
    const exists=await client.query(`SELECT to_regclass('public.finance_invoices') invoice_table,to_regclass('public.finance_invoice_lines') line_table`);if(!exists.rows[0]?.invoice_table||!exists.rows[0]?.line_table){await client.query('ROLLBACK');return res.status(503).json({ok:false,error:'A pénzügyi számlázási séma nem érhető el.'});}
    const q=await client.query(`SELECT fr.*,fs.location_id FROM franchise_receivables fr JOIN franchise_settlements fs ON fs.id=fr.settlement_id AND fs.tenant_id=fr.tenant_id WHERE fr.id=$1::bigint AND fr.tenant_id=$2::bigint FOR UPDATE`,[receivableId,req.tenant!.id]);
    if(!q.rowCount){await client.query('ROLLBACK');return res.status(404).json({ok:false,error:'A franchise követelés nem található.'});}const r=q.rows[0];
    if(r.finance_invoice_id){const inv=await client.query(`SELECT * FROM finance_invoices WHERE id=$1`,[r.finance_invoice_id]);await client.query('COMMIT');return res.json({ok:true,idempotent:true,invoice:inv.rows[0]||null});}
    if(r.vat_rate===null){await client.query('ROLLBACK');return res.status(409).json({ok:false,code:'FRANCHISE_VAT_RATE_REQUIRED',error:'Számlatervezethez a franchise partner alkalmazandó ÁFA-kulcsát explicit be kell állítani.'});}
    const missing=['billing_legal_name','billing_country_code','billing_postal_code','billing_city','billing_address'].filter(k=>!String(r[k]||'').trim());if(missing.length){await client.query('ROLLBACK');return res.status(409).json({ok:false,code:'FRANCHISE_BILLING_INCOMPLETE',error:'A franchise partner számlázási adatai hiányosak.',missing});}
    const draftNo=`FR-TERV-${String(r.period_start).slice(0,7).replace('-','')}-${r.id}`;
    const inv=await client.query(`INSERT INTO finance_invoices(location_id,direction,invoice_no,partner_name,customer_name,partner_tax_no,customer_tax_number,customer_vat_status,customer_country_code,customer_postal_code,customer_city,customer_address,issue_date,performance_date,due_date,currency,net_total,vat_total,gross_total,status,note,created_by,document_kind,invoice_type,nav_status,nav_validation_status,franchise_settlement_id,franchise_receivable_id) VALUES($1,'outgoing',$2,$3,$3,$4,$4,CASE WHEN NULLIF($4,'') IS NULL THEN 'PRIVATE_PERSON' ELSE 'DOMESTIC' END,$5,$6,$7,$8,CURRENT_DATE,$9::date,$10::date,$11,$12,$13,$14,'draft',$15,$16,'internal_draft','NORMAL','not_submitted','not_validated',$17::bigint,$18::bigint) RETURNING *`,[r.location_id,draftNo,r.billing_legal_name,r.billing_tax_number||null,r.billing_country_code,r.billing_postal_code,r.billing_city,r.billing_address,r.period_end,r.due_date,r.currency,r.net_amount,r.vat_amount,r.gross_amount,`Franchise royalty és marketing díj settlement ${r.settlement_id}. Belső számlatervezet; kiállítás előtt pénzügyi ellenőrzés szükséges.`,String(req.user?.id||''),r.settlement_id,r.id]);
    const vatRate=Number(r.vat_rate),royaltyNet=money(r.royalty_amount),marketingNet=money(r.marketing_fee_amount);let line=0;
    for(const item of [{description:'Franchise royalty díj',net:royaltyNet},{description:'Franchise marketing hozzájárulás',net:marketingNet}]){if(!(item.net>0))continue;line++;const vat=money(item.net*vatRate);await client.query(`INSERT INTO finance_invoice_lines(invoice_id,line_number,description,quantity,unit_of_measure,unit_price_net,vat_rate,net_amount,vat_amount,gross_amount) VALUES($1,$2,$3,1,'SERVICE',$4,$5,$4,$6,$7)`,[inv.rows[0].id,line,item.description,item.net,vatRate,vat,money(item.net+vat)]);}
    await client.query(`UPDATE franchise_receivables SET finance_invoice_id=$2,status='invoice_draft',updated_at=now() WHERE id=$1`,[r.id,inv.rows[0].id]);
    await client.query(`INSERT INTO franchise_receivable_events(tenant_id,receivable_id,event_type,actor_user_id,payload) VALUES($1::bigint,$2,'invoice_draft_created',$3,$4::jsonb)`,[req.tenant!.id,r.id,String(req.user?.id||''),JSON.stringify({finance_invoice_id:inv.rows[0].id})]);
    await client.query('COMMIT');return res.status(201).json({ok:true,invoice:inv.rows[0]});
  }catch(error){await client.query('ROLLBACK').catch(()=>{});console.error('[FRANCHISE-ACCOUNTING] invoice draft',error);return res.status(500).json({ok:false,error:'A franchise számlatervezet nem készíthető el.'});}finally{client.release();}
});

export default router;
