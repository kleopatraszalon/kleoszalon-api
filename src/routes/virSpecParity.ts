import { Router, type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import PDFDocument from "pdfkit";
import * as XLSX from "xlsx";
import pool from "../db";
import type { AuthRequest } from "../middleware/auth";
import { getComplaintMailboxStatus, storeComplaintAttachment, syncComplaintMailbox } from "../services/complaintMailbox";

export const virSpecParityRouter = Router();
export const virSpecParityPublicRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024, files: 8 } });
let ensurePromise: Promise<void> | null = null;

const LEGACY_WEIGHTS = {
  black: Number(process.env.LEGACY_BLACK_POINT_WEIGHT || 1),
  red: Number(process.env.LEGACY_RED_POINT_WEIGHT || -1),
  red_x: Number(process.env.LEGACY_RED_X_WEIGHT || -3),
};

function ensureSchema(): Promise<void> {
  if (!ensurePromise) ensurePromise = pool.query(`
    CREATE TABLE IF NOT EXISTS vir_report_definitions(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, description text,
      source_key text NOT NULL, columns jsonb NOT NULL DEFAULT '[]'::jsonb, filters jsonb NOT NULL DEFAULT '{}'::jsonb,
      sort_by text, sort_dir text NOT NULL DEFAULT 'desc', default_format text NOT NULL DEFAULT 'pdf',
      is_system boolean NOT NULL DEFAULT false, active boolean NOT NULL DEFAULT true,
      created_by text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_vir_report_system_name ON vir_report_definitions(name) WHERE is_system=true;
    CREATE TABLE IF NOT EXISTS hr_legacy_points(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), employee_id uuid NOT NULL, evaluation_month date NOT NULL,
      point_type text NOT NULL CHECK(point_type IN ('red','black','red_x')), point_count integer NOT NULL DEFAULT 1,
      reason text, source text NOT NULL DEFAULT 'manager', guest_rating numeric, created_by text,
      created_at timestamptz DEFAULT now(), approved_at timestamptz
    );
    CREATE INDEX IF NOT EXISTS idx_hr_legacy_points_employee_month ON hr_legacy_points(employee_id,evaluation_month);
    CREATE TABLE IF NOT EXISTS guest_reviews(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), employee_id uuid, location_id text, client_name text,
      rating integer NOT NULL CHECK(rating BETWEEN 1 AND 5), review_text text, source text NOT NULL DEFAULT 'tablet',
      moderation_status text NOT NULL DEFAULT 'pending', moderator_id text, moderated_at timestamptz,
      facebook_campaign_id uuid, created_at timestamptz DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_guest_reviews_moderation ON guest_reviews(moderation_status,created_at DESC);
    CREATE TABLE IF NOT EXISTS vir_documents(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text NOT NULL, slug text NOT NULL UNIQUE,
      content_html text NOT NULL DEFAULT '', content_text text NOT NULL DEFAULT '', toc jsonb NOT NULL DEFAULT '[]'::jsonb,
      status text NOT NULL DEFAULT 'draft', version integer NOT NULL DEFAULT 1, created_by text, updated_by text,
      created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), published_at timestamptz
    );
    CREATE TABLE IF NOT EXISTS vir_document_versions(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), document_id uuid NOT NULL REFERENCES vir_documents(id) ON DELETE CASCADE,
      version integer NOT NULL, title text NOT NULL, content_html text NOT NULL, content_text text NOT NULL,
      toc jsonb NOT NULL DEFAULT '[]'::jsonb, created_by text, created_at timestamptz DEFAULT now(),
      UNIQUE(document_id,version)
    );
    CREATE TABLE IF NOT EXISTS release_manual_signoffs(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), release_ref text NOT NULL, environment text NOT NULL DEFAULT 'production',
      tester_name text NOT NULL, checklist jsonb NOT NULL DEFAULT '{}'::jsonb, result text NOT NULL,
      notes text, created_by text, created_at timestamptz DEFAULT now()
    );
  `).then(async () => {
    const seeds = [
      ["Panaszok és SLA", "Beérkezett panaszok, határidők és státuszok", "complaints", ["title","sender_email","status","priority","due_at","created_at"], "due_at"],
      ["Dolgozói értékelés – 2018 logika", "Piros/fekete pontok és piros X havi bontásban", "hr_legacy", ["employee_id","evaluation_month","point_type","point_count","reason","source","created_at"], "evaluation_month"],
      ["Vendégértékelések és moderáció", "Tabletes vendégértékelések Facebook moderációval", "guest_reviews", ["rating","client_name","review_text","moderation_status","location_id","created_at"], "created_at"],
      ["Dokumentumtár verziólista", "Elektronikus dokumentumszerkesztő dokumentumai", "documents", ["title","slug","status","version","updated_at","published_at"], "updated_at"],
    ];
    for (const [name, description, sourceKey, columns, sortBy] of seeds as any[]) {
      await pool.query(`INSERT INTO vir_report_definitions(name,description,source_key,columns,sort_by,is_system)
        SELECT $1,$2,$3,$4::jsonb,$5,true WHERE NOT EXISTS(SELECT 1 FROM vir_report_definitions WHERE name=$1 AND is_system=true)`,
        [name, description, sourceKey, JSON.stringify(columns), sortBy]);
    }
  }).then(() => undefined).catch((error) => { ensurePromise = null; throw error; });
  return ensurePromise;
}

virSpecParityRouter.use(async (_req, _res, next) => { try { await ensureSchema(); next(); } catch (error) { next(error); } });
virSpecParityPublicRouter.use(async (_req, _res, next) => { try { await ensureSchema(); next(); } catch (error) { next(error); } });

function userKey(req: AuthRequest): string { return String(req.user?.email || req.user?.id || "system"); }
function cleanText(value: unknown, max = 5000): string { return String(value ?? "").replace(/\u0000/g, "").trim().slice(0, max); }
function slugify(value: string): string { return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 120) || `dokumentum-${Date.now()}`; }
function stripHtml(html: string): string { return html.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<br\s*\/?\s*>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi," ").replace(/&amp;/gi,"&").replace(/[ \t]+/g," ").replace(/\n{3,}/g,"\n\n").trim(); }
function sanitizeHtml(html: string): string {
  return String(html || "")
    .replace(/<\s*(script|iframe|object|embed|link|meta)[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\s*(script|iframe|object|embed|link|meta)\b[^>]*\/?>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/javascript\s*:/gi, "");
}
function buildToc(html: string): Array<{ level: number; title: string; id: string }> {
  const toc: Array<{ level: number; title: string; id: string }> = [];
  const seen = new Map<string, number>();
  html.replace(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_full, lvl, body) => {
    const title = stripHtml(body).trim(); if (!title) return "";
    const base = slugify(title); const count = (seen.get(base) || 0) + 1; seen.set(base, count);
    toc.push({ level: Number(lvl), title, id: count === 1 ? base : `${base}-${count}` }); return "";
  });
  return toc;
}

virSpecParityRouter.get("/overview", async (_req, res, next) => {
  try {
    const [complaints, reviews, docs, releases] = await Promise.all([
      pool.query(`SELECT count(*)::int total,count(*) FILTER(WHERE status NOT IN ('closed','resolved'))::int open,count(*) FILTER(WHERE due_at<now() AND status NOT IN ('closed','resolved'))::int overdue FROM operations_quality_records WHERE module_key='complaints'`).then(r=>r.rows[0]).catch(()=>({total:0,open:0,overdue:0})),
      pool.query(`SELECT count(*)::int total,count(*) FILTER(WHERE moderation_status='pending')::int pending FROM guest_reviews`).then(r=>r.rows[0]),
      pool.query(`SELECT count(*)::int total,count(*) FILTER(WHERE status='published')::int published FROM vir_documents`).then(r=>r.rows[0]),
      pool.query(`SELECT * FROM release_manual_signoffs ORDER BY created_at DESC LIMIT 5`).then(r=>r.rows),
    ]);
    const instanceCount = Number(process.env.RENDER_INSTANCE_COUNT || process.env.WEB_CONCURRENCY || 1);
    const ha = {
      instance_count: instanceCount,
      database_ha_enabled: process.env.DATABASE_HA_ENABLED === "1",
      stateless_attachments: true,
      ready_for_single_instance_failure: instanceCount >= 2 && process.env.DATABASE_HA_ENABLED === "1",
      note: "A tényleges HA-hoz a hosting oldali többpéldányosítás és adatbázis-redundancia is szükséges.",
    };
    res.json({ mailbox: getComplaintMailboxStatus(), complaints, reviews, documents: docs, ha, release_signoffs: releases, legacy_weights: LEGACY_WEIGHTS });
  } catch (error) { next(error); }
});

virSpecParityRouter.get("/mailbox", (_req, res) => res.json(getComplaintMailboxStatus()));
virSpecParityRouter.post("/complaints/sync", async (_req, res, next) => { try { res.json(await syncComplaintMailbox()); } catch (error) { next(error); } });
virSpecParityRouter.get("/complaints", async (_req, res, next) => {
  try {
    const r = await pool.query(`SELECT q.*,COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a.id,'filename',a.filename,'content_type',a.content_type,'byte_size',a.byte_size,'source',a.source,'created_at',a.created_at) ORDER BY a.created_at) FROM complaint_attachments a WHERE a.complaint_id=q.id),'[]'::jsonb) attachments FROM operations_quality_records q WHERE q.module_key='complaints' ORDER BY q.created_at DESC LIMIT 300`);
    res.json(r.rows);
  } catch (error) { next(error); }
});
virSpecParityRouter.post("/complaints/:id/attachments", upload.array("files", 8), async (req, res, next) => {
  try {
    const exists = await pool.query(`SELECT id FROM operations_quality_records WHERE id=$1 AND module_key='complaints'`, [req.params.id]);
    if (!exists.rowCount) return res.status(404).json({ message: "Panasz nem található." });
    const files = (req.files as Express.Multer.File[] || []);
    if (!files.length) return res.status(400).json({ message: "Nincs csatolt fájl." });
    const out = [];
    for (const file of files) out.push(await storeComplaintAttachment(req.params.id, { filename: file.originalname, contentType: file.mimetype, content: file.buffer }));
    res.status(201).json(out);
  } catch (error) { next(error); }
});
virSpecParityRouter.get("/complaint-attachments/:id", async (req, res, next) => {
  try {
    const r = await pool.query(`SELECT filename,content_type,content FROM complaint_attachments WHERE id=$1`, [req.params.id]);
    const row = r.rows[0]; if (!row) return res.status(404).json({ message: "Csatolmány nem található." });
    const safe = String(row.filename || "attachment.bin").replace(/[\r\n"]/g, "_");
    res.setHeader("Content-Type", row.content_type || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(safe)}`);
    res.send(row.content);
  } catch (error) { next(error); }
});

const REPORT_SOURCES = ["complaints","hr_modern","hr_legacy","guest_reviews","documents"] as const;
type ReportSource = typeof REPORT_SOURCES[number];
async function reportRows(source: ReportSource): Promise<any[]> {
  if (source === "complaints") return (await pool.query(`SELECT id,title,description,status,priority,due_at,created_at,assignee,metadata->>'source' source,metadata->>'sender_email' sender_email FROM operations_quality_records WHERE module_key='complaints' ORDER BY created_at DESC LIMIT 5000`)).rows;
  if (source === "hr_modern") return (await pool.query(`SELECT id,employee_id,period_start,period_end,status,professional_score,guest_score,sales_score,teamwork_score,hygiene_score,attendance_score,overall_score,approved_at,created_at FROM hr_employee_evaluations ORDER BY period_start DESC,created_at DESC LIMIT 5000`)).rows;
  if (source === "hr_legacy") return (await pool.query(`SELECT id,employee_id,evaluation_month,point_type,point_count,reason,source,guest_rating,approved_at,created_at FROM hr_legacy_points ORDER BY evaluation_month DESC,created_at DESC LIMIT 5000`)).rows;
  if (source === "guest_reviews") return (await pool.query(`SELECT id,employee_id,location_id,client_name,rating,review_text,source,moderation_status,moderated_at,created_at FROM guest_reviews ORDER BY created_at DESC LIMIT 5000`)).rows;
  return (await pool.query(`SELECT id,title,slug,status,version,created_by,updated_by,created_at,updated_at,published_at FROM vir_documents ORDER BY updated_at DESC LIMIT 5000`)).rows;
}
function filterRows(rows: any[], filters: Record<string, unknown>): any[] {
  const entries = Object.entries(filters || {}).filter(([,v]) => v !== "" && v != null);
  if (!entries.length) return rows;
  return rows.filter((row) => entries.every(([key,value]) => String(row[key] ?? "").toLowerCase().includes(String(value).toLowerCase())));
}
function projectRows(rows: any[], columns: string[]): any[] {
  if (!columns.length) return rows;
  return rows.map((row) => Object.fromEntries(columns.filter((key) => Object.prototype.hasOwnProperty.call(row,key)).map((key)=>[key,row[key]])));
}
function sortRows(rows: any[], key: string | null, dir: string): any[] {
  if (!key) return rows;
  const sign = String(dir).toLowerCase() === "asc" ? 1 : -1;
  return [...rows].sort((a,b)=>String(a[key]??"").localeCompare(String(b[key]??""),"hu",{numeric:true})*sign);
}
function genericPdf(title: string, rows: any[]): Promise<Buffer> {
  return new Promise((resolve,reject)=>{
    const doc = new PDFDocument({ size:"A4",margin:34 }); const chunks: Buffer[]=[];
    doc.on("data",c=>chunks.push(Buffer.from(c))); doc.on("end",()=>resolve(Buffer.concat(chunks))); doc.on("error",reject);
    doc.fontSize(18).text(title); doc.fontSize(9).fillColor("#666").text(`Generálva: ${new Date().toLocaleString("hu-HU")}`); doc.moveDown(); doc.fillColor("#000");
    rows.slice(0,1000).forEach((row,i)=>{ const line=Object.entries(row).map(([k,v])=>`${k}: ${v==null?"":typeof v==="object"?JSON.stringify(v):String(v)}`).join(" | "); doc.fontSize(8).text(`${i+1}. ${line}`,{width:525}); doc.moveDown(0.2); });
    if(rows.length>1000)doc.fontSize(9).text(`A PDF az első 1000 sort tartalmazza. Teljes exporthoz Excel formátumot használjon. Összes sor: ${rows.length}.`); doc.end();
  });
}
virSpecParityRouter.get("/reports", async (_req,res,next)=>{try{const defs=(await pool.query(`SELECT * FROM vir_report_definitions ORDER BY is_system DESC,name`)).rows;res.json({definitions:defs,sources:REPORT_SOURCES})}catch(e){next(e)}});
virSpecParityRouter.post("/reports", async (req:AuthRequest,res,next)=>{try{
  const source=String(req.body?.source_key||"") as ReportSource;if(!REPORT_SOURCES.includes(source))return res.status(400).json({message:"Nem engedélyezett adatforrás."});
  const r=await pool.query(`INSERT INTO vir_report_definitions(name,description,source_key,columns,filters,sort_by,sort_dir,default_format,created_by) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9) RETURNING *`,[
    cleanText(req.body?.name,200),cleanText(req.body?.description,1000),source,JSON.stringify(Array.isArray(req.body?.columns)?req.body.columns:[]),JSON.stringify(req.body?.filters||{}),cleanText(req.body?.sort_by,100)||null,String(req.body?.sort_dir)==="asc"?"asc":"desc",String(req.body?.default_format)==="xlsx"?"xlsx":"pdf",userKey(req)]);res.status(201).json(r.rows[0]);
}catch(e){next(e)}});
virSpecParityRouter.patch("/reports/:id", async (req,res,next)=>{try{
  const old=(await pool.query(`SELECT * FROM vir_report_definitions WHERE id=$1`,[req.params.id])).rows[0];if(!old)return res.status(404).json({message:"Riport nem található."});
  const source=String(req.body?.source_key??old.source_key) as ReportSource;if(!REPORT_SOURCES.includes(source))return res.status(400).json({message:"Nem engedélyezett adatforrás."});
  const r=await pool.query(`UPDATE vir_report_definitions SET name=$2,description=$3,source_key=$4,columns=$5::jsonb,filters=$6::jsonb,sort_by=$7,sort_dir=$8,default_format=$9,active=$10,updated_at=now() WHERE id=$1 RETURNING *`,[
    req.params.id,cleanText(req.body?.name??old.name,200),cleanText(req.body?.description??old.description,1000),source,JSON.stringify(req.body?.columns??old.columns??[]),JSON.stringify(req.body?.filters??old.filters??{}),cleanText(req.body?.sort_by??old.sort_by,100)||null,String(req.body?.sort_dir??old.sort_dir)==="asc"?"asc":"desc",String(req.body?.default_format??old.default_format)==="xlsx"?"xlsx":"pdf",req.body?.active!==false]);res.json(r.rows[0]);
}catch(e){next(e)}});
virSpecParityRouter.get("/reports/:id/export", async (req,res,next)=>{try{
  const def=(await pool.query(`SELECT * FROM vir_report_definitions WHERE id=$1 AND active=true`,[req.params.id])).rows[0];if(!def)return res.status(404).json({message:"Riport nem található."});
  const source=String(def.source_key) as ReportSource;if(!REPORT_SOURCES.includes(source))return res.status(400).json({message:"Nem engedélyezett adatforrás."});
  let rows=await reportRows(source);rows=filterRows(rows,def.filters||{});rows=sortRows(rows,def.sort_by||null,def.sort_dir);rows=projectRows(rows,Array.isArray(def.columns)?def.columns:[]);
  const format=String(req.query.format||def.default_format||"pdf").toLowerCase();const base=slugify(def.name)||"vir-report";
  if(format==="xlsx"){const wb=XLSX.utils.book_new(),ws=XLSX.utils.json_to_sheet(rows);XLSX.utils.book_append_sheet(wb,ws,"Riport");const buf=XLSX.write(wb,{type:"buffer",bookType:"xlsx"}) as Buffer;res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");res.setHeader("Content-Disposition",`attachment; filename=${base}.xlsx`);return res.send(buf)}
  const pdf=await genericPdf(def.name,rows);res.setHeader("Content-Type","application/pdf");res.setHeader("Content-Disposition",`attachment; filename=${base}.pdf`);res.send(pdf);
}catch(e){next(e)}});

virSpecParityRouter.get("/legacy-evaluations", async (req,res,next)=>{try{
  const year=Math.max(2000,Math.min(2100,Number(req.query.year)||new Date().getFullYear()));
  const detail=(await pool.query(`SELECT * FROM hr_legacy_points WHERE evaluation_month>=make_date($1,1,1) AND evaluation_month<make_date($1+1,1,1) ORDER BY evaluation_month,created_at`,[year])).rows;
  const summary=(await pool.query(`SELECT employee_id,extract(month from evaluation_month)::int month,sum(point_count) FILTER(WHERE point_type='black')::int black_points,sum(point_count) FILTER(WHERE point_type='red')::int red_points,sum(point_count) FILTER(WHERE point_type='red_x')::int red_x,count(*)::int entries FROM hr_legacy_points WHERE evaluation_month>=make_date($1,1,1) AND evaluation_month<make_date($1+1,1,1) GROUP BY employee_id,extract(month from evaluation_month) ORDER BY employee_id,month`,[year])).rows.map(row=>({...row,score:Number(row.black_points||0)*LEGACY_WEIGHTS.black+Number(row.red_points||0)*LEGACY_WEIGHTS.red+Number(row.red_x||0)*LEGACY_WEIGHTS.red_x}));
  const guest=(await pool.query(`SELECT employee_id,extract(month from created_at)::int month,round(avg(rating)::numeric,2) guest_rating,count(*)::int guest_ratings FROM guest_reviews WHERE employee_id IS NOT NULL AND created_at>=make_date($1,1,1) AND created_at<make_date($1+1,1,1) GROUP BY employee_id,extract(month from created_at)`,[year])).rows;
  res.json({year,weights:LEGACY_WEIGHTS,detail,monthly_summary:summary,guest_summary:guest});
}catch(e){next(e)}});
virSpecParityRouter.post("/legacy-evaluations/points", async (req:AuthRequest,res,next)=>{try{
  const type=String(req.body?.point_type||"");if(!["red","black","red_x"].includes(type))return res.status(400).json({message:"point_type: red, black vagy red_x lehet."});
  const month=/^\d{4}-\d{2}/.test(String(req.body?.evaluation_month||""))?`${String(req.body.evaluation_month).slice(0,7)}-01`:new Date().toISOString().slice(0,7)+"-01";
  const r=await pool.query(`INSERT INTO hr_legacy_points(employee_id,evaluation_month,point_type,point_count,reason,source,created_by,approved_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()) RETURNING *`,[req.body?.employee_id,month,type,Math.max(1,Math.min(100,Number(req.body?.point_count)||1)),cleanText(req.body?.reason,2000),cleanText(req.body?.source||"manager",100),userKey(req)]);res.status(201).json(r.rows[0]);
}catch(e){next(e)}});
virSpecParityRouter.delete("/legacy-evaluations/points/:id", async (req,res,next)=>{try{await pool.query(`DELETE FROM hr_legacy_points WHERE id=$1`,[req.params.id]);res.status(204).end()}catch(e){next(e)}});

function tabletTokenOk(req: Request): boolean { const expected=String(process.env.GUEST_REVIEW_TABLET_TOKEN||"").trim();if(!expected)return true;return String(req.headers["x-tablet-token"]||req.query.token||"")===expected; }
virSpecParityPublicRouter.post("/reviews", async (req,res,next)=>{try{
  if(!tabletTokenOk(req))return res.status(403).json({message:"Érvénytelen tablet token."});const rating=Number(req.body?.rating);if(!Number.isInteger(rating)||rating<1||rating>5)return res.status(400).json({message:"Az értékelés 1 és 5 közötti egész szám legyen."});
  const r=await pool.query(`INSERT INTO guest_reviews(employee_id,location_id,client_name,rating,review_text,source) VALUES($1,$2,$3,$4,$5,'tablet') RETURNING id,rating,moderation_status,created_at`,[req.body?.employee_id||null,cleanText(req.body?.location_id,100)||null,cleanText(req.body?.client_name,200)||null,rating,cleanText(req.body?.review_text,4000)||null]);res.status(201).json({ok:true,review:r.rows[0],message:"Köszönjük az értékelést! A nyilvános megjelenés előtt moderációra kerül."});
}catch(e){next(e)}});
virSpecParityRouter.get("/review-moderation", async (_req,res,next)=>{try{res.json((await pool.query(`SELECT * FROM guest_reviews ORDER BY CASE moderation_status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,created_at DESC LIMIT 500`)).rows)}catch(e){next(e)}});
virSpecParityRouter.post("/review-moderation/:id/approve", async (req:AuthRequest,res,next)=>{const c=await pool.connect();try{
  await c.query("BEGIN");const review=(await c.query(`SELECT * FROM guest_reviews WHERE id=$1 FOR UPDATE`,[req.params.id])).rows[0];if(!review){await c.query("ROLLBACK");return res.status(404).json({message:"Értékelés nem található."})}
  if(review.moderation_status==="approved"&&review.facebook_campaign_id){await c.query("COMMIT");return res.json(review)}
  const headline=`Vendégünk értékelése: ${review.rating}/5`;const description=review.review_text||"Köszönjük vendégünk visszajelzését!";const campaign=await c.query(`INSERT INTO social_campaigns(source_type,source_id,name,headline,description,platform_payloads,status,created_by) VALUES('guest_review',$1,$2,$3,$4,$5::jsonb,'draft',$6) RETURNING id`,[review.id,headline,headline,description,JSON.stringify({facebook:{caption:`${headline}\n\n${description}`}}),userKey(req)]);
  await c.query(`INSERT INTO social_publications(campaign_id,platform,payload,status,scheduled_at) VALUES($1,'facebook',$2::jsonb,$3,CASE WHEN $3='scheduled' THEN now() ELSE NULL END) ON CONFLICT(campaign_id,platform) DO NOTHING`,[campaign.rows[0].id,JSON.stringify({caption:`${headline}\n\n${description}`}),req.body?.publish_now?"scheduled":"draft"]);
  const updated=(await c.query(`UPDATE guest_reviews SET moderation_status='approved',moderator_id=$2,moderated_at=now(),facebook_campaign_id=$3 WHERE id=$1 RETURNING *`,[review.id,userKey(req),campaign.rows[0].id])).rows[0];await c.query("COMMIT");res.json(updated);
}catch(e){await c.query("ROLLBACK");next(e)}finally{c.release()}});
virSpecParityRouter.post("/review-moderation/:id/reject", async (req:AuthRequest,res,next)=>{try{const r=await pool.query(`UPDATE guest_reviews SET moderation_status='rejected',moderator_id=$2,moderated_at=now() WHERE id=$1 RETURNING *`,[req.params.id,userKey(req)]);if(!r.rowCount)return res.status(404).json({message:"Értékelés nem található."});res.json(r.rows[0])}catch(e){next(e)}});

virSpecParityRouter.get("/documents", async (_req,res,next)=>{try{res.json((await pool.query(`SELECT id,title,slug,status,version,toc,created_by,updated_by,created_at,updated_at,published_at FROM vir_documents ORDER BY updated_at DESC`)).rows)}catch(e){next(e)}});
virSpecParityRouter.get("/documents/:id", async (req,res,next)=>{try{const doc=(await pool.query(`SELECT * FROM vir_documents WHERE id=$1`,[req.params.id])).rows[0];if(!doc)return res.status(404).json({message:"Dokumentum nem található."});const versions=(await pool.query(`SELECT id,version,title,created_by,created_at FROM vir_document_versions WHERE document_id=$1 ORDER BY version DESC`,[req.params.id])).rows;res.json({...doc,versions})}catch(e){next(e)}});
virSpecParityRouter.post("/documents", async (req:AuthRequest,res,next)=>{try{const title=cleanText(req.body?.title,300);if(!title)return res.status(400).json({message:"A cím kötelező."});const html=sanitizeHtml(String(req.body?.content_html||"")),toc=buildToc(html),text=stripHtml(html),slug=slugify(cleanText(req.body?.slug||title,200));const r=await pool.query(`INSERT INTO vir_documents(title,slug,content_html,content_text,toc,created_by,updated_by) VALUES($1,$2,$3,$4,$5::jsonb,$6,$6) RETURNING *`,[title,slug,html,text,JSON.stringify(toc),userKey(req)]);await pool.query(`INSERT INTO vir_document_versions(document_id,version,title,content_html,content_text,toc,created_by) VALUES($1,1,$2,$3,$4,$5::jsonb,$6)`,[r.rows[0].id,title,html,text,JSON.stringify(toc),userKey(req)]);res.status(201).json(r.rows[0])}catch(e:any){if(e?.code==="23505")return res.status(409).json({message:"Ez a dokumentum-azonosító már létezik."});next(e)}});
virSpecParityRouter.patch("/documents/:id", async (req:AuthRequest,res,next)=>{const c=await pool.connect();try{await c.query("BEGIN");const old=(await c.query(`SELECT * FROM vir_documents WHERE id=$1 FOR UPDATE`,[req.params.id])).rows[0];if(!old){await c.query("ROLLBACK");return res.status(404).json({message:"Dokumentum nem található."})}const title=cleanText(req.body?.title??old.title,300),html=sanitizeHtml(String(req.body?.content_html??old.content_html)),toc=buildToc(html),text=stripHtml(html),version=Number(old.version)+1,status=String(req.body?.status??old.status)==="published"?"published":"draft";const r=await c.query(`UPDATE vir_documents SET title=$2,content_html=$3,content_text=$4,toc=$5::jsonb,status=$6,version=$7,updated_by=$8,updated_at=now(),published_at=CASE WHEN $6='published' THEN COALESCE(published_at,now()) ELSE published_at END WHERE id=$1 RETURNING *`,[req.params.id,title,html,text,JSON.stringify(toc),status,version,userKey(req)]);await c.query(`INSERT INTO vir_document_versions(document_id,version,title,content_html,content_text,toc,created_by) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)`,[req.params.id,version,title,html,text,JSON.stringify(toc),userKey(req)]);await c.query("COMMIT");res.json(r.rows[0])}catch(e){await c.query("ROLLBACK");next(e)}finally{c.release()}});

virSpecParityRouter.get("/release-gate", async (_req,res,next)=>{try{res.json({required:["unit","integration","e2e","automated_smoke","manual_uat"],manual_rule:"Production kiadás csak sikeres automata kapuk és dokumentált manuális UAT után engedélyezhető.",signoffs:(await pool.query(`SELECT * FROM release_manual_signoffs ORDER BY created_at DESC LIMIT 100`)).rows})}catch(e){next(e)}});
virSpecParityRouter.post("/release-gate/signoffs", async (req:AuthRequest,res,next)=>{try{const result=String(req.body?.result||"");if(!["pass","fail"].includes(result))return res.status(400).json({message:"result: pass vagy fail lehet."});const tester=cleanText(req.body?.tester_name,200);if(!tester)return res.status(400).json({message:"A tesztelő neve kötelező."});const r=await pool.query(`INSERT INTO release_manual_signoffs(release_ref,environment,tester_name,checklist,result,notes,created_by) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7) RETURNING *`,[cleanText(req.body?.release_ref,200),cleanText(req.body?.environment||"production",100),tester,JSON.stringify(req.body?.checklist||{}),result,cleanText(req.body?.notes,4000),userKey(req)]);res.status(201).json(r.rows[0])}catch(e){next(e)}});

export default virSpecParityRouter;
