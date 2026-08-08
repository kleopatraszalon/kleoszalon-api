import { Router, Response } from "express";
import pool from "../db";
import { AuthRequest, requireAuth } from "../middleware/auth";
import multer from "multer";
import * as XLSX from "xlsx";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
let schemaPromise: Promise<void> | null = null;

function ensureClientSchema() {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await pool.query(`
        ALTER TABLE clients ADD COLUMN IF NOT EXISTS full_name text;
        ALTER TABLE clients ADD COLUMN IF NOT EXISTS name text;
        ALTER TABLE clients ADD COLUMN IF NOT EXISTS phone text;
        ALTER TABLE clients ADD COLUMN IF NOT EXISTS email text;
        ALTER TABLE clients ADD COLUMN IF NOT EXISTS location_id uuid;
        ALTER TABLE clients ADD COLUMN IF NOT EXISTS birth_date date;
        ALTER TABLE clients ADD COLUMN IF NOT EXISTS gender text;
        ALTER TABLE clients ADD COLUMN IF NOT EXISTS city text;
        ALTER TABLE clients ADD COLUMN IF NOT EXISTS address text;
        ALTER TABLE clients ADD COLUMN IF NOT EXISTS notes text;
        ALTER TABLE clients ADD COLUMN IF NOT EXISTS preferred_contact text DEFAULT 'phone';
        ALTER TABLE clients ADD COLUMN IF NOT EXISTS marketing_consent boolean NOT NULL DEFAULT false;
        ALTER TABLE clients ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
        ALTER TABLE clients ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';
        ALTER TABLE clients ADD COLUMN IF NOT EXISTS altegio_spent numeric;
        ALTER TABLE clients ADD COLUMN IF NOT EXISTS altegio_paid numeric;
        ALTER TABLE clients ADD COLUMN IF NOT EXISTS altegio_visits integer;
        ALTER TABLE clients ADD COLUMN IF NOT EXISTS altegio_first_visit timestamptz;
        ALTER TABLE clients ADD COLUMN IF NOT EXISTS altegio_last_visit timestamptz;
        ALTER TABLE clients ADD COLUMN IF NOT EXISTS altegio_discount numeric;
        ALTER TABLE clients ADD COLUMN IF NOT EXISTS additional_phones text;
        ALTER TABLE clients ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
        ALTER TABLE clients ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
        UPDATE clients SET full_name=COALESCE(NULLIF(full_name,''),name,'Névtelen ügyfél'), name=COALESCE(NULLIF(name,''),full_name,'Névtelen ügyfél');

        CREATE TABLE IF NOT EXISTS crm_tags (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, color text NOT NULL DEFAULT '#7c5ce5',
          is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE UNIQUE INDEX IF NOT EXISTS crm_tags_name_uq ON crm_tags ((lower(name)));
        CREATE TABLE IF NOT EXISTS crm_client_tags (
          client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
          tag_id uuid NOT NULL REFERENCES crm_tags(id) ON DELETE CASCADE,
          created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(client_id,tag_id)
        );
        CREATE TABLE IF NOT EXISTS crm_client_notes (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
          note_text text NOT NULL, created_by text, created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS crm_forms (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text NOT NULL, description text,
          form_type text NOT NULL DEFAULT 'questionnaire', is_active boolean NOT NULL DEFAULT true,
          created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE UNIQUE INDEX IF NOT EXISTS crm_forms_title_uq ON crm_forms ((lower(title)));
        CREATE TABLE IF NOT EXISTS crm_form_responses (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(), form_id uuid NOT NULL REFERENCES crm_forms(id) ON DELETE CASCADE,
          client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE, status text NOT NULL DEFAULT 'completed',
          response_data jsonb NOT NULL DEFAULT '{}'::jsonb, completed_at timestamptz NOT NULL DEFAULT now()
        );
        INSERT INTO crm_tags(name,color) VALUES
          ('VIP','#7c5ce5'),('Új vendég','#3b82f6'),('Törzsvendég','#16a085'),('Érzékeny bőr','#ec6597'),('Visszahívandó','#e6a746')
        ON CONFLICT DO NOTHING;
        INSERT INTO crm_forms(title,description,form_type) VALUES
          ('Általános állapotfelmérő','Első kezelés előtti egészségügyi és bőrállapot-felmérés','questionnaire'),
          ('Adatkezelési nyilatkozat','Személyes és egészségügyi adatok kezelésének jóváhagyása','consent'),
          ('Fotódokumentációs hozzájárulás','Kezelés előtti és utáni képek készítésének engedélye','consent')
        ON CONFLICT DO NOTHING;
      `);
    })().catch((error) => { schemaPromise = null; throw error; });
  }
  return schemaPromise;
}

const roles = (value: unknown) => String(value || "").toLowerCase();
const effectiveLocation = (req: AuthRequest) => {
  const requested = String(req.query.location_id || req.body?.location_id || "").trim();
  return roles(req.user?.role).includes("admin") ? (requested || null) : (req.user?.location_id || null);
};
const fail = (res: Response, error: any) => {
  console.error("❌ CRM ügyfélhiba:", error);
  return res.status(500).json({ error: "Az ügyféladatok kezelése nem sikerült.", detail: error?.message || String(error), code: error?.code || null });
};

const text = (v:any) => String(v ?? "").trim();
const num = (v:any) => { if (v === null || v === undefined || v === "") return null; const n = Number(String(v).replace(/\s/g,"").replace(",",".")); return Number.isFinite(n) ? n : null; };
const yes = (v:any) => ["1","igen","yes","true","i","y"].includes(text(v).toLowerCase());
const phoneKey = (v:any) => text(v).replace(/[^0-9]/g,"");
const emailKey = (v:any) => text(v).toLowerCase();
const dateValue = (v:any): string | null => {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString();
  if (typeof v === "number") {
    const d = XLSX.SSF.parse_date_code(v);
    if (d) return new Date(Date.UTC(d.y, d.m - 1, d.d, d.H || 0, d.M || 0, Math.floor(d.S || 0))).toISOString();
  }
  const s = text(v); const dt = new Date(s); return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
};

router.use(requireAuth);
router.use(async (_req, res, next) => {
  try { await ensureClientSchema(); next(); } catch (error) { fail(res, error); }
});

router.get("/stats", async (req: AuthRequest, res) => {
  try {
    const locationId = effectiveLocation(req);
    const { rows } = await pool.query(`
      SELECT COUNT(*)::int total,
        COUNT(*) FILTER (WHERE c.is_active)::int active,
        COUNT(*) FILTER (WHERE c.created_at >= date_trunc('month',CURRENT_DATE))::int new_this_month,
        COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM appointments a WHERE a.client_id=c.id AND a.status='no_show'))::int with_no_show
      FROM clients c WHERE ($1::uuid IS NULL OR c.location_id=$1::uuid)`, [locationId]);
    res.json(rows[0]);
  } catch (error) { fail(res, error); }
});

router.get("/segments", async (req: AuthRequest, res) => {
  try {
    const locationId = effectiveLocation(req);
    const { rows } = await pool.query(`
      SELECT t.id,t.name,t.color,t.is_active,COUNT(ct.client_id)::int client_count
      FROM crm_tags t LEFT JOIN crm_client_tags ct ON ct.tag_id=t.id
      LEFT JOIN clients c ON c.id=ct.client_id AND ($1::uuid IS NULL OR c.location_id=$1::uuid)
      GROUP BY t.id ORDER BY t.name`, [locationId]);
    res.json(rows);
  } catch (error) { fail(res, error); }
});

router.post("/segments", async (req: AuthRequest, res) => {
  const name = String(req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "A címke neve kötelező." });
  try {
    const { rows } = await pool.query(`INSERT INTO crm_tags(name,color) VALUES($1,$2) RETURNING *`, [name, req.body?.color || "#7c5ce5"]);
    res.status(201).json(rows[0]);
  } catch (error: any) {
    if (error?.code === "23505") return res.status(409).json({ error: "Ez a címke már létezik." });
    fail(res, error);
  }
});

router.get("/forms", async (_req, res) => {
  try {
    const { rows } = await pool.query(`SELECT f.*,COUNT(r.id)::int response_count FROM crm_forms f LEFT JOIN crm_form_responses r ON r.form_id=f.id GROUP BY f.id ORDER BY f.title`);
    res.json(rows);
  } catch (error) { fail(res, error); }
});

router.post("/forms", async (req, res) => {
  const title = String(req.body?.title || "").trim();
  if (!title) return res.status(400).json({ error: "A dokumentum neve kötelező." });
  try {
    const { rows } = await pool.query(`INSERT INTO crm_forms(title,description,form_type) VALUES($1,$2,$3) RETURNING *`, [title, req.body?.description || null, req.body?.form_type || "questionnaire"]);
    res.status(201).json(rows[0]);
  } catch (error: any) {
    if (error?.code === "23505") return res.status(409).json({ error: "Ez a dokumentum már létezik." });
    fail(res, error);
  }
});

router.get("/duplicates", async (req: AuthRequest, res) => {
  try {
    const locationId = effectiveLocation(req);
    const { rows } = await pool.query(`
      SELECT lower(trim(COALESCE(email,''))) email_key,regexp_replace(COALESCE(phone,''),'[^0-9]','','g') phone_key,
        json_agg(json_build_object('id',id,'name',COALESCE(full_name,name),'email',email,'phone',phone) ORDER BY created_at) clients
      FROM clients WHERE ($1::uuid IS NULL OR location_id=$1::uuid)
      GROUP BY 1,2 HAVING COUNT(*)>1 AND (lower(trim(COALESCE(email,'')))<>'' OR regexp_replace(COALESCE(phone,''),'[^0-9]','','g')<>'')`, [locationId]);
    res.json(rows);
  } catch (error) { fail(res, error); }
});

router.get("/", async (req: AuthRequest, res) => {
  try {
    const locationId = effectiveLocation(req);
    const q = `%${String(req.query.q || "").trim()}%`;
    const status = String(req.query.status || "all");
    const tagId = String(req.query.tag_id || "").trim() || null;
    const { rows } = await pool.query(`
      SELECT c.id,c.location_id,COALESCE(NULLIF(c.full_name,''),c.name) name,c.phone,c.email,c.birth_date,c.gender,c.city,c.address,c.notes,
        c.preferred_contact,c.marketing_consent,c.is_active,c.source,c.created_at,c.updated_at,l.name location_name,
        COALESCE(a.visits,0)::int visits,COALESCE(a.no_shows,0)::int no_shows,a.last_visit,a.next_visit,
        COALESCE(t.tags,'[]'::json) tags
      FROM clients c LEFT JOIN locations l ON l.id=c.location_id
      LEFT JOIN LATERAL (SELECT COUNT(*) FILTER(WHERE status IN ('completed','paid','confirmed')) visits,
        COUNT(*) FILTER(WHERE status='no_show') no_shows,MAX(start_time) FILTER(WHERE start_time<=now()) last_visit,
        MIN(start_time) FILTER(WHERE start_time>now() AND status NOT IN ('cancelled','no_show')) next_visit FROM appointments WHERE client_id=c.id) a ON true
      LEFT JOIN LATERAL (SELECT json_agg(json_build_object('id',x.id,'name',x.name,'color',x.color) ORDER BY x.name) tags
        FROM crm_client_tags ct JOIN crm_tags x ON x.id=ct.tag_id WHERE ct.client_id=c.id) t ON true
      WHERE ($1::uuid IS NULL OR c.location_id=$1::uuid)
        AND ($2='%%' OR COALESCE(c.full_name,c.name,'') ILIKE $2 OR COALESCE(c.email,'') ILIKE $2 OR COALESCE(c.phone,'') ILIKE $2 OR COALESCE(c.city,'') ILIKE $2 OR COALESCE(c.address,'') ILIKE $2 OR EXISTS(SELECT 1 FROM crm_client_tags ctz JOIN crm_tags tz ON tz.id=ctz.tag_id WHERE ctz.client_id=c.id AND tz.name ILIKE $2))
        AND ($3='all' OR ($3='active' AND c.is_active) OR ($3='inactive' AND NOT c.is_active))
        AND ($4::uuid IS NULL OR EXISTS(SELECT 1 FROM crm_client_tags z WHERE z.client_id=c.id AND z.tag_id=$4::uuid))
      ORDER BY COALESCE(NULLIF(c.full_name,''),c.name) COLLATE "C" ASC
      LIMIT 500`, [locationId, q, status, tagId]);
    res.json(rows);
  } catch (error) { fail(res, error); }
});

router.post("/import-altegio-xlsx", upload.single("file"), async (req: AuthRequest, res) => {
  if (!req.file?.buffer) return res.status(400).json({ error: "XLSX fájl szükséges." });
  const db = await pool.connect();
  try {
    const wb = XLSX.read(req.file.buffer, { type: "buffer", cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<Record<string,any>>(ws, { defval: "", raw: false });
    const locationId = effectiveLocation(req);
    await db.query("BEGIN");
    const existing = await db.query(`SELECT id,phone,email FROM clients WHERE ($1::uuid IS NULL OR location_id=$1::uuid)`, [locationId]);
    const byPhone = new Map<string,string>(), byEmail = new Map<string,string>();
    for (const r of existing.rows) { const pk = phoneKey(r.phone), ek = emailKey(r.email); if (pk) byPhone.set(pk,String(r.id)); if (ek) byEmail.set(ek,String(r.id)); }
    const tags = await db.query(`SELECT id,name FROM crm_tags`); const tagCache = new Map<string,string>(); for (const t of tags.rows) tagCache.set(String(t.name).toLowerCase(),String(t.id));
    let inserted=0,updated=0,skipped=0,tagged=0;
    for (const row of rows) {
      const first = text(row["Név"]); const middle = text(row["Középső név"]); const last = text(row["Utónév"]);
      const name = [first,middle,last].filter(Boolean).join(" ").replace(/\s+/g," ").trim() || first || last;
      const phone = text(row["Mobiltelefon"] || row["Telefon"]); const email = text(row["Email"] || row["E-mail"]);
      if (!name || (!phone && !email)) { skipped++; continue; }
      const pKey = phoneKey(phone), eKey = emailKey(email);
      let id: string = (pKey ? byPhone.get(pKey) : undefined) || (eKey ? byEmail.get(eKey) : undefined) || "";
      const birth = dateValue(row["Születési dátum"]);
      const genderRaw = text(row["Nem"]).toLowerCase();
      const gender = genderRaw === "nő" || genderRaw === "female" ? "female" : genderRaw === "férfi" || genderRaw === "male" ? "male" : null;
      const city = text(row["Város"] || row["Település"]);
      const address = text(row["Cím"] || row["Lakcím"]);
      const notes = text(row["Megjegyzés"]);
      const additionalPhones = text(row["További telefonszámok"]);
      const marketing = yes(row["Hozzájárult a hírlevél fogadásához"]);
      const spent = num(row["Elköltött:, Ft"]), paid = num(row["Fizetve, Ft"]), visits = num(row["Látogatások száma"]), discount = num(row["Kedvezmény"]);
      const firstVisit = dateValue(row["Első látogatás"]), lastVisit = dateValue(row["Utolsó látogatás"]);
      if (id) {
        await db.query(`UPDATE clients SET full_name=$2,name=$2,phone=COALESCE(NULLIF($3,''),phone),email=COALESCE(NULLIF($4,''),email),birth_date=COALESCE($5::timestamptz::date,birth_date),gender=COALESCE($6,gender),city=COALESCE(NULLIF($7,''),city),address=COALESCE(NULLIF($8,''),address),notes=COALESCE(NULLIF($9,''),notes),marketing_consent=$10,source='altegio',altegio_spent=$11,altegio_paid=$12,altegio_visits=$13::integer,altegio_first_visit=$14::timestamptz,altegio_last_visit=$15::timestamptz,altegio_discount=$16,additional_phones=COALESCE(NULLIF($17,''),additional_phones),updated_at=now() WHERE id=$1::uuid`, [id,name,phone,email,birth,gender,city,address,notes,marketing,spent,paid,visits,firstVisit,lastVisit,discount,additionalPhones]);
        updated++;
      } else {
        const result = await db.query(`INSERT INTO clients(full_name,name,phone,email,location_id,birth_date,gender,city,address,notes,marketing_consent,is_active,source,altegio_spent,altegio_paid,altegio_visits,altegio_first_visit,altegio_last_visit,altegio_discount,additional_phones,updated_at) VALUES($1,$1,NULLIF($2,''),NULLIF($3,''),$4::uuid,$5::timestamptz::date,$6,NULLIF($7,''),NULLIF($8,''),NULLIF($9,''),$10,true,'altegio',$11,$12,$13::integer,$14::timestamptz,$15::timestamptz,$16,NULLIF($17,''),now()) RETURNING id`, [name,phone,email,locationId,birth,gender,city,address,notes,marketing,spent,paid,visits,firstVisit,lastVisit,discount,additionalPhones]);
        id = String(result.rows[0].id); if (pKey) byPhone.set(pKey,id); if (eKey) byEmail.set(eKey,id); inserted++;
      }
      const rawTags = text(row["Kategória"] || row["Címkék"] || row["Címke"]);
      for (const tagName of rawTags.split(/[;,|]/).map(s=>s.trim()).filter(Boolean)) {
        const key = tagName.toLowerCase(); let tagId = tagCache.get(key);
        if (!tagId) {
          const t = await db.query(`INSERT INTO crm_tags(name,color) VALUES($1,'#7c5ce5') ON CONFLICT ((lower(name))) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [tagName]);
          const createdTagId = String(t.rows[0]?.id || "");
          if (!createdTagId) throw new Error("A CRM címke létrehozása nem adott vissza azonosítót.");
          tagId = createdTagId; tagCache.set(key, createdTagId);
        }
        const link = await db.query(`INSERT INTO crm_client_tags(client_id,tag_id) VALUES($1::uuid,$2::uuid) ON CONFLICT DO NOTHING RETURNING client_id`, [id,tagId]);
        if (link.rowCount) tagged++;
      }
    }
    await db.query("COMMIT");
    res.json({ ok:true, rows:rows.length, inserted, updated, skipped, tagged });
  } catch (error) { await db.query("ROLLBACK").catch(()=>undefined); fail(res,error); } finally { db.release(); }
});

router.post("/", async (req: AuthRequest, res) => {
  const name = String(req.body?.name || req.body?.full_name || "").trim();
  if (!name) return res.status(400).json({ error: "Az ügyfél neve kötelező." });
  if (!String(req.body?.phone || "").trim() && !String(req.body?.email || "").trim()) return res.status(400).json({ error: "Telefonszám vagy e-mail-cím szükséges." });
  try {
    const locationId = effectiveLocation(req);
    const { rows } = await pool.query(`INSERT INTO clients
      (full_name,name,phone,email,location_id,birth_date,gender,address,notes,preferred_contact,marketing_consent,is_active,source,updated_at)
      VALUES($1,$1,$2,$3,$4::uuid,$5::date,$6,$7,$8,$9,$10,COALESCE($11,true),COALESCE($12,'manual'),now()) RETURNING id`,
      [name,req.body.phone||null,req.body.email||null,locationId,req.body.birth_date||null,req.body.gender||null,req.body.address||null,req.body.notes||null,req.body.preferred_contact||"phone",Boolean(req.body.marketing_consent),req.body.is_active,req.body.source]);
    res.status(201).json({ id: rows[0].id });
  } catch (error) { fail(res, error); }
});

router.get("/:id", async (req: AuthRequest, res) => {
  try {
    const locationId = effectiveLocation(req);
    const client = await pool.query(`SELECT c.*,COALESCE(NULLIF(c.full_name,''),c.name) display_name,l.name location_name FROM clients c LEFT JOIN locations l ON l.id=c.location_id WHERE c.id=$1::uuid AND ($2::uuid IS NULL OR c.location_id=$2::uuid)`, [req.params.id, locationId]);
    if (!client.rowCount) return res.status(404).json({ error: "Az ügyfél nem található." });
    const [appointments, notes, tags, forms] = await Promise.all([
      pool.query(`SELECT a.id,a.start_time,a.end_time,a.status,a.title,l.name location_name,COALESCE(e.full_name,e.name) employee_name FROM appointments a LEFT JOIN locations l ON l.id=a.location_id LEFT JOIN employees e ON e.id=a.employee_id WHERE a.client_id=$1::uuid ORDER BY a.start_time DESC LIMIT 100`, [req.params.id]),
      pool.query(`SELECT * FROM crm_client_notes WHERE client_id=$1::uuid ORDER BY created_at DESC`, [req.params.id]),
      pool.query(`SELECT t.* FROM crm_client_tags ct JOIN crm_tags t ON t.id=ct.tag_id WHERE ct.client_id=$1::uuid ORDER BY t.name`, [req.params.id]),
      pool.query(`SELECT r.*,f.title,f.form_type FROM crm_form_responses r JOIN crm_forms f ON f.id=r.form_id WHERE r.client_id=$1::uuid ORDER BY r.completed_at DESC`, [req.params.id])
    ]);
    res.json({ client:client.rows[0],appointments:appointments.rows,notes:notes.rows,tags:tags.rows,forms:forms.rows });
  } catch (error) { fail(res, error); }
});

router.patch("/:id", async (req: AuthRequest, res) => {
  const allowed: Record<string,string> = { name:"full_name",phone:"phone",email:"email",location_id:"location_id",birth_date:"birth_date",gender:"gender",address:"address",notes:"notes",preferred_contact:"preferred_contact",marketing_consent:"marketing_consent",is_active:"is_active" };
  const fields:string[]=[]; const values:any[]=[];
  for (const [key,column] of Object.entries(allowed)) if (Object.prototype.hasOwnProperty.call(req.body||{},key)) { values.push(req.body[key] === "" ? null : req.body[key]); fields.push(`${column}=$${values.length}${column==="location_id"?"::uuid":column==="birth_date"?"::date":""}`); }
  if (!fields.length) return res.status(400).json({ error: "Nincs módosítandó adat." });
  if (Object.prototype.hasOwnProperty.call(req.body||{},"name")) { values.push(req.body.name); fields.push(`name=$${values.length}`); }
  values.push(req.params.id);
  try {
    const result = await pool.query(`UPDATE clients SET ${fields.join(",")},updated_at=now() WHERE id=$${values.length}::uuid RETURNING id`, values);
    if (!result.rowCount) return res.status(404).json({ error: "Az ügyfél nem található." });
    res.json({ ok:true,id:result.rows[0].id });
  } catch (error) { fail(res, error); }
});

router.post("/:id/notes", async (req: AuthRequest, res) => {
  const textValue = String(req.body?.note_text || "").trim();
  if (!textValue) return res.status(400).json({ error: "A megjegyzés nem lehet üres." });
  try { const { rows } = await pool.query(`INSERT INTO crm_client_notes(client_id,note_text,created_by) VALUES($1::uuid,$2,$3) RETURNING *`,[req.params.id,textValue,req.user?.email||String(req.user?.id||"")]); res.status(201).json(rows[0]); }
  catch (error) { fail(res,error); }
});

router.put("/:id/tags", async (req, res) => {
  const tagIds = Array.isArray(req.body?.tag_ids) ? req.body.tag_ids.map(String) : [];
  const db = await pool.connect();
  try { await db.query("BEGIN"); await db.query(`DELETE FROM crm_client_tags WHERE client_id=$1::uuid`,[req.params.id]); for (const tagId of tagIds) await db.query(`INSERT INTO crm_client_tags(client_id,tag_id) VALUES($1::uuid,$2::uuid) ON CONFLICT DO NOTHING`,[req.params.id,tagId]); await db.query("COMMIT"); res.json({ok:true}); }
  catch (error) { await db.query("ROLLBACK").catch(()=>undefined); fail(res,error); } finally { db.release(); }
});

export default router;