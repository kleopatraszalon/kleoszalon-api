import { Router } from "express";
import axios from "axios";
import db from "../db";
import { requireAuth, AuthRequest } from "../middleware/auth";

const router = Router();

type ChatMessage = { role: "user" | "assistant"; content: string };

const rateWindowMs = 60_000;
const rateMax = 20;
const buckets = new Map<string, { startedAt: number; count: number }>();

const numEnv = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

const limits = () => ({
  monthlyBudgetUsd: numEnv("AI_MONTHLY_BUDGET_USD", 10),
  userMonthlyBudgetUsd: numEnv("AI_USER_MONTHLY_BUDGET_USD", 2),
  userMonthlyRequestLimit: Math.trunc(numEnv("AI_USER_MONTHLY_REQUEST_LIMIT", 200)),
  inputUsdPer1M: numEnv("OPENAI_INPUT_USD_PER_1M", 0.25),
  outputUsdPer1M: numEnv("OPENAI_OUTPUT_USD_PER_1M", 2),
});

function allowRequest(key: string) {
  const now = Date.now();
  const current = buckets.get(key);
  if (!current || now - current.startedAt > rateWindowMs) {
    buckets.set(key, { startedAt: now, count: 1 });
    return true;
  }
  if (current.count >= rateMax) return false;
  current.count += 1;
  return true;
}

function cleanMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((m: any) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m: any) => ({ role: m.role, content: m.content.trim().slice(0, 4000) }))
    .filter((m: ChatMessage) => m.content.length > 0)
    .slice(-10);
}

function userKey(req: AuthRequest) {
  return req.user?.email ? `email:${req.user.email.toLowerCase()}` : `user:${req.user?.id ?? "unknown"}`;
}

async function monthlyUsage(key: string) {
  const { rows } = await db.query(
    `SELECT
       COUNT(*)::int AS request_count,
       COALESCE(SUM(input_tokens),0)::bigint AS input_tokens,
       COALESCE(SUM(output_tokens),0)::bigint AS output_tokens,
       COALESCE(SUM(estimated_cost_usd),0)::numeric AS estimated_cost_usd
     FROM ai_usage_log
     WHERE created_at >= date_trunc('month', now())
       AND ($1 = '' OR user_key = $1)`,
    [key]
  );
  const r = rows[0] || {};
  return {
    request_count: Number(r.request_count || 0),
    input_tokens: Number(r.input_tokens || 0),
    output_tokens: Number(r.output_tokens || 0),
    estimated_cost_usd: Number(r.estimated_cost_usd || 0),
  };
}

const systemInstructions = `Te a Kleoszalon VIR beépített használati asszisztense vagy.
Feladatod: rövid, pontos, magyar nyelvű segítséget adj a vállalatirányítási rendszer használatához.
A rendszer fő területei: Irányítópult, Időpontok/Foglalások, Vendég CRM, Munkalapok, Raktár és készlet, Pénzügy, HR, Szolgáltatások, Riportok, Marketing, Beállítások.
A Raktár oldalon elérhető: készletlista, telephely/központi készlet, nyitókészlet, bevételezés, készletkorrekció és mozgástörténet.
A Munkalapoknál elérhető az életciklus: várakozik, megérkezett, folyamatban, befejezve, nem jelent meg, visszavonva; termék-anyagfelhasználás is rögzíthető.
Ha a felhasználó azt kérdezi, hol talál valamit, adj konkrét menü- vagy útvonaljavaslatot. Ha a jelenlegi oldal kontextusa rendelkezésre áll, arra építs.
Ne állítsd, hogy végrehajtottál műveletet. Ne kérj vagy jeleníts meg jelszót, bankkártyaadatot, API-kulcsot vagy más titkot. Ha nem tudod biztosan, mondd meg, és javasold a legvalószínűbb menüpontot.`;

router.get("/health", (_req, res) => {
  res.json({
    ok: true,
    configured: Boolean(process.env.OPENAI_API_KEY),
    model: process.env.OPENAI_MODEL || "gpt-5-mini",
    limits: limits(),
  });
});

router.get("/stats", requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const key = userKey(req);
    const [globalUsage, myUsage, daily] = await Promise.all([
      monthlyUsage(""),
      monthlyUsage(key),
      db.query(
        `SELECT created_at::date AS day,
                COUNT(*)::int AS requests,
                COALESCE(SUM(estimated_cost_usd),0)::numeric AS estimated_cost_usd
         FROM ai_usage_log
         WHERE created_at >= CURRENT_DATE - INTERVAL '29 days'
         GROUP BY created_at::date
         ORDER BY day`
      ),
    ]);
    res.json({ global: globalUsage, mine: myUsage, limits: limits(), daily: daily.rows });
  } catch (err) {
    next(err);
  }
});

router.post("/chat", requireAuth, async (req: AuthRequest, res) => {
  const key = userKey(req);
  if (!allowRequest(key)) {
    return res.status(429).json({ code: "local_rate_limit", message: "Túl sok AI-kérés. Kérlek próbáld újra egy perc múlva." });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ code: "missing_api_key", message: "Az AI támogatás még nincs aktiválva. A szerveren be kell állítani az OPENAI_API_KEY környezeti változót." });
  }

  const messages = cleanMessages(req.body?.messages);
  if (!messages.length || messages[messages.length - 1].role !== "user") {
    return res.status(400).json({ code: "missing_user_message", message: "Hiányzik a felhasználói kérdés." });
  }

  try {
    const cfg = limits();
    const [globalUsage, myUsage] = await Promise.all([monthlyUsage(""), monthlyUsage(key)]);

    if (cfg.monthlyBudgetUsd > 0 && globalUsage.estimated_cost_usd >= cfg.monthlyBudgetUsd) {
      return res.status(429).json({ code: "monthly_budget_exhausted", message: "A VIR havi AI-költségkerete elfogyott.", usage: globalUsage, limit: cfg.monthlyBudgetUsd });
    }
    if (cfg.userMonthlyBudgetUsd > 0 && myUsage.estimated_cost_usd >= cfg.userMonthlyBudgetUsd) {
      return res.status(429).json({ code: "user_budget_exhausted", message: "Elérted a havi személyes AI-költségkeretedet.", usage: myUsage, limit: cfg.userMonthlyBudgetUsd });
    }
    if (cfg.userMonthlyRequestLimit > 0 && myUsage.request_count >= cfg.userMonthlyRequestLimit) {
      return res.status(429).json({ code: "user_request_limit", message: "Elérted a havi AI-kérésszám limitet.", usage: myUsage, limit: cfg.userMonthlyRequestLimit });
    }

    const page = String(req.body?.context?.pathname || "").slice(0, 300);
    const pageTitle = String(req.body?.context?.page_title || "").slice(0, 300);
    const locationName = String(req.body?.context?.location_name || "").slice(0, 300);
    const role = String(req.body?.context?.role || "").slice(0, 100);
    const contextText = [
      page ? `Aktuális útvonal: ${page}` : "",
      pageTitle ? `Aktuális oldal: ${pageTitle}` : "",
      locationName ? `Kiválasztott telephely: ${locationName}` : "",
      role ? `Felhasználói szerepkör: ${role}` : "",
    ].filter(Boolean).join("\n");

    const input = [
      ...(contextText ? [{ role: "developer", content: [{ type: "input_text", text: contextText }] }] : []),
      ...messages.map(m => ({ role: m.role, content: [{ type: m.role === "assistant" ? "output_text" : "input_text", text: m.content }] })),
    ];

    const response = await axios.post(
      "https://api.openai.com/v1/responses",
      {
        model: process.env.OPENAI_MODEL || "gpt-5-mini",
        instructions: systemInstructions,
        input,
        store: false,
        max_output_tokens: 700,
      },
      { headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, timeout: 30_000 }
    );

    const data: any = response.data;
    let answer = String(data?.output_text || "").trim();
    if (!answer && Array.isArray(data?.output)) {
      answer = data.output.flatMap((item: any) => Array.isArray(item?.content) ? item.content : [])
        .filter((item: any) => item?.type === "output_text" && typeof item?.text === "string")
        .map((item: any) => item.text).join("\n").trim();
    }
    if (!answer) answer = "Most nem sikerült választ generálnom. Próbáld meg másképp megfogalmazni a kérdést.";

    const inputTokens = Number(data?.usage?.input_tokens || 0);
    const outputTokens = Number(data?.usage?.output_tokens || 0);
    const estimatedCost = (inputTokens / 1_000_000) * cfg.inputUsdPer1M + (outputTokens / 1_000_000) * cfg.outputUsdPer1M;

    await db.query(
      `INSERT INTO ai_usage_log (user_key, model, input_tokens, output_tokens, estimated_cost_usd)
       VALUES ($1,$2,$3,$4,$5)`,
      [key, data?.model || process.env.OPENAI_MODEL || "gpt-5-mini", inputTokens, outputTokens, estimatedCost]
    );

    return res.json({ answer, model: data?.model || process.env.OPENAI_MODEL || "gpt-5-mini", usage: { input_tokens: inputTokens, output_tokens: outputTokens, estimated_cost_usd: estimatedCost } });
  } catch (err: any) {
    const status = Number(err?.response?.status || 0);
    const openAiError = err?.response?.data?.error || {};
    const openAiCode = String(openAiError?.code || openAiError?.type || "openai_error");
    const detail = String(openAiError?.message || err?.message || "Ismeretlen AI hiba").slice(0, 600);
    console.error("AI support chat error:", { status, code: openAiCode, detail });

    if (status === 401) return res.status(502).json({ code: "invalid_api_key", message: "Az OpenAI API-kulcs érvénytelen vagy nem használható." });
    if (status === 429) return res.status(429).json({ code: openAiCode, message: "Az OpenAI API elérte a használati vagy számlázási keretet.", detail });
    if (status === 400) return res.status(502).json({ code: openAiCode, message: "Az OpenAI API elutasította a kérést.", detail });
    if (status === 403) return res.status(502).json({ code: openAiCode, message: "Az API-kulcsnak nincs jogosultsága ehhez a modellhez vagy projekthez.", detail });
    return res.status(502).json({ code: openAiCode, message: "Az AI támogatás átmenetileg nem elérhető.", detail });
  }
});

export default router;
