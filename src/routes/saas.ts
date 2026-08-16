import { Router, Response } from "express";
import db from "../db";
import { requireAuth } from "../middleware/auth";
import { requireTenantContext, requireTenantRole, TenantAuthRequest } from "../middleware/tenantContext";
import franchiseFinanceRouter from "./franchiseFinance";

const router = Router();
router.use(requireAuth, requireTenantContext);
router.use("/franchise-finance",franchiseFinanceRouter);

router.get("/context", async (req: TenantAuthRequest, res: Response) => {
  try {
    const { rows } = await db.query(
      `SELECT t.id::text AS tenant_id,t.slug,t.name,t.legal_name,t.status,t.default_locale,t.default_currency,t.timezone,
              sp.code AS plan_code,sp.name AS plan_name,sp.features AS plan_features,
              s.id::text AS subscription_id,s.status AS subscription_status,s.current_period_end,s.cancel_at_period_end,s.grace_period_end,s.last_payment_status,
              tb.app_name,tb.logo_url,tb.primary_color,tb.secondary_color,tb.custom_domain
         FROM tenants t
         LEFT JOIN subscriptions s ON s.tenant_id=t.id AND s.status IN ('trial','active','past_due','suspended')
         LEFT JOIN subscription_plans sp ON sp.id=s.plan_id
         LEFT JOIN tenant_branding tb ON tb.tenant_id=t.id
        WHERE t.id=$1::bigint
        ORDER BY s.created_at DESC NULLS LAST LIMIT 1`,[req.tenant!.id]);
    const featureRows=await db.query(`SELECT feature_key,enabled,config FROM tenant_features WHERE tenant_id=$1::bigint ORDER BY feature_key`,[req.tenant!.id]);
    return res.json({ok:true,tenant:rows[0]||req.tenant,tenant_role:req.tenant!.role,feature_overrides:featureRows.rows});
  } catch(error){console.error("[SAAS] context:",error);return res.status(500).json({ok:false,error:"A SaaS kontextus nem tölthető be."});}
});

router.get("/subscription", async(req:TenantAuthRequest,res:Response)=>{
  try{
    const subscription=await db.query(`SELECT s.id::text,s.status,s.starts_at,s.trial_ends_at,s.current_period_end,s.cancel_at_period_end,s.cancelled_at,s.grace_period_end,s.last_payment_status,s.last_payment_at,s.billing_provider,s.external_subscription_id,sp.code plan_code,sp.name plan_name,sp.monthly_price,sp.currency,sp.features FROM subscriptions s JOIN subscription_plans sp ON sp.id=s.plan_id WHERE s.tenant_id=$1::bigint ORDER BY CASE WHEN s.status IN ('trial','active','past_due','suspended') THEN 0 ELSE 1 END,s.created_at DESC LIMIT 1`,[req.tenant!.id]);
    const invoices=await db.query(`SELECT id::text,status,period_start,period_end,currency,net_amount,tax_amount,gross_amount,due_at,paid_at,external_invoice_id,created_at FROM subscription_invoices WHERE tenant_id=$1::bigint ORDER BY created_at DESC LIMIT 12`,[req.tenant!.id]);
    const events=await db.query(`SELECT id::text,event_type,source,created_at,payload FROM subscription_events WHERE tenant_id=$1::bigint ORDER BY created_at DESC LIMIT 25`,[req.tenant!.id]);
    return res.json({ok:true,subscription:subscription.rows[0]||null,invoices:invoices.rows,events:events.rows});
  }catch(error){console.error("[SAAS] subscription:",error);return res.status(500).json({ok:false,error:"Az előfizetés nem tölthető be."});}
});

router.post("/subscription/change-plan",requireTenantRole("owner","admin"),async(req:TenantAuthRequest,res:Response)=>{
  const planCode=String(req.body?.plan_code||"").trim().toLowerCase();if(!planCode)return res.status(400).json({ok:false,error:"A plan_code kötelező."});
  const client=await db.connect();
  try{
    await client.query("BEGIN");
    const plan=await client.query(`SELECT id,code,name,monthly_price,currency,features FROM subscription_plans WHERE code=$1 AND active=true LIMIT 1`,[planCode]);if(!plan.rowCount){await client.query("ROLLBACK");return res.status(404).json({ok:false,error:"Az előfizetési csomag nem található."});}
    const current=await client.query(`SELECT s.*,sp.code old_plan_code FROM subscriptions s JOIN subscription_plans sp ON sp.id=s.plan_id WHERE s.tenant_id=$1::bigint ORDER BY CASE WHEN s.status IN ('trial','active','past_due','suspended') THEN 0 ELSE 1 END,s.created_at DESC LIMIT 1 FOR UPDATE`,[req.tenant!.id]);
    const row=current.rows[0];if(!row){await client.query("ROLLBACK");return res.status(409).json({ok:false,error:"A tenanthoz nincs módosítható előfizetés."});}
    if(row.external_subscription_id){await client.query("ROLLBACK");return res.status(409).json({ok:false,code:"BILLING_PROVIDER_MANAGED",error:"A külső szolgáltató által kezelt előfizetés csomagváltása provider-adaptert igényel."});}
    await client.query(`UPDATE subscriptions SET plan_id=$2,status=CASE WHEN status='cancelled' THEN 'active' ELSE status END,cancel_at_period_end=false,cancelled_at=NULL,updated_at=now() WHERE id=$1`,[row.id,plan.rows[0].id]);
    await client.query(`INSERT INTO subscription_events(tenant_id,subscription_id,event_type,source,payload) VALUES($1::bigint,$2::bigint,'plan_changed','admin',$3::jsonb)`,[req.tenant!.id,row.id,JSON.stringify({from:row.old_plan_code,to:plan.rows[0].code})]);
    await client.query("COMMIT");return res.json({ok:true,plan:plan.rows[0]});
  }catch(error){await client.query("ROLLBACK").catch(()=>{});console.error("[SAAS] plan change:",error);return res.status(500).json({ok:false,error:"A csomagváltás nem sikerült."});}finally{client.release();}
});

router.post("/subscription/cancel",requireTenantRole("owner","admin"),async(req:TenantAuthRequest,res:Response)=>{
  const atPeriodEnd=req.body?.at_period_end!==false;const client=await db.connect();
  try{
    await client.query("BEGIN");const current=await client.query(`SELECT * FROM subscriptions WHERE tenant_id=$1::bigint AND status IN ('trial','active','past_due','suspended') ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,[req.tenant!.id]);const row=current.rows[0];
    if(!row){await client.query("ROLLBACK");return res.status(409).json({ok:false,error:"Nincs lemondható aktív előfizetés."});}
    if(row.external_subscription_id){await client.query("ROLLBACK");return res.status(409).json({ok:false,code:"BILLING_PROVIDER_MANAGED",error:"A külső szolgáltató által kezelt előfizetés lemondása provider-adaptert igényel."});}
    if(atPeriodEnd)await client.query(`UPDATE subscriptions SET cancel_at_period_end=true,updated_at=now() WHERE id=$1`,[row.id]);
    else await client.query(`UPDATE subscriptions SET status='cancelled',cancel_at_period_end=false,cancelled_at=now(),updated_at=now() WHERE id=$1`,[row.id]);
    await client.query(`INSERT INTO subscription_events(tenant_id,subscription_id,event_type,source,payload) VALUES($1::bigint,$2::bigint,$3,'admin',$4::jsonb)`,[req.tenant!.id,row.id,atPeriodEnd?'cancel_scheduled':'cancelled',JSON.stringify({at_period_end:atPeriodEnd})]);
    await client.query("COMMIT");return res.json({ok:true,cancel_at_period_end:atPeriodEnd,status:atPeriodEnd?row.status:'cancelled'});
  }catch(error){await client.query("ROLLBACK").catch(()=>{});console.error("[SAAS] cancel:",error);return res.status(500).json({ok:false,error:"Az előfizetés lemondása nem sikerült."});}finally{client.release();}
});

router.post("/subscription/reactivate",requireTenantRole("owner","admin"),async(req:TenantAuthRequest,res:Response)=>{
  const client=await db.connect();try{await client.query("BEGIN");const current=await client.query(`SELECT * FROM subscriptions WHERE tenant_id=$1::bigint ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,[req.tenant!.id]);const row=current.rows[0];if(!row){await client.query("ROLLBACK");return res.status(404).json({ok:false,error:"Előfizetés nem található."});}if(row.external_subscription_id){await client.query("ROLLBACK");return res.status(409).json({ok:false,code:"BILLING_PROVIDER_MANAGED",error:"A külső szolgáltató által kezelt előfizetés újraaktiválása provider-adaptert igényel."});}await client.query(`UPDATE subscriptions SET status=CASE WHEN status='cancelled' THEN 'active' ELSE status END,cancel_at_period_end=false,cancelled_at=NULL,updated_at=now() WHERE id=$1`,[row.id]);await client.query(`INSERT INTO subscription_events(tenant_id,subscription_id,event_type,source,payload) VALUES($1::bigint,$2::bigint,'reactivated','admin','{}'::jsonb)`,[req.tenant!.id,row.id]);await client.query("COMMIT");return res.json({ok:true,status:row.status==='cancelled'?'active':row.status,cancel_at_period_end:false});}catch(error){await client.query("ROLLBACK").catch(()=>{});console.error("[SAAS] reactivate:",error);return res.status(500).json({ok:false,error:"Az előfizetés újraaktiválása nem sikerült."});}finally{client.release();}
});

router.get("/billing/invoices",async(req:TenantAuthRequest,res:Response)=>{try{const{rows}=await db.query(`SELECT id::text,subscription_id::text,status,period_start,period_end,currency,net_amount,tax_amount,gross_amount,due_at,paid_at,external_invoice_id,created_at FROM subscription_invoices WHERE tenant_id=$1::bigint ORDER BY created_at DESC LIMIT 100`,[req.tenant!.id]);return res.json({ok:true,rows});}catch(error){console.error("[SAAS] billing invoices:",error);return res.status(500).json({ok:false,error:"A SaaS számlák nem tölthetők be."});}});

router.get("/franchise-networks",async(req:TenantAuthRequest,res:Response)=>{try{const{rows}=await db.query(`SELECT fn.*,COUNT(fm.id)::int AS member_count,COUNT(fm.id) FILTER (WHERE fm.member_type='owned')::int AS owned_location_count,COUNT(fm.id) FILTER (WHERE fm.member_type='franchise')::int AS franchise_location_count FROM franchise_networks fn LEFT JOIN franchise_members fm ON fm.franchise_network_id=fn.id AND fm.tenant_id=fn.tenant_id AND fm.active=true WHERE fn.tenant_id=$1::bigint GROUP BY fn.id ORDER BY fn.name`,[req.tenant!.id]);return res.json({ok:true,rows});}catch(error){console.error("[SAAS] franchise list:",error);return res.status(500).json({ok:false,error:"A franchise hálózatok nem tölthetők be."});}});
router.post("/franchise-networks",requireTenantRole("owner","admin"),async(req:TenantAuthRequest,res:Response)=>{const code=String(req.body?.code||"").trim().toLowerCase(),name=String(req.body?.name||"").trim(),ownerLegalName=String(req.body?.owner_legal_name||"").trim()||null,royaltyPercent=Number(req.body?.royalty_percent??0),marketingFeePercent=Number(req.body?.marketing_fee_percent??0);if(!code||!name)return res.status(400).json({ok:false,error:"A kód és a név kötelező."});if(!Number.isFinite(royaltyPercent)||royaltyPercent<0||royaltyPercent>100)return res.status(400).json({ok:false,error:"A royalty százalék 0 és 100 közötti lehet."});if(!Number.isFinite(marketingFeePercent)||marketingFeePercent<0||marketingFeePercent>100)return res.status(400).json({ok:false,error:"A marketing díj százaléka 0 és 100 közötti lehet."});try{const{rows}=await db.query(`INSERT INTO franchise_networks(tenant_id,code,name,owner_legal_name,royalty_percent,marketing_fee_percent) VALUES($1::bigint,$2,$3,$4,$5,$6) RETURNING *`,[req.tenant!.id,code,name,ownerLegalName,royaltyPercent,marketingFeePercent]);return res.status(201).json({ok:true,row:rows[0]});}catch(error:any){if(error?.code==="23505")return res.status(409).json({ok:false,error:"Ilyen franchise kód már létezik ennél a tenantnál."});console.error("[SAAS] franchise create:",error);return res.status(500).json({ok:false,error:"A franchise hálózat nem hozható létre."});}});
router.post("/franchise-networks/:networkId/members",requireTenantRole("owner","admin"),async(req:TenantAuthRequest,res:Response)=>{const networkId=String(req.params.networkId||"").trim(),locationId=String(req.body?.location_id||"").trim(),memberType=req.body?.member_type==="owned"?"owned":"franchise";if(!/^\d+$/.test(networkId)||!locationId||locationId.length>128)return res.status(400).json({ok:false,error:"Érvénytelen hálózat- vagy telephelyazonosító."});try{const location=await db.query(`SELECT id FROM locations WHERE id::text=$1 AND tenant_id=$2::bigint LIMIT 1`,[locationId,req.tenant!.id]);if(!location.rowCount)return res.status(404).json({ok:false,error:"A telephely nem ehhez a tenanthoz tartozik."});const network=await db.query(`SELECT id FROM franchise_networks WHERE id::text=$1 AND tenant_id=$2::bigint LIMIT 1`,[networkId,req.tenant!.id]);if(!network.rowCount)return res.status(404).json({ok:false,error:"A franchise hálózat nem található."});const{rows}=await db.query(`INSERT INTO franchise_members(tenant_id,franchise_network_id,location_id,member_type,agreement_number,agreement_start,agreement_end,royalty_percent,marketing_fee_percent) VALUES($1::bigint,$2::bigint,$3,$4,$5,$6::date,$7::date,$8,$9) ON CONFLICT(franchise_network_id,location_id) DO UPDATE SET member_type=EXCLUDED.member_type,agreement_number=EXCLUDED.agreement_number,agreement_start=EXCLUDED.agreement_start,agreement_end=EXCLUDED.agreement_end,royalty_percent=EXCLUDED.royalty_percent,marketing_fee_percent=EXCLUDED.marketing_fee_percent,active=true,updated_at=now() RETURNING *`,[req.tenant!.id,networkId,locationId,memberType,String(req.body?.agreement_number||"").trim()||null,req.body?.agreement_start||null,req.body?.agreement_end||null,req.body?.royalty_percent??null,req.body?.marketing_fee_percent??null]);return res.status(201).json({ok:true,row:rows[0]});}catch(error){console.error("[SAAS] franchise member upsert:",error);return res.status(500).json({ok:false,error:"A franchise telephely nem menthető."});}});
router.get("/locations",async(req:TenantAuthRequest,res:Response)=>{try{const{rows}=await db.query(`SELECT l.id,l.name,l.city,l.address,l.is_active,fm.franchise_network_id,fm.member_type,fn.name AS franchise_network_name FROM locations l LEFT JOIN franchise_members fm ON fm.location_id=l.id::text AND fm.tenant_id=$1::bigint AND fm.active=true LEFT JOIN franchise_networks fn ON fn.id=fm.franchise_network_id AND fn.tenant_id=fm.tenant_id WHERE l.tenant_id=$1::bigint ORDER BY l.city NULLS LAST,l.name`,[req.tenant!.id]);return res.json({ok:true,rows});}catch(error){console.error("[SAAS] tenant locations:",error);return res.status(500).json({ok:false,error:"A tenant telephelyei nem tölthetők be."});}});

export default router;
