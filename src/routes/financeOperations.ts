import { Router } from "express";
import db from "../db";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { requireFeature } from "../middleware/featureAccess";

const router = Router();
router.use(requireAuth);
router.use(requireFeature("finance"));

const money = (value: unknown) => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

const actor = (req: AuthRequest) => req.user?.email || String(req.user?.id || "");

router.get("/overview", async (req: AuthRequest, res, next) => {
  try {
    const locationId = String(req.query.location_id || req.user?.location_id || "").trim();
    const params: any[] = [];
    let locationFilter = "";
    if (locationId) { params.push(locationId); locationFilter = `WHERE (a.location_id::text=$1 OR a.location_id IS NULL)`; }
    const accounts = await db.query(
      `SELECT a.*,
              a.opening_balance + COALESCE(SUM(CASE WHEN m.direction='income' THEN m.amount ELSE -m.amount END),0) AS current_balance
       FROM financial_accounts a
       LEFT JOIN financial_movements m ON m.account_id=a.id
       ${locationFilter}
       GROUP BY a.id ORDER BY a.account_type,a.name`, params);
    const movementParams: any[] = [];
    let movementWhere = "WHERE m.occurred_at >= date_trunc('day',now())";
    if (locationId) { movementParams.push(locationId); movementWhere += ` AND (m.location_id::text=$1 OR m.location_id IS NULL)`; }
    const totals = await db.query(
      `SELECT COALESCE(SUM(amount) FILTER(WHERE direction='income'),0)::numeric income,
              COALESCE(SUM(amount) FILTER(WHERE direction='expense'),0)::numeric expense,
              COUNT(*)::int movement_count
       FROM financial_movements m ${movementWhere}`, movementParams);
    const refunds = await db.query(
      `SELECT COALESCE(SUM(amount),0)::numeric total,COUNT(*)::int count
       FROM financial_refunds
       WHERE refunded_at>=date_trunc('day',now())
         AND ($1::text='' OR location_id::text=$1)`, [locationId]);
    res.json({ accounts: accounts.rows, today: totals.rows[0], refunds_today: refunds.rows[0] });
  } catch (err) { next(err); }
});

router.get("/accounts", async (req: AuthRequest, res, next) => {
  try {
    const locationId = String(req.query.location_id || req.user?.location_id || "").trim();
    const { rows } = await db.query(
      `SELECT a.*,
              a.opening_balance + COALESCE(SUM(CASE WHEN m.direction='income' THEN m.amount ELSE -m.amount END),0) AS current_balance
       FROM financial_accounts a
       LEFT JOIN financial_movements m ON m.account_id=a.id
       WHERE ($1::text='' OR a.location_id::text=$1 OR a.location_id IS NULL)
       GROUP BY a.id ORDER BY a.active DESC,a.account_type,a.name`, [locationId]);
    res.json(rows);
  } catch (err) { next(err); }
});

router.post("/accounts", async (req: AuthRequest, res, next) => {
  try {
    const name = String(req.body?.name || "").trim();
    const type = String(req.body?.account_type || "cash").trim();
    const locationId = String(req.body?.location_id || req.user?.location_id || "").trim() || null;
    if (!name) return res.status(400).json({ message: "A pénzügyi számla/pénztár neve kötelező." });
    const { rows } = await db.query(
      `INSERT INTO financial_accounts(location_id,name,account_type,currency,opening_balance,note)
       VALUES($1::uuid,$2,$3,$4,$5,$6) RETURNING *`,
      [locationId,name,type,String(req.body?.currency||"HUF"),money(req.body?.opening_balance),req.body?.note||null]);
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

router.get("/categories", async (req: AuthRequest, res, next) => {
  try {
    const locationId = String(req.query.location_id || req.user?.location_id || "").trim();
    const { rows } = await db.query(
      `SELECT * FROM financial_categories
       WHERE active=true AND ($1::text='' OR location_id::text=$1 OR location_id IS NULL)
       ORDER BY direction,name`, [locationId]);
    res.json(rows);
  } catch (err) { next(err); }
});

router.post("/categories", async (req: AuthRequest, res, next) => {
  try {
    const name = String(req.body?.name||"").trim();
    const direction = String(req.body?.direction||"both").trim();
    const locationId = String(req.body?.location_id || req.user?.location_id || "").trim() || null;
    if (!name) return res.status(400).json({ message:"A kategória neve kötelező." });
    const { rows } = await db.query(
      `INSERT INTO financial_categories(location_id,direction,name,code) VALUES($1::uuid,$2,$3,$4) RETURNING *`,
      [locationId,direction,name,req.body?.code||null]);
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

router.get("/movements", async (req: AuthRequest, res, next) => {
  try {
    const locationId = String(req.query.location_id || req.user?.location_id || "").trim();
    const from = String(req.query.from || "").trim();
    const to = String(req.query.to || "").trim();
    const accountId = String(req.query.account_id || "").trim();
    const params:any[]=[]; let where="WHERE 1=1";
    if(locationId){params.push(locationId);where+=` AND (m.location_id::text=$${params.length} OR m.location_id IS NULL)`;}
    if(accountId){params.push(accountId);where+=` AND m.account_id::text=$${params.length}`;}
    if(from){params.push(from);where+=` AND m.occurred_at >= $${params.length}::date`;}
    if(to){params.push(to);where+=` AND m.occurred_at < ($${params.length}::date + interval '1 day')`;}
    const { rows } = await db.query(
      `SELECT m.*,a.name account_name,c.name category_name
       FROM financial_movements m
       JOIN financial_accounts a ON a.id=m.account_id
       LEFT JOIN financial_categories c ON c.id=m.category_id
       ${where} ORDER BY m.occurred_at DESC,m.created_at DESC LIMIT 500`, params);
    res.json(rows);
  } catch (err) { next(err); }
});

router.post("/movements", async (req: AuthRequest, res, next) => {
  try {
    const accountId=String(req.body?.account_id||"").trim();
    const direction=String(req.body?.direction||"").trim();
    const amount=money(req.body?.amount);
    if(!accountId||!["income","expense"].includes(direction)||!(amount>0)) return res.status(400).json({message:"Számla, irány és pozitív összeg szükséges."});
    const account=await db.query(`SELECT * FROM financial_accounts WHERE id=$1::uuid AND active=true`,[accountId]);
    if(!account.rows[0]) return res.status(404).json({message:"A pénzügyi számla nem található."});
    const { rows }=await db.query(
      `INSERT INTO financial_movements(location_id,account_id,category_id,direction,amount,occurred_at,reference_type,reference_id,counterparty,note,created_by)
       VALUES($1,$2::uuid,$3::uuid,$4,$5,COALESCE($6::timestamptz,now()),$7,$8,$9,$10,$11) RETURNING *`,
      [account.rows[0].location_id,accountId,req.body?.category_id||null,direction,amount,req.body?.occurred_at||null,req.body?.reference_type||"manual",req.body?.reference_id||null,req.body?.counterparty||null,req.body?.note||null,actor(req)]);
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

router.post("/transfers", async (req: AuthRequest, res, next) => {
  const client=await db.connect();
  try {
    const source=String(req.body?.source_account_id||"").trim(),destination=String(req.body?.destination_account_id||"").trim(),amount=money(req.body?.amount);
    if(!source||!destination||source===destination||!(amount>0)) return res.status(400).json({message:"Két különböző számla és pozitív összeg szükséges."});
    await client.query("BEGIN");
    const accounts=await client.query(`SELECT * FROM financial_accounts WHERE id=ANY($1::uuid[]) AND active=true`,[[source,destination]]);
    if(accounts.rows.length!==2) throw new Error("Egy vagy több pénzügyi számla nem található.");
    const sourceAccount=accounts.rows.find((x:any)=>String(x.id)===source),destAccount=accounts.rows.find((x:any)=>String(x.id)===destination);
    const out=await client.query(`INSERT INTO financial_movements(location_id,account_id,direction,amount,occurred_at,reference_type,note,created_by) VALUES($1,$2,'expense',$3,COALESCE($4::timestamptz,now()),'transfer',$5,$6) RETURNING id`,[sourceAccount.location_id,source,amount,req.body?.transferred_at||null,req.body?.note||null,actor(req)]);
    const inc=await client.query(`INSERT INTO financial_movements(location_id,account_id,direction,amount,occurred_at,reference_type,note,created_by) VALUES($1,$2,'income',$3,COALESCE($4::timestamptz,now()),'transfer',$5,$6) RETURNING id`,[destAccount.location_id,destination,amount,req.body?.transferred_at||null,req.body?.note||null,actor(req)]);
    const transfer=await client.query(`INSERT INTO financial_transfers(location_id,source_account_id,destination_account_id,amount,transferred_at,note,created_by,source_movement_id,destination_movement_id) VALUES($1,$2,$3,$4,COALESCE($5::timestamptz,now()),$6,$7,$8,$9) RETURNING *`,[sourceAccount.location_id||destAccount.location_id,source,destination,amount,req.body?.transferred_at||null,req.body?.note||null,actor(req),out.rows[0].id,inc.rows[0].id]);
    await client.query("COMMIT");res.status(201).json(transfer.rows[0]);
  } catch(err:any){await client.query("ROLLBACK"); if(String(err?.message).includes("nem található")) return res.status(400).json({message:err.message}); next(err);} finally{client.release();}
});

router.post("/refunds", async (req: AuthRequest, res, next) => {
  const client=await db.connect();
  try {
    const accountId=String(req.body?.account_id||"").trim(),amount=money(req.body?.amount),reason=String(req.body?.reason||"").trim(),workOrderId=String(req.body?.work_order_id||"").trim()||null;
    if(!accountId||!(amount>0)||!reason) return res.status(400).json({message:"Számla, pozitív összeg és indoklás szükséges."});
    await client.query("BEGIN");
    const account=await client.query(`SELECT * FROM financial_accounts WHERE id=$1::uuid AND active=true`,[accountId]);
    if(!account.rows[0]) throw new Error("A pénzügyi számla nem található.");
    const category=await client.query(`SELECT id FROM financial_categories WHERE system_key='refund_expense' LIMIT 1`);
    const movement=await client.query(`INSERT INTO financial_movements(location_id,account_id,category_id,direction,amount,occurred_at,reference_type,reference_id,note,created_by) VALUES($1,$2,$3,'expense',$4,now(),'refund',$5,$6,$7) RETURNING id`,[account.rows[0].location_id,accountId,category.rows[0]?.id||null,amount,workOrderId,reason,actor(req)]);
    const refund=await client.query(`INSERT INTO financial_refunds(location_id,work_order_id,account_id,amount,reason,status,created_by,movement_id) VALUES($1,$2,$3,$4,$5,'completed',$6,$7) RETURNING *`,[account.rows[0].location_id,workOrderId,accountId,amount,reason,actor(req),movement.rows[0].id]);
    await client.query("COMMIT"); res.status(201).json(refund.rows[0]);
  } catch(err:any){await client.query("ROLLBACK");if(String(err?.message).includes("nem található")) return res.status(400).json({message:err.message});next(err);} finally{client.release();}
});

router.get("/transfers", async (req: AuthRequest, res, next) => {
  try { const {rows}=await db.query(`SELECT t.*,s.name source_account_name,d.name destination_account_name FROM financial_transfers t JOIN financial_accounts s ON s.id=t.source_account_id JOIN financial_accounts d ON d.id=t.destination_account_id ORDER BY t.transferred_at DESC LIMIT 200`);res.json(rows); }
  catch(err){next(err);}
});

router.get("/refunds", async (req: AuthRequest, res, next) => {
  try { const {rows}=await db.query(`SELECT r.*,a.name account_name FROM financial_refunds r JOIN financial_accounts a ON a.id=r.account_id ORDER BY r.refunded_at DESC LIMIT 200`);res.json(rows); }
  catch(err){next(err);}
});

export default router;
