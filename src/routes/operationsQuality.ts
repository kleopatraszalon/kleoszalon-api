import { Router } from "express";
import db from "../db";
import type { AuthRequest } from "../middleware/auth";
import managementImprovementRouter from "./managementImprovement";
import ensureManagementImprovementMenu from "../menu/ensureManagementImprovementMenu";
import {
  ensureLegacyEvaluation2018Schema,
  getLegacyEvaluation2018AutomationSummary,
  reconcileLegacyTaskRedX,
  startLegacyEvaluation2018Worker,
  syncLegacyTaskRedXById,
} from "../services/legacyEvaluation2018";
import {
  closeLegacyMonthlyEvaluation,
  generateLegacyMonthlyAi,
  listLegacyMonthlyEvaluations,
  prepareLegacyMonthlyEvaluations,
  startLegacyMonthlyEvaluationWorker,
  updateLegacyMonthlyManagerComment,
} from "../services/legacyEvaluationMonthly";

const router = Router();
startLegacyEvaluation2018Worker();
startLegacyMonthlyEvaluationWorker();

for (const delay of [0, 5_000, 20_000, 60_000]) {
  const timer = setTimeout(() => {
    void ensureManagementImprovementMenu().catch(error => {
      console.error("Fejlesztési projekt menü bootstrap hiba:", error?.message || error);
    });
  }, delay);
  timer.unref?.();
}

function userKey(req: AuthRequest): string {
  return String(req.user?.email || req.user?.id || "manager");
}

function serviceError(res:any,error:any) {
  const status = Number(error?.status || 500);
  return res.status(status >= 400 && status < 600 ? status : 500).json({message:String(error?.message || "A művelet sikertelen.")});
}

async function ensure() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS operations_quality_records(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),module_key text NOT NULL,title text NOT NULL,description text,
      location_name text,department text,assignee text,employee_id uuid,priority text DEFAULT 'normal',status text NOT NULL DEFAULT 'open',
      due_at timestamptz,recurrence text,requires_approval boolean DEFAULT false,approved_by text,approved_at timestamptz,completed_at timestamptz,
      metadata jsonb DEFAULT '{}'::jsonb,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS operations_quality_module_idx ON operations_quality_records(module_key,status,due_at);
    ALTER TABLE operations_quality_records ADD COLUMN IF NOT EXISTS employee_id uuid;
    ALTER TABLE operations_quality_records ADD COLUMN IF NOT EXISTS approved_by text;
    ALTER TABLE operations_quality_records ADD COLUMN IF NOT EXISTS approved_at timestamptz;
    ALTER TABLE operations_quality_records ADD COLUMN IF NOT EXISTS completed_at timestamptz;
  `);
  await ensureLegacyEvaluation2018Schema();
  await db.query(`
    INSERT INTO operations_quality_records(module_key,title,description,department,assignee,priority,status,due_at,recurrence,requires_approval,metadata)
    SELECT * FROM (VALUES
      ('tasks','Nyitás előtti higiéniai ellenőrzés','Munkafelületek, mosók, fertőtlenítők és vendégtér ellenőrzése.','Minden részleg','Délelőttös műszak','high','open',date_trunc('day',now())+interval '8 hour','naponta',true,'{"shift":"délelőtt","checklist":["felületek","eszközök","fertőtlenítő","vendégtér"]}'::jsonb),
      ('tasks','Napi zárási ellenőrzés','Pénztár, munkalapok, készleteltérések és zárási takarítás.','Recepció','Délutános műszak','high','open',date_trunc('day',now())+interval '20 hour','naponta',true,'{"shift":"délután"}'::jsonb),
      ('tasks','Heti készletszint mintavétel','Részlegenként véletlenszerű termékminta tényleges készletének rögzítése.','Raktár','Részlegvezető','normal','assigned',date_trunc('week',now())+interval '5 day 12 hour','hetente',true,'{"stock_check":true,"sample_size":10}'::jsonb),
      ('maintenance','Hajszárítók éves érintésvédelmi vizsgálata','Biztonságtechnikai felülvizsgálat és jegyzőkönyv csatolása.','Fodrászat','Műszaki partner','high','scheduled',now()+interval '21 day','évente',true,'{"asset":"Hajszárítók","warning_days":30}'::jsonb),
      ('maintenance','Kozmetikai gép időszakos szervize','Szűrők, kábelek, kezelőfejek és kalibráció ellenőrzése.','Kozmetika','Szervizpartner','normal','scheduled',now()+interval '45 day','félévente',false,'{"asset":"Kozmetikai kezelőgép","warning_days":30}'::jsonb),
      ('documents','Panaszkezelési szabályzat','Aktuális, dolgozók számára elérhető szabályzat.','Központ','Minőségügyi vezető','high','valid',now()+interval '365 day','évente',true,'{"category":"szabályzat","version":"1.0"}'::jsonb),
      ('documents','Munkavédelmi oktatási jegyzőkönyv','Éves oktatás igazolása és jelenléti íve.','Minden részleg','HR','high','expiring',now()+interval '60 day','évente',true,'{"category":"igazolás"}'::jsonb),
      ('internal-email','Havi vezetői működési összefoglaló','KPI, eltérések, panaszok és intézkedések havi összefoglalója.','Központ','Üzletvezetők','normal','draft',now()+interval '5 day','havonta',true,'{"recipient_group":"vezetők"}'::jsonb),
      ('complaints','Várakozási idő kivizsgálása','Vendégjelzés a megnövekedett várakozási idő miatt.','Recepció','Üzletvezető','high','investigating',now()+interval '2 day',NULL,true,'{"subject":"várakozás miatt","source":"személyes","sla_days":5}'::jsonb),
      ('audits','Havi szalonminőségi audit','Higiénia, vendégélmény, dokumentáció, pénztár és készlet ellenőrzése.','Minden részleg','Üzletvezető','high','planned',date_trunc('month',now())+interval '25 day','havonta',true,'{"checklist":["higiénia","vendégélmény","munkalap","pénztár","készlet"],"target_score":90}'::jsonb),
      ('incidents','Munkahelyi és szolgáltatási eltérések naplója','Baleset, eszközhiba, adatvédelmi vagy szolgáltatásminőségi eltérés rögzítése.','Minden részleg','Üzletvezető','high','open',now()+interval '1 day',NULL,true,'{"category":"minőségi eltérés","root_cause_required":true}'::jsonb)
    ) AS seed(module_key,title,description,department,assignee,priority,status,due_at,recurrence,requires_approval,metadata)
    WHERE NOT EXISTS (SELECT 1 FROM operations_quality_records LIMIT 1);
  `);
}

router.use(async (_req,_res,next) => {
  try { await ensure(); next(); } catch (error) { next(error); }
});

router.use("/improvement",managementImprovementRouter);

router.get("/employees", async (_req,res,next) => {
  try {
    const rows = (await db.query(`
      SELECT id,full_name,first_name,last_name,location_id
        FROM employees
       WHERE COALESCE(active,true)=true
       ORDER BY COALESCE(last_name,''),COALESCE(first_name,''),COALESCE(full_name,'')
    `)).rows;
    res.json(rows);
  } catch (error) { next(error); }
});

router.get("/overview", async (_req,res,next) => {
  try {
    await reconcileLegacyTaskRedX();
    const rows = (await db.query(`
      SELECT q.*,e.full_name AS employee_name
        FROM operations_quality_records q
        LEFT JOIN employees e ON e.id=q.employee_id
       ORDER BY CASE q.priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 ELSE 3 END,q.due_at NULLS LAST,q.created_at DESC
    `)).rows;
    const legacy2018 = await getLegacyEvaluation2018AutomationSummary();
    res.json({
      records: rows,
      summary: {
        open: rows.filter(x=>!["approved","resolved","archived","valid","sent"].includes(x.status)).length,
        overdue: rows.filter(x=>x.due_at&&new Date(x.due_at)<new Date()&&!["approved","resolved","archived","valid","sent"].includes(x.status)).length,
        approval: rows.filter(x=>x.requires_approval&&["completed","review","investigating"].includes(x.status)).length,
      },
      legacy2018,
    });
  } catch (error) { next(error); }
});

router.post("/records", async (req:AuthRequest,res,next) => {
  try {
    const b = req.body || {};
    if (!b.module_key || !String(b.title || "").trim()) return res.status(400).json({message:"A modul és a megnevezés kötelező."});
    let employeeId = String(b.employee_id || "").trim() || null;
    let assignee = String(b.assignee || "").trim() || null;
    if (employeeId) {
      const employee = (await db.query(`SELECT id,full_name FROM employees WHERE id=$1::uuid AND COALESCE(active,true)=true`,[employeeId])).rows[0];
      if (!employee) return res.status(400).json({message:"A kiválasztott munkatárs nem található vagy inaktív."});
      assignee = assignee || employee.full_name;
    }
    const rows = (await db.query(`
      INSERT INTO operations_quality_records(
        module_key,title,description,location_name,department,assignee,employee_id,priority,status,due_at,recurrence,requires_approval,metadata
      ) VALUES($1,$2,$3,$4,$5,$6,$7::uuid,$8,$9,$10,$11,$12,$13::jsonb) RETURNING *
    `,[b.module_key,String(b.title).trim(),b.description||null,b.location_name||null,b.department||null,assignee,employeeId,b.priority||"normal",b.status||"open",b.due_at||null,b.recurrence||null,!!b.requires_approval,JSON.stringify(b.metadata||{})])).rows;
    if (rows[0]?.module_key === "tasks") await syncLegacyTaskRedXById(String(rows[0].id));
    res.status(201).json(rows[0]);
  } catch (error) { next(error); }
});

router.patch("/records/:id", async (req:AuthRequest,res,next) => {
  try {
    const b = req.body || {};
    const current = (await db.query(`SELECT * FROM operations_quality_records WHERE id=$1::uuid`,[req.params.id])).rows[0];
    if (!current) return res.status(404).json({message:"A tétel nem található."});
    const nextStatus = b.status == null ? null : String(b.status);
    if (current.module_key === "tasks" && nextStatus === "approved" && current.requires_approval && !["completed","review","approved"].includes(String(current.status))) {
      return res.status(409).json({message:"A feladat csak azután hagyható jóvá, hogy a dolgozó elvégzettnek jelölte."});
    }
    let employeeId = b.employee_id === undefined ? null : (String(b.employee_id || "").trim() || null);
    let assignee = b.assignee == null ? null : String(b.assignee).trim();
    if (employeeId) {
      const employee = (await db.query(`SELECT id,full_name FROM employees WHERE id=$1::uuid AND COALESCE(active,true)=true`,[employeeId])).rows[0];
      if (!employee) return res.status(400).json({message:"A kiválasztott munkatárs nem található vagy inaktív."});
      if (!assignee) assignee = employee.full_name;
    }
    const rows = (await db.query(`
      UPDATE operations_quality_records SET
        status=COALESCE($2,status),
        assignee=COALESCE($3,assignee),
        description=COALESCE($4,description),
        metadata=metadata||COALESCE($5::jsonb,'{}'::jsonb),
        employee_id=CASE WHEN $6::boolean THEN $7::uuid ELSE employee_id END,
        completed_at=CASE WHEN $2='completed' THEN now() WHEN $2 IN ('open','assigned','in_progress') THEN NULL ELSE completed_at END,
        approved_by=CASE WHEN $2='approved' THEN $8 WHEN $2 IS NOT NULL AND $2<>'approved' THEN NULL ELSE approved_by END,
        approved_at=CASE WHEN $2='approved' THEN now() WHEN $2 IS NOT NULL AND $2<>'approved' THEN NULL ELSE approved_at END,
        updated_at=now()
      WHERE id=$1::uuid RETURNING *
    `,[req.params.id,nextStatus,assignee||null,b.description||null,JSON.stringify(b.metadata||{}),b.employee_id!==undefined,employeeId,userKey(req)])).rows;
    if (rows[0]?.module_key === "tasks") await syncLegacyTaskRedXById(String(rows[0].id));
    res.json(rows[0]);
  } catch (error) { next(error); }
});

router.post("/legacy-2018/reconcile", async (_req,res,next) => {
  try { res.json(await reconcileLegacyTaskRedX()); } catch (error) { next(error); }
});

router.get("/legacy-2018/monthly", async (req,res) => {
  try { res.json(await listLegacyMonthlyEvaluations(String(req.query.month || ""))); }
  catch (error:any) { return serviceError(res,error); }
});

router.post("/legacy-2018/monthly/prepare", async (req,res) => {
  try { res.json(await prepareLegacyMonthlyEvaluations(String(req.body?.month || ""))); }
  catch (error:any) { return serviceError(res,error); }
});

router.patch("/legacy-2018/monthly/:id", async (req,res) => {
  try { res.json(await updateLegacyMonthlyManagerComment(req.params.id,String(req.body?.manager_comment || ""))); }
  catch (error:any) { return serviceError(res,error); }
});

router.post("/legacy-2018/monthly/:id/ai", async (req:AuthRequest,res) => {
  try { res.json(await generateLegacyMonthlyAi(req.params.id,userKey(req))); }
  catch (error:any) { return serviceError(res,error); }
});

router.post("/legacy-2018/monthly/:id/close", async (req:AuthRequest,res) => {
  try { res.json(await closeLegacyMonthlyEvaluation(req.params.id,String(req.body?.manager_comment || ""),userKey(req))); }
  catch (error:any) { return serviceError(res,error); }
});

export default router;