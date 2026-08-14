import axios from "axios";
import pool from "../db";
import { reconcileLegacyTaskRedX } from "./legacyEvaluation2018";

const SYSTEM_USER = "system:legacy-evaluation-monthly";
let schemaPromise: Promise<void> | null = null;
let workerTimer: NodeJS.Timeout | null = null;
let workerInitialTimer: NodeJS.Timeout | null = null;

export type MonthlyEvaluationAi = {
  summary: string;
  strengths: string[];
  development_focus: string[];
  manager_questions: string[];
  data_flags: string[];
  mode: "openai" | "rule_based";
  model: string | null;
  warning?: string | null;
};

function cleanText(value: unknown, max = 6000): string {
  return String(value ?? "").replace(/\u0000/g, "").trim().slice(0, max);
}

function normalizeMonth(value?: string): string {
  const raw = String(value || "").trim();
  if (/^\d{4}-\d{2}$/.test(raw)) return `${raw}-01`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw.slice(0,7)}-01`;
  const now = new Date();
  const previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return `${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2,"0")}-01`;
}

function previousMonth(): string {
  return normalizeMonth();
}

function monthLabel(month: string): string {
  const date = new Date(`${month}T00:00:00Z`);
  return new Intl.DateTimeFormat("hu-HU", { year:"numeric", month:"long", timeZone:"UTC" }).format(date);
}

function isPastMonth(month: string): boolean {
  const selected = new Date(`${month}T00:00:00Z`).getTime();
  const now = new Date();
  const current = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  return selected < current;
}

export async function ensureLegacyMonthlyEvaluationSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = pool.query(`
      CREATE TABLE IF NOT EXISTS hr_legacy_monthly_reviews(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id uuid NOT NULL,
        evaluation_month date NOT NULL,
        status text NOT NULL DEFAULT 'ready_for_review',
        black_points integer NOT NULL DEFAULT 0,
        red_points integer NOT NULL DEFAULT 0,
        red_x integer NOT NULL DEFAULT 0,
        legacy_score numeric NOT NULL DEFAULT 0,
        guest_rating numeric,
        guest_rating_count integer NOT NULL DEFAULT 0,
        task_total integer NOT NULL DEFAULT 0,
        task_approved integer NOT NULL DEFAULT 0,
        task_overdue integer NOT NULL DEFAULT 0,
        system_result text NOT NULL DEFAULT 'neutral',
        manager_comment text,
        ai_summary text,
        ai_strengths jsonb NOT NULL DEFAULT '[]'::jsonb,
        ai_development_focus jsonb NOT NULL DEFAULT '[]'::jsonb,
        ai_manager_questions jsonb NOT NULL DEFAULT '[]'::jsonb,
        ai_data_flags jsonb NOT NULL DEFAULT '[]'::jsonb,
        ai_mode text,
        ai_model text,
        ai_generated_at timestamptz,
        snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
        prepared_at timestamptz NOT NULL DEFAULT now(),
        closed_at timestamptz,
        closed_by text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(employee_id,evaluation_month)
      );
      ALTER TABLE hr_legacy_monthly_reviews ADD COLUMN IF NOT EXISTS task_total integer NOT NULL DEFAULT 0;
      ALTER TABLE hr_legacy_monthly_reviews ADD COLUMN IF NOT EXISTS task_approved integer NOT NULL DEFAULT 0;
      ALTER TABLE hr_legacy_monthly_reviews ADD COLUMN IF NOT EXISTS task_overdue integer NOT NULL DEFAULT 0;
      ALTER TABLE hr_legacy_monthly_reviews ADD COLUMN IF NOT EXISTS system_result text NOT NULL DEFAULT 'neutral';
      ALTER TABLE hr_legacy_monthly_reviews ADD COLUMN IF NOT EXISTS ai_summary text;
      ALTER TABLE hr_legacy_monthly_reviews ADD COLUMN IF NOT EXISTS ai_strengths jsonb NOT NULL DEFAULT '[]'::jsonb;
      ALTER TABLE hr_legacy_monthly_reviews ADD COLUMN IF NOT EXISTS ai_development_focus jsonb NOT NULL DEFAULT '[]'::jsonb;
      ALTER TABLE hr_legacy_monthly_reviews ADD COLUMN IF NOT EXISTS ai_manager_questions jsonb NOT NULL DEFAULT '[]'::jsonb;
      ALTER TABLE hr_legacy_monthly_reviews ADD COLUMN IF NOT EXISTS ai_data_flags jsonb NOT NULL DEFAULT '[]'::jsonb;
      ALTER TABLE hr_legacy_monthly_reviews ADD COLUMN IF NOT EXISTS ai_mode text;
      ALTER TABLE hr_legacy_monthly_reviews ADD COLUMN IF NOT EXISTS ai_model text;
      ALTER TABLE hr_legacy_monthly_reviews ADD COLUMN IF NOT EXISTS ai_generated_at timestamptz;
      ALTER TABLE hr_legacy_monthly_reviews ADD COLUMN IF NOT EXISTS snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;
      ALTER TABLE hr_legacy_monthly_reviews ADD COLUMN IF NOT EXISTS prepared_at timestamptz NOT NULL DEFAULT now();
      ALTER TABLE hr_legacy_monthly_reviews ADD COLUMN IF NOT EXISTS closed_at timestamptz;
      ALTER TABLE hr_legacy_monthly_reviews ADD COLUMN IF NOT EXISTS closed_by text;
      CREATE INDEX IF NOT EXISTS idx_hr_legacy_monthly_reviews_month_status
        ON hr_legacy_monthly_reviews(evaluation_month,status,employee_id);

      CREATE TABLE IF NOT EXISTS ai_usage_log(
        id bigserial PRIMARY KEY,
        user_key text NOT NULL,
        model text NOT NULL,
        input_tokens integer NOT NULL DEFAULT 0,
        output_tokens integer NOT NULL DEFAULT 0,
        estimated_cost_usd numeric NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `).then(() => undefined).catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

function systemResult(score: number, redX: number, guestRating: number | null, guestCount: number): string {
  if (redX >= 2 || score <= -5 || (guestCount >= 3 && guestRating != null && guestRating < 3.5)) return "critical_attention";
  if (score < 0 || (guestCount >= 3 && guestRating != null && guestRating < 4)) return "development_needed";
  if (score >= 3 && (guestCount < 3 || guestRating == null || guestRating >= 4.5)) return "strong";
  return "stable";
}

export async function prepareLegacyMonthlyEvaluations(monthValue?: string): Promise<{ month: string; created_or_refreshed: number; closed_untouched: number }> {
  await ensureLegacyMonthlyEvaluationSchema();
  await reconcileLegacyTaskRedX();
  const month = normalizeMonth(monthValue);

  const employees = (await pool.query(`
    SELECT e.id,e.full_name
      FROM employees e
     WHERE COALESCE(e.active,true)=true
     ORDER BY COALESCE(e.full_name,'')
  `)).rows;

  let changed = 0;
  let closedUntouched = 0;
  for (const employee of employees) {
    const existing = (await pool.query(`SELECT status FROM hr_legacy_monthly_reviews WHERE employee_id=$1 AND evaluation_month=$2::date`,[employee.id,month])).rows[0];
    if (existing?.status === "closed") { closedUntouched += 1; continue; }

    const metrics = (await pool.query(`
      WITH points AS (
        SELECT
          COALESCE(SUM(point_count) FILTER(WHERE point_type='black'),0)::int black_points,
          COALESCE(SUM(point_count) FILTER(WHERE point_type='red'),0)::int red_points,
          COALESCE(SUM(point_count) FILTER(WHERE point_type='red_x'),0)::int red_x
        FROM hr_legacy_points
        WHERE employee_id=$1 AND evaluation_month=$2::date
      ), guest AS (
        SELECT round(avg(rating)::numeric,2) guest_rating,count(*)::int guest_rating_count
        FROM guest_reviews
        WHERE employee_id=$1 AND created_at >= $2::date AND created_at < ($2::date + interval '1 month')
      ), tasks AS (
        SELECT
          count(*)::int task_total,
          count(*) FILTER(WHERE status='approved')::int task_approved,
          count(*) FILTER(WHERE due_at < ($2::date + interval '1 month') AND status NOT IN ('approved','cancelled','archived'))::int task_overdue
        FROM operations_quality_records
        WHERE module_key='tasks' AND employee_id=$1
          AND due_at >= $2::date AND due_at < ($2::date + interval '1 month')
      )
      SELECT p.black_points,p.red_points,p.red_x,g.guest_rating,g.guest_rating_count,t.task_total,t.task_approved,t.task_overdue
      FROM points p CROSS JOIN guest g CROSS JOIN tasks t
    `,[employee.id,month])).rows[0] || {};

    const black = Number(metrics.black_points || 0);
    const red = Number(metrics.red_points || 0);
    const redX = Number(metrics.red_x || 0);
    const score = black - red - (3 * redX);
    const guestRating = metrics.guest_rating == null ? null : Number(metrics.guest_rating);
    const guestCount = Number(metrics.guest_rating_count || 0);
    const result = systemResult(score,redX,guestRating,guestCount);
    const snapshot = {
      employee_name: employee.full_name || null,
      evaluation_month: month,
      black_points: black,
      red_points: red,
      red_x: redX,
      legacy_score: score,
      guest_rating: guestRating,
      guest_rating_count: guestCount,
      task_total: Number(metrics.task_total || 0),
      task_approved: Number(metrics.task_approved || 0),
      task_overdue: Number(metrics.task_overdue || 0),
      system_result: result,
      source: "live_preview",
    };

    await pool.query(`
      INSERT INTO hr_legacy_monthly_reviews(
        employee_id,evaluation_month,status,black_points,red_points,red_x,legacy_score,
        guest_rating,guest_rating_count,task_total,task_approved,task_overdue,system_result,snapshot,prepared_at,updated_at
      ) VALUES($1,$2::date,'ready_for_review',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,now(),now())
      ON CONFLICT(employee_id,evaluation_month) DO UPDATE SET
        black_points=EXCLUDED.black_points,red_points=EXCLUDED.red_points,red_x=EXCLUDED.red_x,
        legacy_score=EXCLUDED.legacy_score,guest_rating=EXCLUDED.guest_rating,
        guest_rating_count=EXCLUDED.guest_rating_count,task_total=EXCLUDED.task_total,
        task_approved=EXCLUDED.task_approved,task_overdue=EXCLUDED.task_overdue,
        system_result=EXCLUDED.system_result,snapshot=EXCLUDED.snapshot,prepared_at=now(),updated_at=now()
      WHERE hr_legacy_monthly_reviews.status<>'closed'
    `,[employee.id,month,black,red,redX,score,guestRating,guestCount,Number(metrics.task_total||0),Number(metrics.task_approved||0),Number(metrics.task_overdue||0),result,JSON.stringify(snapshot)]);
    changed += 1;
  }
  return { month: month.slice(0,7), created_or_refreshed: changed, closed_untouched: closedUntouched };
}

export async function listLegacyMonthlyEvaluations(monthValue?: string) {
  await ensureLegacyMonthlyEvaluationSchema();
  const month = normalizeMonth(monthValue);
  await prepareLegacyMonthlyEvaluations(month);
  const rows = (await pool.query(`
    SELECT r.*,e.full_name,e.location_id,p.name AS position_name
      FROM hr_legacy_monthly_reviews r
      JOIN employees e ON e.id=r.employee_id
      LEFT JOIN hr_positions p ON p.id=e.position_id
     WHERE r.evaluation_month=$1::date
     ORDER BY COALESCE(e.full_name,''),r.employee_id
  `,[month])).rows;
  return {
    month: month.slice(0,7),
    month_label: monthLabel(month),
    closable: isPastMonth(month),
    rows,
    summary: {
      total: rows.length,
      closed: rows.filter((x:any)=>x.status === "closed").length,
      waiting: rows.filter((x:any)=>x.status !== "closed").length,
      ai_ready: rows.filter((x:any)=>Boolean(x.ai_generated_at)).length,
      red_x: rows.reduce((sum:number,x:any)=>sum+Number(x.red_x||0),0),
    },
  };
}

function fallbackAi(row: any): MonthlyEvaluationAi {
  const strengths: string[] = [];
  const focus: string[] = [];
  const flags: string[] = [];
  const questions: string[] = [];
  const black = Number(row.black_points || 0), red = Number(row.red_points || 0), redX = Number(row.red_x || 0);
  const guest = row.guest_rating == null ? null : Number(row.guest_rating), guestCount = Number(row.guest_rating_count || 0);
  if (black > 0) strengths.push(`${black} pozitív fekete pont került rögzítésre a hónapban.`);
  if (guest != null && guest >= 4.5 && guestCount > 0) strengths.push(`A vendégértékelések átlaga erős (${guest.toFixed(2)}/5, ${guestCount} értékelés).`);
  if (red === 0 && redX === 0) strengths.push("Nem került rögzítésre piros pont vagy automatikus piros X.");
  if (red > 0) focus.push(`A ${red} piros pont okait érdemes egyenként átbeszélni és konkrét javító lépést rögzíteni.`);
  if (redX > 0) focus.push(`A ${redX} automatikus piros X mögötti határidős/jóváhagyási feladatokat érdemes visszanézni.`);
  if (guest != null && guest < 4) focus.push(`A ${guest.toFixed(2)}/5 vendégátlag alapján érdemes a vendégélmény konkrét visszajelzéseit áttekinteni.`);
  if (guestCount === 0) flags.push("Nincs vendégértékelés erre a hónapra; ebből a dimenzióból nem vonható le következtetés.");
  if (redX > 0) flags.push(`${redX} feladat határidő/jóváhagyás miatt automatikus piros X-et eredményezett.`);
  if (Number(row.task_total||0) > 0) questions.push(`A ${row.task_approved}/${row.task_total} jóváhagyott feladat arány tükrözi a tényleges munkavégzést, vagy van adminisztrációs elmaradás?`);
  questions.push("Melyik egy konkrét, következő hónapban mérhető fejlesztési célt érdemes közösen rögzíteni?");
  const summary = `A ${monthLabel(String(row.evaluation_month).slice(0,10))} havi 2018-as értékelésben ${black} fekete pont, ${red} piros pont és ${redX} piros X szerepel; a súlyozott pontszám ${Number(row.legacy_score||0)}. ${guestCount>0?`A vendégértékelési átlag ${guest?.toFixed(2)}/5 (${guestCount} értékelés).`:"A hónaphoz nem tartozik vendégértékelés."} A végleges értékelést a vezető a forrásadatok és a személyes megbeszélés alapján zárja le.`;
  return { summary, strengths:strengths.slice(0,4), development_focus:focus.slice(0,4), manager_questions:questions.slice(0,4), data_flags:flags.slice(0,4), mode:"rule_based", model:null };
}

function parseAiJson(text: string): Partial<MonthlyEvaluationAi> | null {
  const cleaned = text.trim().replace(/^```json\s*/i,"").replace(/```$/," ").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(cleaned.slice(start,end+1)); } catch { return null; }
}

async function aiBudgetAllowed(userKey: string): Promise<boolean> {
  const globalLimit = Number(process.env.AI_MONTHLY_BUDGET_USD || 10);
  const userLimit = Number(process.env.AI_USER_MONTHLY_BUDGET_USD || 2);
  const usage = (await pool.query(`
    SELECT
      COALESCE(SUM(estimated_cost_usd),0)::numeric global_cost,
      COALESCE(SUM(estimated_cost_usd) FILTER(WHERE user_key=$1),0)::numeric user_cost
    FROM ai_usage_log WHERE created_at>=date_trunc('month',now())
  `,[userKey])).rows[0] || {};
  if (globalLimit > 0 && Number(usage.global_cost||0) >= globalLimit) return false;
  if (userLimit > 0 && Number(usage.user_cost||0) >= userLimit) return false;
  return true;
}

export async function generateLegacyMonthlyAi(reviewId: string, userKey: string): Promise<MonthlyEvaluationAi> {
  await ensureLegacyMonthlyEvaluationSchema();
  const row = (await pool.query(`
    SELECT r.*,e.full_name,p.name AS position_name
      FROM hr_legacy_monthly_reviews r
      JOIN employees e ON e.id=r.employee_id
      LEFT JOIN hr_positions p ON p.id=e.position_id
     WHERE r.id=$1::uuid
  `,[reviewId])).rows[0];
  if (!row) throw Object.assign(new Error("A havi értékelési lap nem található."),{status:404});
  if (row.status === "closed") throw Object.assign(new Error("Lezárt havi értékelés AI-tartalma már nem módosítható."),{status:409});

  const [points, guestComments] = await Promise.all([
    pool.query(`SELECT point_type,point_count,reason,source,created_at FROM hr_legacy_points WHERE employee_id=$1 AND evaluation_month=$2 ORDER BY created_at`,[row.employee_id,row.evaluation_month]),
    pool.query(`SELECT rating,review_text,created_at FROM guest_reviews WHERE employee_id=$1 AND created_at>=$2::date AND created_at<($2::date+interval '1 month') ORDER BY created_at DESC LIMIT 30`,[row.employee_id,row.evaluation_month]),
  ]);

  const fallback = fallbackAi(row);
  const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) {
    fallback.warning = "Az OpenAI kapcsolat nincs konfigurálva; szabályalapú vezetői támogatás készült.";
    await saveAi(reviewId,fallback);
    return fallback;
  }
  if (!(await aiBudgetAllowed(userKey))) {
    fallback.warning = "A havi AI-költségkeret elérte a limitet; szabályalapú vezetői támogatás készült.";
    await saveAi(reviewId,fallback);
    return fallback;
  }

  const payload = {
    employee: { name: row.full_name, position: row.position_name || null },
    month: String(row.evaluation_month).slice(0,10),
    metrics: {
      black_points:Number(row.black_points||0), red_points:Number(row.red_points||0), red_x:Number(row.red_x||0),
      legacy_score:Number(row.legacy_score||0), guest_rating:row.guest_rating==null?null:Number(row.guest_rating), guest_rating_count:Number(row.guest_rating_count||0),
      task_total:Number(row.task_total||0), task_approved:Number(row.task_approved||0), task_overdue:Number(row.task_overdue||0), system_result:row.system_result,
    },
    point_reasons: points.rows.map((x:any)=>({type:x.point_type,count:Number(x.point_count||0),reason:cleanText(x.reason,600),source:x.source})),
    guest_feedback: guestComments.rows.map((x:any)=>({rating:Number(x.rating),comment:cleanText(x.review_text,600)})),
  };

  const instructions = `Te a Kleopátra VIR belső HR-értékelési elemző asszisztense vagy. Kizárólag a megadott, munkavégzéshez kapcsolódó teljesítményadatokat foglald össze magyarul. Nem hozol munkajogi vagy személyzeti döntést. Tilos elbocsátást, felvételt, előléptetést, béremelést/bércsökkentést, fegyelmi szankciót vagy más magas hatású személyzeti intézkedést javasolni. Ne következtess és ne utalj egészségi állapotra, fogyatékosságra, életkorra, nemre, származásra, vallásra, politikai nézetre, szexuális orientációra, családi helyzetre, szakszervezeti tagságra vagy más érzékeny/személyes tulajdonságra. A vendégszövegekben szereplő ilyen adatokat hagyd figyelmen kívül. A piros/fekete/piros X és vendégértékelés csak jelzés; a végső értékelést vezető végzi. Adj tárgyilagos, támogató, nem megalázó szöveget. Kizárólag JSON objektumot adj ezekkel a kulcsokkal: summary (string), strengths (string[] max 4), development_focus (string[] max 4), manager_questions (string[] max 4), data_flags (string[] max 4).`;

  try {
    const response = await axios.post("https://api.openai.com/v1/responses",{
      model:process.env.OPENAI_MODEL || "gpt-5-mini",
      instructions,
      input:[{role:"user",content:[{type:"input_text",text:JSON.stringify(payload)}]}],
      store:false,
      max_output_tokens:900,
    },{headers:{Authorization:`Bearer ${apiKey}`,"Content-Type":"application/json"},timeout:30_000});
    const data:any = response.data;
    let text = String(data?.output_text || "").trim();
    if (!text && Array.isArray(data?.output)) text = data.output.flatMap((item:any)=>Array.isArray(item?.content)?item.content:[]).filter((item:any)=>item?.type==="output_text").map((item:any)=>String(item.text||"")).join("\n").trim();
    const parsed = parseAiJson(text);
    if (!parsed) throw new Error("Az AI válasza nem volt feldolgozható JSON formátumban.");
    const ai: MonthlyEvaluationAi = {
      summary:cleanText(parsed.summary || fallback.summary,4000),
      strengths:Array.isArray(parsed.strengths)?parsed.strengths.map(x=>cleanText(x,700)).filter(Boolean).slice(0,4):fallback.strengths,
      development_focus:Array.isArray(parsed.development_focus)?parsed.development_focus.map(x=>cleanText(x,700)).filter(Boolean).slice(0,4):fallback.development_focus,
      manager_questions:Array.isArray(parsed.manager_questions)?parsed.manager_questions.map(x=>cleanText(x,700)).filter(Boolean).slice(0,4):fallback.manager_questions,
      data_flags:Array.isArray(parsed.data_flags)?parsed.data_flags.map(x=>cleanText(x,700)).filter(Boolean).slice(0,4):fallback.data_flags,
      mode:"openai",
      model:String(data?.model || process.env.OPENAI_MODEL || "gpt-5-mini"),
    };
    const inputTokens=Number(data?.usage?.input_tokens||0),outputTokens=Number(data?.usage?.output_tokens||0);
    const inputCost=Number(process.env.OPENAI_INPUT_USD_PER_1M||0.25),outputCost=Number(process.env.OPENAI_OUTPUT_USD_PER_1M||2);
    const estimated=(inputTokens/1_000_000)*inputCost+(outputTokens/1_000_000)*outputCost;
    await pool.query(`INSERT INTO ai_usage_log(user_key,model,input_tokens,output_tokens,estimated_cost_usd)VALUES($1,$2,$3,$4,$5)`,[userKey,ai.model||"unknown",inputTokens,outputTokens,estimated]);
    await saveAi(reviewId,ai);
    return ai;
  } catch (error:any) {
    fallback.warning = `Az AI szolgáltatás átmenetileg nem volt használható; szabályalapú támogatás készült. (${cleanText(error?.response?.data?.error?.message||error?.message||"ismeretlen hiba",260)})`;
    await saveAi(reviewId,fallback);
    return fallback;
  }
}

async function saveAi(reviewId: string, ai: MonthlyEvaluationAi): Promise<void> {
  await pool.query(`
    UPDATE hr_legacy_monthly_reviews SET
      ai_summary=$2,ai_strengths=$3::jsonb,ai_development_focus=$4::jsonb,
      ai_manager_questions=$5::jsonb,ai_data_flags=$6::jsonb,ai_mode=$7,ai_model=$8,
      ai_generated_at=now(),updated_at=now()
    WHERE id=$1::uuid AND status<>'closed'
  `,[reviewId,ai.summary,JSON.stringify(ai.strengths),JSON.stringify(ai.development_focus),JSON.stringify(ai.manager_questions),JSON.stringify(ai.data_flags),ai.mode,ai.model]);
}

export async function updateLegacyMonthlyManagerComment(reviewId: string, managerComment: string) {
  await ensureLegacyMonthlyEvaluationSchema();
  const r = await pool.query(`
    UPDATE hr_legacy_monthly_reviews SET manager_comment=$2,updated_at=now()
    WHERE id=$1::uuid AND status<>'closed' RETURNING *
  `,[reviewId,cleanText(managerComment,8000)]);
  if (!r.rowCount) throw Object.assign(new Error("A havi lap nem található vagy már lezárt."),{status:409});
  return r.rows[0];
}

export async function closeLegacyMonthlyEvaluation(reviewId: string, managerComment: string, closedBy: string) {
  await ensureLegacyMonthlyEvaluationSchema();
  const initial = (await pool.query(`SELECT evaluation_month,status FROM hr_legacy_monthly_reviews WHERE id=$1::uuid`,[reviewId])).rows[0];
  if (!initial) throw Object.assign(new Error("A havi értékelési lap nem található."),{status:404});
  if (initial.status === "closed") return (await pool.query(`SELECT * FROM hr_legacy_monthly_reviews WHERE id=$1::uuid`,[reviewId])).rows[0];
  const month = String(initial.evaluation_month).slice(0,10);
  if (!isPastMonth(month)) throw Object.assign(new Error("Folyamatban lévő hónap nem zárható le."),{status:409});
  const comment = cleanText(managerComment,8000);
  if (comment.length < 5) throw Object.assign(new Error("A lezáráshoz vezetői megjegyzés szükséges."),{status:400});
  await prepareLegacyMonthlyEvaluations(month);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const row = (await client.query(`SELECT r.*,e.full_name,p.name AS position_name FROM hr_legacy_monthly_reviews r JOIN employees e ON e.id=r.employee_id LEFT JOIN hr_positions p ON p.id=e.position_id WHERE r.id=$1::uuid FOR UPDATE`,[reviewId])).rows[0];
    if (!row) throw Object.assign(new Error("A havi értékelési lap nem található."),{status:404});
    if (row.status === "closed") { await client.query("COMMIT"); return row; }
    const [points,guest] = await Promise.all([
      client.query(`SELECT point_type,point_count,reason,source,source_record_id,created_at FROM hr_legacy_points WHERE employee_id=$1 AND evaluation_month=$2 ORDER BY created_at`,[row.employee_id,row.evaluation_month]),
      client.query(`SELECT rating,review_text,created_at FROM guest_reviews WHERE employee_id=$1 AND created_at>=$2::date AND created_at<($2::date+interval '1 month') ORDER BY created_at`,[row.employee_id,row.evaluation_month]),
    ]);
    const snapshot = {
      version:1,
      closed_at:new Date().toISOString(),
      employee:{id:row.employee_id,name:row.full_name,position:row.position_name||null},
      month:String(row.evaluation_month).slice(0,10),
      metrics:{black_points:Number(row.black_points||0),red_points:Number(row.red_points||0),red_x:Number(row.red_x||0),legacy_score:Number(row.legacy_score||0),guest_rating:row.guest_rating==null?null:Number(row.guest_rating),guest_rating_count:Number(row.guest_rating_count||0),task_total:Number(row.task_total||0),task_approved:Number(row.task_approved||0),task_overdue:Number(row.task_overdue||0)},
      system_result:row.system_result,
      points:points.rows,
      guest_reviews:guest.rows,
      manager_comment:comment,
      ai:{summary:row.ai_summary,strengths:row.ai_strengths,development_focus:row.ai_development_focus,manager_questions:row.ai_manager_questions,data_flags:row.ai_data_flags,mode:row.ai_mode,model:row.ai_model,generated_at:row.ai_generated_at},
      governance:{ai_advisory_only:true,closed_by:closedBy},
    };
    const closed = (await client.query(`
      UPDATE hr_legacy_monthly_reviews SET status='closed',manager_comment=$2,snapshot=$3::jsonb,
        closed_at=now(),closed_by=$4,updated_at=now()
      WHERE id=$1::uuid RETURNING *
    `,[reviewId,comment,JSON.stringify(snapshot),closedBy])).rows[0];
    await client.query("COMMIT");
    return closed;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

export function startLegacyMonthlyEvaluationWorker(): void {
  if (workerTimer || workerInitialTimer) return;
  const run = () => prepareLegacyMonthlyEvaluations(previousMonth()).catch((error)=>console.error("Legacy monthly evaluation preparation failed:",error));
  workerInitialTimer = setTimeout(()=>{workerInitialTimer=null;void run();},30_000);
  workerInitialTimer.unref?.();
  workerTimer = setInterval(()=>void run(),6*60*60_000);
  workerTimer.unref?.();
}

export const legacyMonthlySystemUser = SYSTEM_USER;
