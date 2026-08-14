import { Router } from "express";
import db from "../db";
import { hasAnyRole } from "../security/roles";

const router = Router();
const GLOBAL_ROLES = ["admin", "manager"];
const FINANCE_ROLES = ["admin", "manager", "location_manager", "salon_manager", "receptionist"];
const CONFIG_ROLES = ["admin", "manager", "location_manager"];

const money = (value: unknown) => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};
const actor = (req: any) => req.user?.email || String(req.user?.id || "");
const isGlobal = (req: any) => hasAnyRole(req.user?.role, GLOBAL_ROLES);
const canConfigure = (req: any) => hasAnyRole(req.user?.role, CONFIG_ROLES);
const ownLocation = (req: any) => req.user?.location_id == null ? null : String(req.user.location_id);
const selectedLocation = (req: any) => {
  if (!isGlobal(req)) return ownLocation(req);
  const raw = req.query?.location_id ?? req.body?.location_id;
  return raw == null || String(raw).trim() === "" ? null : String(raw).trim();
};
const locationKey = (id: string | null) => id || "__global__";

function fail(status: number, message: string, code = "finance_v5_error"): never {
  const error: any = new Error(message);
  error.status = status;
  error.publicCode = code;
  throw error;
}
function sendError(error: any, res: any, next: any) {
  if (error?.status) return res.status(error.status).json({ message: error.message, code: error.publicCode });
  return next(error);
}
function requireConfig(req: any) {
  if (!canConfigure(req)) fail(403, "Ehhez a pénzügyi beállításhoz vezetői jogosultság szükséges.", "finance_config_forbidden");
}
function writeLocation(req: any): string | null {
  const own = ownLocation(req);
  if (!isGlobal(req)) {
    if (!own) fail(403, "A felhasználóhoz nincs telephely rendelve.", "finance_location_missing");
    return own;
  }
  const raw = req.body?.location_id;
  return raw == null || String(raw).trim() === "" ? null : String(raw).trim();
}
async function accountForWrite(req: any, id: string, client: any = db) {
  const { rows } = await client.query(`SELECT * FROM financial_accounts WHERE id=$1::uuid AND active=true`, [id]);
  const account = rows[0];
  if (!account) fail(404, "A pénztár/számla nem található.", "finance_account_not_found");
  if (!isGlobal(req) && String(account.location_id || "") !== String(ownLocation(req) || "")) {
    fail(403, "Ehhez a pénztárhoz nincs jogosultsága.", "finance_account_forbidden");
  }
  return account;
}

router.use((req: any, res, next) => {
  if (hasAnyRole(req.user?.role, FINANCE_ROLES)) return next();
  return res.status(403).json({ message: "A pénzügyi modulhoz nincs jogosultsága.", code: "finance_v5_forbidden" });
});

router.get("/dashboard", async (req: any, res, next) => {
  try {
    const locationId = selectedLocation(req);
    const from = String(req.query.from || "").trim();
    const to = String(req.query.to || "").trim();
    const params: any[] = [];
    let accountWhere = "WHERE a.active=true";
    let movementWhere = "WHERE 1=1";
    if (locationId) {
      params.push(locationId);
      accountWhere += ` AND a.location_id::text=$${params.length}`;
      movementWhere += ` AND m.location_id::text=$${params.length}`;
    } else if (!isGlobal(req)) return res.json({ accounts: [], totals: {}, categories: [], trend: [], payment_mix: [], partner_balances: [] });
    if (from) { params.push(from); movementWhere += ` AND m.occurred_at >= $${params.length}::date`; }
    if (to) { params.push(to); movementWhere += ` AND m.occurred_at < ($${params.length}::date + interval '1 day')`; }

    const [accounts, totals, categories, trend, paymentMix, partners] = await Promise.all([
      db.query(`SELECT a.*,a.opening_balance+COALESCE(SUM(CASE WHEN m.direction='income' THEN m.amount ELSE -m.amount END),0)::numeric current_balance
        FROM financial_accounts a LEFT JOIN financial_movements m ON m.account_id=a.id ${accountWhere}
        GROUP BY a.id ORDER BY a.sort_order,a.name`, locationId ? [locationId] : []),
      db.query(`SELECT COALESCE(SUM(m.amount) FILTER(WHERE m.direction='income'),0)::numeric income,
        COALESCE(SUM(m.amount) FILTER(WHERE m.direction='expense'),0)::numeric expense,
        COALESCE(SUM(CASE WHEN m.direction='income' THEN m.amount ELSE -m.amount END),0)::numeric net,
        COUNT(*)::int movement_count FROM financial_movements m ${movementWhere}`, params),
      db.query(`SELECT COALESCE(c.category_group,'Egyéb') category_group,c.direction,COALESCE(SUM(m.amount),0)::numeric amount
        FROM financial_movements m LEFT JOIN financial_categories c ON c.id=m.category_id ${movementWhere}
        GROUP BY COALESCE(c.category_group,'Egyéb'),c.direction ORDER BY amount DESC`, params),
      db.query(`SELECT date_trunc('month',m.occurred_at)::date month,
        COALESCE(SUM(m.amount) FILTER(WHERE m.direction='income'),0)::numeric income,
        COALESCE(SUM(m.amount) FILTER(WHERE m.direction='expense'),0)::numeric expense
        FROM financial_movements m ${movementWhere} GROUP BY 1 ORDER BY 1`, params),
      db.query(`SELECT COALESCE(pm.name,'Nincs megadva') payment_method,COALESCE(SUM(m.amount),0)::numeric amount,COUNT(*)::int count
        FROM financial_movements m LEFT JOIN finance_payment_methods pm ON pm.id=m.payment_method_id
        ${movementWhere} AND m.direction='income' GROUP BY COALESCE(pm.name,'Nincs megadva') ORDER BY amount DESC`, params),
      db.query(`SELECT p.id,p.name,p.partner_type,p.opening_balance+
        COALESCE(SUM(CASE WHEN m.direction='income' THEN m.amount ELSE -m.amount END),0)::numeric balance
        FROM finance_partners p LEFT JOIN financial_movements m ON m.partner_id=p.id
        WHERE p.active=true ${locationId ? "AND p.location_id::text=$1" : ""}
        GROUP BY p.id ORDER BY ABS(p.opening_balance+COALESCE(SUM(CASE WHEN m.direction='income' THEN m.amount ELSE -m.amount END),0)) DESC LIMIT 10`, locationId ? [locationId] : []),
    ]);
    res.json({ accounts: accounts.rows, totals: totals.rows[0] || {}, categories: categories.rows, trend: trend.rows, payment_mix: paymentMix.rows, partner_balances: partners.rows });
  } catch (error) { next(error); }
});

// Accounts / cash registers -------------------------------------------------
router.get("/accounts", async (req: any, res, next) => {
  try {
    const locationId = selectedLocation(req);
    if (!isGlobal(req) && !locationId) return res.json([]);
    const { rows } = await db.query(`SELECT a.*,a.opening_balance+COALESCE(SUM(CASE WHEN m.direction='income' THEN m.amount ELSE -m.amount END),0)::numeric current_balance,
      COUNT(m.id)::int movement_count FROM financial_accounts a LEFT JOIN financial_movements m ON m.account_id=a.id
      WHERE a.active=true ${locationId ? "AND a.location_id::text=$1" : ""}
      GROUP BY a.id ORDER BY a.sort_order,a.name`, locationId ? [locationId] : []);
    res.json(rows);
  } catch (error) { next(error); }
});
router.post("/accounts", async (req: any, res, next) => {
  try {
    requireConfig(req);
    const name = String(req.body?.name || "").trim();
    if (!name) fail(400, "A pénztár/számla neve kötelező.");
    const locationId = writeLocation(req);
    const type = String(req.body?.account_type || "cash");
    if (!["cash","bank","card","online","voucher","other"].includes(type)) fail(400, "Érvénytelen számlatípus.");
    const { rows } = await db.query(`INSERT INTO financial_accounts(location_id,name,account_type,currency,opening_balance,note,account_number,sort_order,is_default,allow_negative_balance)
      VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [locationId,name,type,String(req.body?.currency||"HUF"),money(req.body?.opening_balance),req.body?.note||null,req.body?.account_number||null,Number(req.body?.sort_order||100),Boolean(req.body?.is_default),req.body?.allow_negative_balance!==false]);
    res.status(201).json(rows[0]);
  } catch (error) { sendError(error,res,next); }
});
router.patch("/accounts/:id", async (req: any, res, next) => {
  try {
    requireConfig(req); await accountForWrite(req,req.params.id);
    const { rows } = await db.query(`UPDATE financial_accounts SET name=COALESCE(NULLIF($2,''),name),account_type=COALESCE(NULLIF($3,''),account_type),currency=COALESCE(NULLIF($4,''),currency),
      note=$5,account_number=$6,sort_order=COALESCE($7,sort_order),is_default=COALESCE($8,is_default),allow_negative_balance=COALESCE($9,allow_negative_balance),updated_at=now()
      WHERE id=$1::uuid RETURNING *`,[req.params.id,String(req.body?.name||""),String(req.body?.account_type||""),String(req.body?.currency||""),req.body?.note??null,req.body?.account_number??null,req.body?.sort_order==null?null:Number(req.body.sort_order),req.body?.is_default==null?null:Boolean(req.body.is_default),req.body?.allow_negative_balance==null?null:Boolean(req.body.allow_negative_balance)]);
    res.json(rows[0]);
  } catch (error) { sendError(error,res,next); }
});

router.post("/transfers", async (req: any, res, next) => {
  const client = await db.connect();
  try {
    const sourceId=String(req.body?.source_account_id||""),destId=String(req.body?.destination_account_id||""),amount=money(req.body?.amount);
    if(!sourceId||!destId||sourceId===destId||!(amount>0)) fail(400,"Két különböző pénztár és pozitív összeg szükséges.");
    await client.query("BEGIN");
    const source=await accountForWrite(req,sourceId,client),destination=await accountForWrite(req,destId,client);
    const out=await client.query(`INSERT INTO financial_movements(location_id,account_id,direction,amount,occurred_at,reference_type,note,created_by,payment_status)
      VALUES($1,$2,'expense',$3,COALESCE($4::timestamptz,now()),'transfer',$5,$6,'posted') RETURNING id`,[source.location_id,source.id,amount,req.body?.occurred_at||null,req.body?.note||null,actor(req)]);
    const inc=await client.query(`INSERT INTO financial_movements(location_id,account_id,direction,amount,occurred_at,reference_type,note,created_by,payment_status)
      VALUES($1,$2,'income',$3,COALESCE($4::timestamptz,now()),'transfer',$5,$6,'posted') RETURNING id`,[destination.location_id,destination.id,amount,req.body?.occurred_at||null,req.body?.note||null,actor(req)]);
    const tr=await client.query(`INSERT INTO financial_transfers(location_id,source_account_id,destination_account_id,amount,transferred_at,note,created_by,source_movement_id,destination_movement_id)
      VALUES($1,$2,$3,$4,COALESCE($5::timestamptz,now()),$6,$7,$8,$9) RETURNING *`,[source.location_id||destination.location_id,source.id,destination.id,amount,req.body?.occurred_at||null,req.body?.note||null,actor(req),out.rows[0].id,inc.rows[0].id]);
    await client.query("COMMIT"); res.status(201).json(tr.rows[0]);
  } catch(error){await client.query("ROLLBACK");sendError(error,res,next);} finally{client.release();}
});

// Partners ------------------------------------------------------------------
router.get("/partners", async (req:any,res,next)=>{
  try{
    const locationId=selectedLocation(req),q=String(req.query.q||"").trim(); if(!isGlobal(req)&&!locationId)return res.json([]);
    const params:any[]=[];let where="WHERE p.active=true";
    if(locationId){params.push(locationId);where+=` AND p.location_id::text=$${params.length}`;}
    if(q){params.push(`%${q}%`);where+=` AND (p.name ILIKE $${params.length} OR COALESCE(p.company_name,'') ILIKE $${params.length} OR COALESCE(p.tax_number,'') ILIKE $${params.length})`;}
    const {rows}=await db.query(`SELECT p.*,p.opening_balance+COALESCE(SUM(CASE WHEN m.direction='income' THEN m.amount ELSE -m.amount END),0)::numeric balance,COUNT(m.id)::int movement_count
      FROM finance_partners p LEFT JOIN financial_movements m ON m.partner_id=p.id ${where} GROUP BY p.id ORDER BY p.name`,params);res.json(rows);
  }catch(error){next(error)}
});
router.post("/partners",async(req:any,res,next)=>{try{const name=String(req.body?.name||"").trim();if(!name)fail(400,"A partner neve kötelező.");const locationId=writeLocation(req);const {rows}=await db.query(`INSERT INTO finance_partners(location_id,partner_type,name,company_name,tax_number,registration_number,email,phone,contact_name,address,city,postal_code,country_code,payment_terms_days,opening_balance,note,created_by)
 VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,[locationId,String(req.body?.partner_type||"supplier"),name,req.body?.company_name||null,req.body?.tax_number||null,req.body?.registration_number||null,req.body?.email||null,req.body?.phone||null,req.body?.contact_name||null,req.body?.address||null,req.body?.city||null,req.body?.postal_code||null,String(req.body?.country_code||"HU"),Number(req.body?.payment_terms_days||0),money(req.body?.opening_balance),req.body?.note||null,actor(req)]);res.status(201).json(rows[0]);}catch(error){sendError(error,res,next)}});
router.patch("/partners/:id",async(req:any,res,next)=>{try{const p=await db.query(`SELECT * FROM finance_partners WHERE id=$1::uuid`,[req.params.id]);if(!p.rows[0])fail(404,"A partner nem található.");if(!isGlobal(req)&&String(p.rows[0].location_id||"")!==String(ownLocation(req)||""))fail(403,"Ehhez a partnerhez nincs jogosultsága.");const {rows}=await db.query(`UPDATE finance_partners SET name=COALESCE(NULLIF($2,''),name),partner_type=COALESCE(NULLIF($3,''),partner_type),company_name=$4,tax_number=$5,email=$6,phone=$7,contact_name=$8,address=$9,city=$10,postal_code=$11,payment_terms_days=COALESCE($12,payment_terms_days),note=$13,updated_at=now() WHERE id=$1::uuid RETURNING *`,[req.params.id,String(req.body?.name||""),String(req.body?.partner_type||""),req.body?.company_name??null,req.body?.tax_number??null,req.body?.email??null,req.body?.phone??null,req.body?.contact_name??null,req.body?.address??null,req.body?.city??null,req.body?.postal_code??null,req.body?.payment_terms_days==null?null:Number(req.body.payment_terms_days),req.body?.note??null]);res.json(rows[0]);}catch(error){sendError(error,res,next)}});
router.get("/partners/:id/statement",async(req:any,res,next)=>{try{const p=await db.query(`SELECT * FROM finance_partners WHERE id=$1::uuid`,[req.params.id]);if(!p.rows[0])fail(404,"A partner nem található.");if(!isGlobal(req)&&String(p.rows[0].location_id||"")!==String(ownLocation(req)||""))fail(403,"Ehhez a partnerhez nincs jogosultsága.");const {rows}=await db.query(`SELECT m.*,a.name account_name,c.name category_name,pm.name payment_method_name FROM financial_movements m JOIN financial_accounts a ON a.id=m.account_id LEFT JOIN financial_categories c ON c.id=m.category_id LEFT JOIN finance_payment_methods pm ON pm.id=m.payment_method_id WHERE m.partner_id=$1::uuid ORDER BY m.occurred_at DESC`,[req.params.id]);res.json({partner:p.rows[0],movements:rows});}catch(error){sendError(error,res,next)}});
router.post("/partners/sync-suppliers",async(req:any,res,next)=>{try{requireConfig(req);const exists=await db.query(`SELECT to_regclass('public.suppliers') AS t`);if(!exists.rows[0]?.t)return res.json({synced:0});const result=await db.query(`INSERT INTO finance_partners(partner_type,name,company_name,tax_number,email,phone,contact_name,address,payment_terms_days,external_source,external_id,note)
 SELECT 'supplier',s.name,s.name,s.tax_number,s.email,s.phone,s.contact_name,s.address,COALESCE(s.payment_terms_days,0),'procurement_supplier',s.id::text,s.note FROM suppliers s WHERE COALESCE(s.active,true)=true
 ON CONFLICT(external_source,external_id) WHERE external_source IS NOT NULL AND external_id IS NOT NULL DO UPDATE SET name=EXCLUDED.name,company_name=EXCLUDED.company_name,tax_number=EXCLUDED.tax_number,email=EXCLUDED.email,phone=EXCLUDED.phone,contact_name=EXCLUDED.contact_name,address=EXCLUDED.address,payment_terms_days=EXCLUDED.payment_terms_days,updated_at=now() RETURNING id`);res.json({synced:result.rowCount||0});}catch(error){sendError(error,res,next)}});

// Categories and payment methods -------------------------------------------
router.get("/categories",async(req:any,res,next)=>{try{const locationId=selectedLocation(req);const {rows}=await db.query(`SELECT c.*,p.name parent_name FROM financial_categories c LEFT JOIN financial_categories p ON p.id=c.parent_id WHERE c.active=true AND (${locationId?"c.location_id::text=$1 OR c.location_id IS NULL":"true"}) ORDER BY c.direction,c.sort_order,c.name`,locationId?[locationId]:[]);res.json(rows);}catch(error){next(error)}});
router.post("/categories",async(req:any,res,next)=>{try{requireConfig(req);const name=String(req.body?.name||"").trim(),direction=String(req.body?.direction||"");if(!name||!["income","expense","both"].includes(direction))fail(400,"Név és érvényes irány szükséges.");const {rows}=await db.query(`INSERT INTO financial_categories(location_id,direction,name,code,parent_id,category_group,sort_order) VALUES($1::uuid,$2,$3,$4,$5::uuid,$6,$7) RETURNING *`,[writeLocation(req),direction,name,req.body?.code||null,req.body?.parent_id||null,req.body?.category_group||null,Number(req.body?.sort_order||100)]);res.status(201).json(rows[0]);}catch(error){sendError(error,res,next)}});
router.patch("/categories/:id",async(req:any,res,next)=>{try{requireConfig(req);const {rows}=await db.query(`UPDATE financial_categories SET name=COALESCE(NULLIF($2,''),name),category_group=$3,parent_id=$4::uuid,sort_order=COALESCE($5,sort_order),active=COALESCE($6,active),updated_at=now() WHERE id=$1::uuid AND locked=false RETURNING *`,[req.params.id,String(req.body?.name||""),req.body?.category_group??null,req.body?.parent_id||null,req.body?.sort_order==null?null:Number(req.body.sort_order),req.body?.active==null?null:Boolean(req.body.active)]);if(!rows[0])fail(409,"A rendszerkategória nem módosítható vagy nem található.");res.json(rows[0]);}catch(error){sendError(error,res,next)}});

router.get("/payment-methods",async(req:any,res,next)=>{try{const locationId=selectedLocation(req);const {rows}=await db.query(`SELECT pm.*,a.name account_name FROM finance_payment_methods pm LEFT JOIN financial_accounts a ON a.id=pm.account_id WHERE pm.active=true AND (${locationId?"pm.location_id::text=$1 OR pm.location_id IS NULL":"true"}) ORDER BY pm.sort_order,pm.name`,locationId?[locationId]:[]);res.json(rows);}catch(error){next(error)}});
router.post("/payment-methods",async(req:any,res,next)=>{try{requireConfig(req);const name=String(req.body?.name||"").trim(),code=String(req.body?.code||"").trim();if(!name||!code)fail(400,"A fizetési mód neve és kódja kötelező.");const accountId=String(req.body?.account_id||"").trim()||null;if(accountId)await accountForWrite(req,accountId);const {rows}=await db.query(`INSERT INTO finance_payment_methods(location_id,code,name,method_type,account_id,fee_percent,fee_fixed,processing_days,rounding_step,online,is_default,sort_order,note) VALUES($1::uuid,$2,$3,$4,$5::uuid,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,[writeLocation(req),code,name,String(req.body?.method_type||"custom"),accountId,money(req.body?.fee_percent),money(req.body?.fee_fixed),Number(req.body?.processing_days||0),money(req.body?.rounding_step),Boolean(req.body?.online),Boolean(req.body?.is_default),Number(req.body?.sort_order||100),req.body?.note||null]);res.status(201).json(rows[0]);}catch(error){sendError(error,res,next)}});
router.patch("/payment-methods/:id",async(req:any,res,next)=>{try{requireConfig(req);const {rows}=await db.query(`UPDATE finance_payment_methods SET name=COALESCE(NULLIF($2,''),name),account_id=$3::uuid,fee_percent=COALESCE($4,fee_percent),fee_fixed=COALESCE($5,fee_fixed),processing_days=COALESCE($6,processing_days),rounding_step=COALESCE($7,rounding_step),online=COALESCE($8,online),is_default=COALESCE($9,is_default),active=COALESCE($10,active),updated_at=now() WHERE id=$1::uuid RETURNING *`,[req.params.id,String(req.body?.name||""),req.body?.account_id||null,req.body?.fee_percent==null?null:money(req.body.fee_percent),req.body?.fee_fixed==null?null:money(req.body.fee_fixed),req.body?.processing_days==null?null:Number(req.body.processing_days),req.body?.rounding_step==null?null:money(req.body.rounding_step),req.body?.online==null?null:Boolean(req.body.online),req.body?.is_default==null?null:Boolean(req.body.is_default),req.body?.active==null?null:Boolean(req.body.active)]);if(!rows[0])fail(404,"A fizetési mód nem található.");res.json(rows[0]);}catch(error){sendError(error,res,next)}});

// Financial movements -------------------------------------------------------
router.get("/movements",async(req:any,res,next)=>{try{const locationId=selectedLocation(req);if(!isGlobal(req)&&!locationId)return res.json([]);const params:any[]=[];let where="WHERE 1=1";const add=(value:any,sql:(n:number)=>string)=>{params.push(value);where+=sql(params.length)};if(locationId)add(locationId,n=>` AND m.location_id::text=$${n}`);for(const [key,column] of [["account_id","m.account_id"],["category_id","m.category_id"],["partner_id","m.partner_id"],["payment_method_id","m.payment_method_id"]] as const){const v=String(req.query[key]||"").trim();if(v)add(v,n=>` AND ${column}::text=$${n}`)}const direction=String(req.query.direction||"").trim();if(direction)add(direction,n=>` AND m.direction=$${n}`);const status=String(req.query.status||"").trim();if(status)add(status,n=>` AND m.payment_status=$${n}`);const from=String(req.query.from||"").trim();if(from)add(from,n=>` AND m.occurred_at >= $${n}::date`);const to=String(req.query.to||"").trim();if(to)add(to,n=>` AND m.occurred_at < ($${n}::date+interval '1 day')`);const q=String(req.query.q||"").trim();if(q)add(`%${q}%`,n=>` AND (COALESCE(m.note,'') ILIKE $${n} OR COALESCE(m.counterparty,'') ILIKE $${n} OR COALESCE(m.reference_id,'') ILIKE $${n} OR COALESCE(p.name,'') ILIKE $${n})`);const {rows}=await db.query(`SELECT m.*,a.name account_name,c.name category_name,p.name partner_name,pm.name payment_method_name,d.document_number FROM financial_movements m JOIN financial_accounts a ON a.id=m.account_id LEFT JOIN financial_categories c ON c.id=m.category_id LEFT JOIN finance_partners p ON p.id=m.partner_id LEFT JOIN finance_payment_methods pm ON pm.id=m.payment_method_id LEFT JOIN finance_documents d ON d.id=m.document_id ${where} ORDER BY m.occurred_at DESC,m.created_at DESC LIMIT 1000`,params);res.json(rows);}catch(error){next(error)}});

router.post("/movements",async(req:any,res,next)=>{const client=await db.connect();try{const accountId=String(req.body?.account_id||"").trim(),direction=String(req.body?.direction||""),amount=money(req.body?.amount);if(!accountId||!["income","expense"].includes(direction)||!(amount>0))fail(400,"Pénztár, irány és pozitív összeg szükséges.");await client.query("BEGIN");const account=await accountForWrite(req,accountId,client);let partner:any=null;if(req.body?.partner_id){const p=await client.query(`SELECT * FROM finance_partners WHERE id=$1::uuid`,[req.body.partner_id]);partner=p.rows[0];if(!partner)fail(404,"A partner nem található.");}let method:any=null;if(req.body?.payment_method_id){const r=await client.query(`SELECT * FROM finance_payment_methods WHERE id=$1::uuid AND active=true`,[req.body.payment_method_id]);method=r.rows[0];if(!method)fail(404,"A fizetési mód nem található.");}const movement=await client.query(`INSERT INTO financial_movements(location_id,account_id,category_id,direction,amount,occurred_at,reference_type,reference_id,counterparty,note,created_by,partner_id,payment_method_id,document_id,client_id,employee_id,service_id,product_id,visit_id,work_order_id,payment_status) VALUES($1,$2::uuid,$3::uuid,$4,$5,COALESCE($6::timestamptz,now()),$7,$8,$9,$10,$11,$12::uuid,$13::uuid,$14::uuid,$15,$16,$17,$18,$19,$20,'posted') RETURNING *`,[account.location_id,account.id,req.body?.category_id||null,direction,amount,req.body?.occurred_at||null,req.body?.reference_type||"manual",req.body?.reference_id||null,partner?.name||req.body?.counterparty||null,req.body?.note||null,actor(req),partner?.id||null,method?.id||null,req.body?.document_id||null,req.body?.client_id||null,req.body?.employee_id||null,req.body?.service_id||null,req.body?.product_id||null,req.body?.visit_id||null,req.body?.work_order_id||null]);let feeMovement=null;const fee=direction==='income'&&method?money(amount*Number(method.fee_percent||0)/100+Number(method.fee_fixed||0)):0;if(fee>0){const cat=await client.query(`SELECT id FROM financial_categories WHERE system_key='acquiring_fee' LIMIT 1`);const r=await client.query(`INSERT INTO financial_movements(location_id,account_id,category_id,direction,amount,occurred_at,reference_type,reference_id,counterparty,note,created_by,payment_method_id,fee_for_movement_id,payment_status) VALUES($1,$2,$3,'expense',$4,COALESCE($5::timestamptz,now()),'acquiring_fee',$6,$7,$8,$9,$10,$6::uuid,'posted') RETURNING *`,[account.location_id,account.id,cat.rows[0]?.id||null,fee,req.body?.occurred_at||null,movement.rows[0].id,partner?.name||null,`Automatikus elfogadói díj – ${method.name}`,actor(req),method.id]);feeMovement=r.rows[0];}await client.query("COMMIT");res.status(201).json({movement:movement.rows[0],fee_movement:feeMovement});}catch(error){await client.query("ROLLBACK");sendError(error,res,next)}finally{client.release()}});

router.post("/movements/:id/cancel",async(req:any,res,next)=>{const client=await db.connect();try{await client.query("BEGIN");const r=await client.query(`SELECT * FROM financial_movements WHERE id=$1::uuid FOR UPDATE`,[req.params.id]);const original=r.rows[0];if(!original)fail(404,"A pénzügyi művelet nem található.");await accountForWrite(req,String(original.account_id),client);if(original.payment_status==='cancelled')fail(409,"A pénzügyi művelet már sztornózott.");const rev=await client.query(`INSERT INTO financial_movements(location_id,account_id,category_id,direction,amount,occurred_at,reference_type,reference_id,counterparty,note,created_by,partner_id,payment_method_id,document_id,client_id,employee_id,service_id,product_id,visit_id,work_order_id,payment_status) SELECT location_id,account_id,category_id,CASE WHEN direction='income' THEN 'expense' ELSE 'income' END,amount,now(),'reversal',id::text,counterparty,$2,$3,partner_id,payment_method_id,document_id,client_id,employee_id,service_id,product_id,visit_id,work_order_id,'reversal' FROM financial_movements WHERE id=$1::uuid RETURNING id`,[original.id,String(req.body?.reason||"Sztornó"),actor(req)]);await client.query(`UPDATE financial_movements SET payment_status='cancelled',cancelled_at=now(),cancelled_by=$2,reversed_by_id=$3,updated_at=now() WHERE id=$1`,[original.id,actor(req),rev.rows[0].id]);const feeRows=await client.query(`SELECT * FROM financial_movements WHERE fee_for_movement_id=$1::uuid AND payment_status<>'cancelled' FOR UPDATE`,[original.id]);for(const fee of feeRows.rows){const fr=await client.query(`INSERT INTO financial_movements(location_id,account_id,category_id,direction,amount,occurred_at,reference_type,reference_id,note,created_by,payment_method_id,payment_status) VALUES($1,$2,$3,$4,$5,now(),'reversal',$6,$7,$8,$9,'reversal') RETURNING id`,[fee.location_id,fee.account_id,fee.category_id,fee.direction==='income'?'expense':'income',fee.amount,fee.id,`Díj sztornó – ${String(req.body?.reason||"")}`,actor(req),fee.payment_method_id]);await client.query(`UPDATE financial_movements SET payment_status='cancelled',cancelled_at=now(),cancelled_by=$2,reversed_by_id=$3,updated_at=now() WHERE id=$1`,[fee.id,actor(req),fr.rows[0].id]);}await client.query("COMMIT");res.json({ok:true,reversal_id:rev.rows[0].id});}catch(error){await client.query("ROLLBACK");sendError(error,res,next)}finally{client.release()}});

// Documents -----------------------------------------------------------------
router.get("/documents",async(req:any,res,next)=>{try{const locationId=selectedLocation(req);if(!isGlobal(req)&&!locationId)return res.json([]);const params=locationId?[locationId]:[];const ownDocs=await db.query(`SELECT d.*,p.name partner_display_name,'document' source FROM finance_documents d LEFT JOIN finance_partners p ON p.id=d.partner_id WHERE 1=1 ${locationId?"AND d.location_id::text=$1":""} ORDER BY d.document_date DESC,d.created_at DESC LIMIT 600`,params);const invoices=await db.query(`SELECT id,location_id,'invoice' document_type,invoice_no document_number,issue_date document_date,CASE WHEN direction='outgoing' THEN 'income' ELSE 'expense' END direction,NULL::uuid partner_id,partner_name partner_display_name,gross_total,currency,direction reference_type,id::text reference_id,status,note,created_by,created_at,updated_at,'invoice' source FROM finance_invoices WHERE 1=1 ${locationId?"AND location_id::text=$1":""} ORDER BY issue_date DESC,created_at DESC LIMIT 600`,params).catch(()=>({rows:[]} as any));const all=[...ownDocs.rows,...invoices.rows].sort((a:any,b:any)=>String(b.document_date||b.created_at).localeCompare(String(a.document_date||a.created_at))).slice(0,1000);res.json(all);}catch(error){next(error)}});
router.post("/documents",async(req:any,res,next)=>{try{const type=String(req.body?.document_type||"").trim();if(!type)fail(400,"A dokumentum típusa kötelező.");const {rows}=await db.query(`INSERT INTO finance_documents(location_id,document_type,document_number,document_date,direction,partner_id,partner_name,gross_total,currency,reference_type,reference_id,status,note,created_by) VALUES($1::uuid,$2,$3,COALESCE($4::date,CURRENT_DATE),$5,$6::uuid,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,[writeLocation(req),type,req.body?.document_number||null,req.body?.document_date||null,String(req.body?.direction||"neutral"),req.body?.partner_id||null,req.body?.partner_name||null,money(req.body?.gross_total),String(req.body?.currency||"HUF"),req.body?.reference_type||null,req.body?.reference_id||null,String(req.body?.status||"active"),req.body?.note||null,actor(req)]);res.status(201).json(rows[0]);}catch(error){sendError(error,res,next)}});

// Reports -------------------------------------------------------------------
router.get("/reports/pl",async(req:any,res,next)=>{try{const locationId=selectedLocation(req),from=String(req.query.from||"").trim(),to=String(req.query.to||"").trim();if(!isGlobal(req)&&!locationId)return res.json({months:[],categories:[]});const params:any[]=[];let where="WHERE 1=1";if(locationId){params.push(locationId);where+=` AND m.location_id::text=$${params.length}`;}if(from){params.push(from);where+=` AND m.occurred_at >= $${params.length}::date`;}if(to){params.push(to);where+=` AND m.occurred_at < ($${params.length}::date+interval '1 day')`;}const months=await db.query(`SELECT date_trunc('month',m.occurred_at)::date month,COALESCE(SUM(m.amount) FILTER(WHERE m.direction='income'),0)::numeric income,COALESCE(SUM(m.amount) FILTER(WHERE m.direction='expense'),0)::numeric expense,COALESCE(SUM(CASE WHEN m.direction='income' THEN m.amount ELSE -m.amount END),0)::numeric profit FROM financial_movements m ${where} GROUP BY 1 ORDER BY 1`,params);const categories=await db.query(`SELECT c.direction,c.name,c.category_group,COALESCE(SUM(m.amount),0)::numeric amount FROM financial_movements m LEFT JOIN financial_categories c ON c.id=m.category_id ${where} GROUP BY c.direction,c.name,c.category_group ORDER BY c.direction,amount DESC`,params);res.json({months:months.rows,categories:categories.rows});}catch(error){next(error)}});
router.get("/reports/daily-cash",async(req:any,res,next)=>{try{const locationId=selectedLocation(req),date=String(req.query.date||new Date().toISOString().slice(0,10));if(!isGlobal(req)&&!locationId)return res.json([]);const {rows}=await db.query(`SELECT a.id,a.name,a.account_type,a.opening_balance,COALESCE(SUM(m.amount) FILTER(WHERE m.direction='income'),0)::numeric income,COALESCE(SUM(m.amount) FILTER(WHERE m.direction='expense'),0)::numeric expense,a.opening_balance+COALESCE(SUM(CASE WHEN m.direction='income' THEN m.amount ELSE -m.amount END),0)::numeric closing_balance FROM financial_accounts a LEFT JOIN financial_movements m ON m.account_id=a.id AND m.occurred_at::date=$1::date WHERE a.active=true ${locationId?"AND a.location_id::text=$2":""} GROUP BY a.id ORDER BY a.sort_order,a.name`,locationId?[date,locationId]:[date]);res.json(rows);}catch(error){next(error)}});

// Finance settings ----------------------------------------------------------
router.get("/settings",async(req:any,res,next)=>{try{const locationId=selectedLocation(req);const key=locationKey(locationId);const {rows}=await db.query(`SELECT COALESCE(local.online_payment_enabled,g.online_payment_enabled,false) online_payment_enabled,COALESCE(local.online_payment_provider,g.online_payment_provider) online_payment_provider,COALESCE(local.online_sale_memberships,g.online_sale_memberships,false) online_sale_memberships,COALESCE(local.online_booking_prepayment,g.online_booking_prepayment,false) online_booking_prepayment,COALESCE(local.payment_link_enabled,g.payment_link_enabled,false) payment_link_enabled,COALESCE(local.invoicing_provider,g.invoicing_provider,'billingo') invoicing_provider,COALESCE(local.invoicing_connected,g.invoicing_connected,false) invoicing_connected,COALESCE(local.cash_rounding_step,g.cash_rounding_step,0) cash_rounding_step,COALESCE(local.require_partner_on_expense,g.require_partner_on_expense,false) require_partner_on_expense,$1::text location_key FROM finance_settings_v5 g LEFT JOIN finance_settings_v5 local ON local.location_key=$1 WHERE g.location_key='__global__'`,[key]);res.json(rows[0]||{});}catch(error){next(error)}});
router.patch("/settings",async(req:any,res,next)=>{try{requireConfig(req);const locationId=selectedLocation(req),key=locationKey(locationId);const {rows}=await db.query(`INSERT INTO finance_settings_v5(location_key,online_payment_enabled,online_payment_provider,online_sale_memberships,online_booking_prepayment,payment_link_enabled,invoicing_provider,invoicing_connected,cash_rounding_step,require_partner_on_expense,updated_by,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now()) ON CONFLICT(location_key) DO UPDATE SET online_payment_enabled=EXCLUDED.online_payment_enabled,online_payment_provider=EXCLUDED.online_payment_provider,online_sale_memberships=EXCLUDED.online_sale_memberships,online_booking_prepayment=EXCLUDED.online_booking_prepayment,payment_link_enabled=EXCLUDED.payment_link_enabled,invoicing_provider=EXCLUDED.invoicing_provider,invoicing_connected=EXCLUDED.invoicing_connected,cash_rounding_step=EXCLUDED.cash_rounding_step,require_partner_on_expense=EXCLUDED.require_partner_on_expense,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING *`,[key,Boolean(req.body?.online_payment_enabled),req.body?.online_payment_provider||null,Boolean(req.body?.online_sale_memberships),Boolean(req.body?.online_booking_prepayment),Boolean(req.body?.payment_link_enabled),String(req.body?.invoicing_provider||"billingo"),Boolean(req.body?.invoicing_connected),money(req.body?.cash_rounding_step),Boolean(req.body?.require_partner_on_expense),actor(req)]);res.json(rows[0]);}catch(error){sendError(error,res,next)}});
router.get("/online-payment",async(req:any,res,next)=>{try{const locationId=selectedLocation(req),key=locationKey(locationId);const [settings,methods]=await Promise.all([db.query(`SELECT * FROM finance_settings_v5 WHERE location_key IN('__global__',$1) ORDER BY CASE WHEN location_key=$1 THEN 0 ELSE 1 END LIMIT 1`,[key]),db.query(`SELECT pm.*,a.name account_name FROM finance_payment_methods pm LEFT JOIN financial_accounts a ON a.id=pm.account_id WHERE pm.active=true AND pm.online=true AND (${locationId?"pm.location_id::text=$1 OR pm.location_id IS NULL":"true"}) ORDER BY pm.sort_order`,locationId?[locationId]:[])]);res.json({settings:settings.rows[0]||{},methods:methods.rows});}catch(error){next(error)}});

export default router;
