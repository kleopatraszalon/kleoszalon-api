import { Router } from "express";
import db from "../db";
import { AuthRequest } from "../middleware/auth";

const router = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SCORE_FIELDS = ["professional_score", "guest_score", "sales_score", "teamwork_score", "hygiene_score", "attendance_score"];

async function ensure() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS hr_job_openings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), position_name text NOT NULL, description text, requirements text, status text NOT NULL DEFAULT 'draft', created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
    CREATE TABLE IF NOT EXISTS hr_candidates (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid REFERENCES hr_job_openings(id), full_name text NOT NULL, email text, phone text, source text, cv_url text, stage text DEFAULT 'new', interview_at timestamptz, trial_day_at timestamptz, rating numeric, notes text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
    CREATE TABLE IF NOT EXISTS hr_training_courses (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text NOT NULL, role_key text NOT NULL, category text NOT NULL, provider text, source_url text, description text, duration_hours numeric, mandatory boolean DEFAULT false, active boolean DEFAULT true);
    CREATE UNIQUE INDEX IF NOT EXISTS hr_training_course_uq ON hr_training_courses ((lower(title)), role_key);
    CREATE TABLE IF NOT EXISTS hr_training_enrollments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), course_id uuid REFERENCES hr_training_courses(id), employee_id uuid NOT NULL, scheduled_at timestamptz, due_date date, completed_at timestamptz, status text DEFAULT 'planned', score numeric, certificate_url text, notes text);
    CREATE TABLE IF NOT EXISTS hr_employee_evaluations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), employee_id uuid NOT NULL, evaluator_id uuid, period_start date NOT NULL, period_end date NOT NULL, status text DEFAULT 'draft', professional_score numeric DEFAULT 0, guest_score numeric DEFAULT 0, sales_score numeric DEFAULT 0, teamwork_score numeric DEFAULT 0, hygiene_score numeric DEFAULT 0, attendance_score numeric DEFAULT 0, overall_score numeric DEFAULT 0, strengths text, development_goals text, manager_comment text, employee_comment text, approved_at timestamptz, created_at timestamptz DEFAULT now());
    ALTER TABLE hr_candidates ADD COLUMN IF NOT EXISTS cv_url text;
    ALTER TABLE hr_candidates ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
    ALTER TABLE hr_employee_evaluations ADD COLUMN IF NOT EXISTS employee_comment text;
    ALTER TABLE hr_employee_evaluations ADD COLUMN IF NOT EXISTS approved_at timestamptz;
    INSERT INTO hr_training_courses(title,role_key,category,provider,source_url,description,duration_hours,mandatory) VALUES
      ('Vezetői coaching és visszajelzés','manager','vezetői','HubSpot Academy','https://academy.hubspot.com/courses/sales-manager-training-program','Célkitűzés, onboarding, coaching és teljesítményértékelés.',6,false),
      ('Ügyfélélmény és panaszkezelés','receptionist','ügyfélkezelés','HubSpot Academy','https://academy.hubspot.com/learning-paths/customer-service-manager','Fogadás, reklamációkezelés, vendég-visszajelzés és utánkövetés.',4,true),
      ('Fodrászati munka- és egészségvédelem','hairdresser','munkavédelem','EU-OSHA','https://osha.europa.eu/en/legislation/guidelines/non-binding-guidelines-hairdressing-sector','Bőr-, légúti, zaj- és mozgásszervi kockázatok megelőzése.',3,true),
      ('Professzionális hajszín és színkorrekció','hairdresser','szakmai','Wella Education','https://education.wella.com/','Színelmélet, formulázás, konzultáció és korrekció.',8,false),
      ('Higiénia, fertőtlenítés és kontraindikációk','beautician','munkavédelem','KLEO Academy',NULL,'Bőrállapot-felmérés, fertőtlenítés és kezelési kizáró okok.',4,true),
      ('Kéz- és lábápolási higiénia','nail_technician','munkavédelem','KLEO Academy',NULL,'Fertőzésmegelőzés, eszközbiztonság és vendégkonzultáció.',4,true),
      ('Masszázs kontraindikációk és ergonómia','masseur','szakmai','KLEO Academy',NULL,'Biztonságos kezelés, anamnézis és kímélő testtartás.',6,true),
      ('Oktatásmódszertan és mentorálás','trainer','vezetői','KLEO Academy',NULL,'Felnőttképzési alapok, gyakorlati bemutató és visszamérés.',6,false),
      ('Etikus szolgáltatás- és termékajánlás','all','értékesítés','HubSpot Academy','https://academy.hubspot.com/','Igényfelmérés, kapcsolódó szolgáltatás és tisztességes keresztértékesítés.',4,false),
      ('Adatvédelem és vendégadat-kezelés','all','megfelelőség','KLEO Academy',NULL,'Hozzájárulás, adatminimalizálás és bizalmas kezelés.',2,true),
      ('Készlet, pénztár és munkalapfolyamat','salon_manager','üzemeltetés','KLEO Academy',NULL,'Napi zárás, eltéréskezelés, jóváhagyás és kontroll.',5,true)
    ON CONFLICT DO NOTHING;
  `);
}

router.use(async (_req, _res, next) => { try { await ensure(); next(); } catch (error) { next(error); } });

router.get("/overview", async (_req, res, next) => { try {
  const [employees, jobs, candidates, courses, evaluations, enrollments] = await Promise.all([
    db.query(`SELECT e.id, COALESCE(NULLIF(to_jsonb(e)->>'full_name',''),NULLIF(to_jsonb(e)->>'name',''),'Munkatárs') name, COALESCE(NULLIF(to_jsonb(e)->>'position_name',''),NULLIF(to_jsonb(e)->>'job_title',''),'Munkatárs') position_name FROM employees e WHERE COALESCE((to_jsonb(e)->>'is_active')::boolean,true) ORDER BY 2`),
    db.query(`SELECT * FROM hr_job_openings ORDER BY created_at DESC`),
    db.query(`SELECT c.*,j.position_name FROM hr_candidates c LEFT JOIN hr_job_openings j ON j.id=c.job_id ORDER BY c.created_at DESC`),
    db.query(`SELECT * FROM hr_training_courses WHERE active ORDER BY mandatory DESC,role_key,title`),
    db.query(`SELECT v.*,COALESCE(NULLIF(to_jsonb(e)->>'full_name',''),NULLIF(to_jsonb(e)->>'name',''),'Munkatárs') employee_name FROM hr_employee_evaluations v LEFT JOIN employees e ON e.id=v.employee_id ORDER BY v.period_end DESC`),
    db.query(`SELECT x.*,c.title,COALESCE(NULLIF(to_jsonb(e)->>'full_name',''),NULLIF(to_jsonb(e)->>'name',''),'Munkatárs') employee_name FROM hr_training_enrollments x JOIN hr_training_courses c ON c.id=x.course_id LEFT JOIN employees e ON e.id=x.employee_id ORDER BY x.due_date NULLS LAST`)
  ]);
  res.json({ employees: employees.rows, jobs: jobs.rows, candidates: candidates.rows, courses: courses.rows, evaluations: evaluations.rows, enrollments: enrollments.rows });
} catch (error) { next(error); } });

router.post("/jobs", async (req, res, next) => { try { const b=req.body; if(!b.position_name?.trim()) return res.status(400).json({message:"A munkakör megadása kötelező."}); res.status(201).json((await db.query(`INSERT INTO hr_job_openings(position_name,description,requirements,status) VALUES($1,$2,$3,$4) RETURNING *`,[b.position_name.trim(),b.description||null,b.requirements||null,b.status||"draft"])).rows[0]); } catch(error){next(error);} });
router.post("/candidates", async (req, res, next) => { try { const b=req.body; if(!b.full_name?.trim()) return res.status(400).json({message:"A jelentkező neve kötelező."}); res.status(201).json((await db.query(`INSERT INTO hr_candidates(job_id,full_name,email,phone,source,cv_url,stage,interview_at,trial_day_at,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[b.job_id||null,b.full_name.trim(),b.email||null,b.phone||null,b.source||null,b.cv_url||null,b.stage||"new",b.interview_at||null,b.trial_day_at||null,b.notes||null])).rows[0]); } catch(error){next(error);} });
router.patch("/candidates/:id", async (req,res,next)=>{try{const b=req.body,row=(await db.query(`UPDATE hr_candidates SET stage=COALESCE($2,stage),rating=COALESCE($3,rating),notes=COALESCE($4,notes),interview_at=COALESCE($5,interview_at),trial_day_at=COALESCE($6,trial_day_at),updated_at=now() WHERE id=$1 RETURNING *`,[req.params.id,b.stage||null,b.rating??null,b.notes??null,b.interview_at||null,b.trial_day_at||null])).rows[0];if(!row)return res.status(404).json({message:"A jelentkező nem található."});res.json(row);}catch(error){next(error);}});
router.post("/courses",async(req,res,next)=>{try{const b=req.body;if(!b.title?.trim())return res.status(400).json({message:"A képzés neve kötelező."});res.status(201).json((await db.query(`INSERT INTO hr_training_courses(title,role_key,category,provider,source_url,description,duration_hours,mandatory) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[b.title.trim(),b.role_key||"all",b.category||"szakmai",b.provider||null,b.source_url||null,b.description||null,b.duration_hours||null,!!b.mandatory])).rows[0]);}catch(error){next(error);}});
router.post("/enrollments",async(req,res,next)=>{try{const b=req.body;res.status(201).json((await db.query(`INSERT INTO hr_training_enrollments(course_id,employee_id,scheduled_at,due_date,status,notes) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[b.course_id,b.employee_id,b.scheduled_at||null,b.due_date||null,b.status||"planned",b.notes||null])).rows[0]);}catch(error){next(error);}});
router.patch("/enrollments/:id",async(req,res,next)=>{try{const b=req.body,row=(await db.query(`UPDATE hr_training_enrollments SET status=COALESCE($2,status),score=COALESCE($3,score),certificate_url=COALESCE($4,certificate_url),completed_at=CASE WHEN $2='completed' THEN COALESCE(completed_at,now()) ELSE completed_at END WHERE id=$1 RETURNING *`,[req.params.id,b.status||null,b.score??null,b.certificate_url||null])).rows[0];if(!row)return res.status(404).json({message:"A képzési hozzárendelés nem található."});res.json(row);}catch(error){next(error);}});
router.post("/evaluations",async(req:AuthRequest,res,next)=>{try{const b=req.body;if(!b.employee_id||!b.period_start||!b.period_end)return res.status(400).json({message:"A munkatárs és az értékelési időszak kötelező."});const scores=SCORE_FIELDS.map(k=>Math.max(1,Math.min(5,Number(b[k]||1)))),overall=scores.reduce((a,v)=>a+v,0)/scores.length,evaluatorId=UUID_RE.test(String(req.user?.id||""))?req.user?.id:null;res.status(201).json((await db.query(`INSERT INTO hr_employee_evaluations(employee_id,evaluator_id,period_start,period_end,status,professional_score,guest_score,sales_score,teamwork_score,hygiene_score,attendance_score,overall_score,strengths,development_goals,manager_comment) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,[b.employee_id,evaluatorId,b.period_start,b.period_end,b.status||"draft",...scores,overall,b.strengths||null,b.development_goals||null,b.manager_comment||null])).rows[0]);}catch(error){next(error);}});
router.patch("/evaluations/:id",async(req,res,next)=>{try{const b=req.body,row=(await db.query(`UPDATE hr_employee_evaluations SET status=COALESCE($2,status),employee_comment=COALESCE($3,employee_comment),approved_at=CASE WHEN $2='approved' THEN COALESCE(approved_at,now()) ELSE approved_at END WHERE id=$1 RETURNING *`,[req.params.id,b.status||null,b.employee_comment||null])).rows[0];if(!row)return res.status(404).json({message:"Az értékelés nem található."});res.json(row);}catch(error){next(error);}});

export default router;
