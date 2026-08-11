import {NextFunction,Request,Response,Router} from 'express';
import crypto from 'crypto';
import db from '../db';
import {AuthRequest} from '../middleware/auth';

const router=Router();
const actor=(req:AuthRequest)=>req.user?.email||String(req.user?.id||'');
const tag=()=>`NAV-UAT-${new Date().toISOString().replace(/\D/g,'').slice(0,14)}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;

async function selectedConfig(locationId:string){
  const q=await db.query(`SELECT id::text,location_id::text,environment,supplier_name,supplier_tax_number FROM nav_online_invoice_settings WHERE active=true AND ($1::text='' OR location_id::text=$1 OR location_id IS NULL) ORDER BY CASE WHEN location_id::text=$1 THEN 0 ELSE 1 END LIMIT 1`,[locationId]);
  return q.rows[0]||null;
}

/**
 * Hard safety gate for automated NAV UAT. Production routes ignore this middleware
 * unless the caller explicitly sets uat_test_only=true. In UAT mode submission is
 * physically blocked unless BOTH the prepared submission and the currently selected
 * NAV configuration point to the test environment.
 */
export async function navTestOnlySubmitGuard(req:Request,res:Response,next:NextFunction){
  try{
    if(req.method!=='POST'||req.body?.uat_test_only!==true||!/^\/submissions\/[^/]+\/submit\/?$/.test(req.path))return next();
    const submissionId=decodeURIComponent(req.path.split('/')[2]||'');
    const q=await db.query(`SELECT s.id,s.environment,i.location_id::text FROM nav_invoice_submissions s JOIN finance_invoices i ON i.id=s.invoice_id WHERE s.id=$1::uuid LIMIT 1`,[submissionId]);
    const s=q.rows[0];
    if(!s)return res.status(404).json({ok:false,message:'NAV UAT: a beküldés nem található.'});
    const c=await selectedConfig(String(s.location_id||''));
    if(String(s.environment)!=='test'||String(c?.environment)!=='test')return res.status(409).json({ok:false,error:'nav_uat_live_blocked',message:'NAV UAT biztonsági blokkolás: automatizált UAT kizárólag a NAV tesztkörnyezetbe küldhet.',submission_environment:s.environment||null,configured_environment:c?.environment||null});
    res.setHeader('X-NAV-UAT-Safety','test-only');
    next();
  }catch(e){next(e)}
}

router.get('/environment',async(req:AuthRequest,res,next)=>{
  try{
    const requested=String(req.query.location_id||req.user?.location_id||'').trim();
    const c=await selectedConfig(requested);
    if(!c)return res.status(404).json({ok:false,message:'Nincs aktív NAV Online Számla konfiguráció.'});
    res.json({ok:true,environment:c.environment,location_id:c.location_id||null,test_ready:c.environment==='test',live_submission_blocked:true});
  }catch(e){next(e)}
});

router.post('/fixture',async(req:AuthRequest,res,next)=>{
  const c=await db.connect();
  try{
    const requested=String(req.body?.location_id||req.user?.location_id||'').trim();
    const config=await selectedConfig(requested);
    if(!config)return res.status(409).json({ok:false,message:'NAV UAT: nincs aktív NAV konfiguráció.'});
    if(String(config.environment)!=='test')return res.status(409).json({ok:false,error:'nav_uat_live_blocked',message:'NAV UAT tesztadat nem készíthető, mert az aktív NAV konfiguráció nem tesztkörnyezet.',environment:config.environment});
    const uatTag=tag();
    const invoiceNo=`KLEO-${uatTag}`.slice(0,50);
    const locationId=config.location_id||requested||null;
    await c.query('BEGIN');
    const inv=(await c.query(`INSERT INTO finance_invoices(location_id,direction,invoice_no,partner_name,customer_name,customer_country_code,customer_postal_code,customer_city,customer_address,issue_date,performance_date,due_date,currency,net_total,vat_total,gross_total,status,note,created_by,invoice_type,nav_status,nav_validation_status,payment_method,payment_date) VALUES($1::uuid,'outgoing',$2,$3,$3,'HU','3300','Eger','NAV teszt UAT utca 1.',CURRENT_DATE,CURRENT_DATE,CURRENT_DATE,'HUF',2000,320,2320,'draft',$4,$5,'NORMAL','not_submitted','not_validated','CASH',CURRENT_DATE) RETURNING id::text,invoice_no,location_id::text,invoice_type,net_total,vat_total,gross_total`,[locationId,invoiceNo,`${uatTag} Teszt Vendég`,`${uatTag} · AUTOMATIZÁLT NAV TESZT UAT · NEM ÉLES ÜZLETI BIZONYLAT`,actor(req)])).rows[0];
    await c.query(`INSERT INTO finance_invoice_lines(invoice_id,line_number,description,quantity,unit_of_measure,unit_price_net,vat_rate,net_amount,vat_amount,gross_amount) VALUES($1::uuid,1,$2,1,'PIECE',1000,0.27,1000,270,1270),($1::uuid,2,$3,1,'PIECE',1000,0.05,1000,50,1050)`,[inv.id,`${uatTag} 27%-os teszttétel`,`${uatTag} 5%-os teszttétel`]);
    await c.query('COMMIT');
    res.status(201).json({ok:true,tag:uatTag,environment:'test',live_submission_blocked:true,invoice:inv,expected:{operation:'CREATE',vat_rates:[0.27,0.05],gross_total:2320}});
  }catch(e){await c.query('ROLLBACK').catch(()=>undefined);next(e)}finally{c.release()}
});

router.get('/chain/:invoiceId',async(req:AuthRequest,res,next)=>{
  try{
    const root=(await db.query(`SELECT id::text,invoice_no,invoice_type,original_invoice_id::text,original_invoice_number,modification_index,nav_status,nav_transaction_id,nav_xsd_validation_status,created_at,note FROM finance_invoices WHERE id=$1::uuid`,[req.params.invoiceId])).rows[0];
    if(!root)return res.status(404).json({message:'NAV UAT gyökérszámla nem található.'});
    if(!String(root.invoice_no||'').startsWith('KLEO-NAV-UAT-'))return res.status(403).json({message:'Ez a végpont csak NAV-UAT számlalánchoz használható.'});
    const invoices=(await db.query(`SELECT id::text,invoice_no,invoice_type,original_invoice_id::text,original_invoice_number,modification_index,nav_status,nav_transaction_id,nav_xsd_validation_status,created_at FROM finance_invoices WHERE id=$1::uuid OR original_invoice_id=$1::uuid ORDER BY COALESCE(modification_index,0),created_at`,[root.id])).rows;
    const submissions=(await db.query(`SELECT s.id::text,s.invoice_id::text,s.invoice_number,s.operation,s.environment,s.transaction_id,s.status,s.error_code,s.error_message,s.xsd_validation_status,s.xsd_schema_revision,s.submitted_at,s.completed_at,s.nav_result FROM nav_invoice_submissions s WHERE s.invoice_id=ANY($1::uuid[]) ORDER BY s.created_at`,[invoices.map((x:any)=>x.id)])).rows;
    res.json({ok:true,root_invoice_id:root.id,invoices,submissions});
  }catch(e){next(e)}
});

export default router;
