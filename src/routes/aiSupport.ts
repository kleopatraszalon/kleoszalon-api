import { Router } from "express";
import axios from "axios";

const router = Router();

type ChatMessage = { role: "user" | "assistant"; content: string };

const rateWindowMs = 60_000;
const rateMax = 20;
const buckets = new Map<string, { startedAt: number; count: number }>();

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
  });
});

router.post("/chat", async (req, res) => {
  const ip = String(req.ip || req.socket.remoteAddress || "unknown");
  if (!allowRequest(ip)) {
    return res.status(429).json({ code: "local_rate_limit", message: "Túl sok AI-kérés. Kérlek próbáld újra egy perc múlva." });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ code: "missing_api_key", message: "Az AI támogatás még nincs aktiválva. A szerveren be kell állítani az OPENAI_API_KEY környezeti változót." });
  }

  const messages = cleanMessages(req.body?.messages);
  const page = String(req.body?.context?.pathname || "").slice(0, 300);
  const pageTitle = String(req.body?.context?.page_title || "").slice(0, 300);
  const locationName = String(req.body?.context?.location_name || "").slice(0, 300);
  const role = String(req.body?.context?.role || "").slice(0, 100);

  if (!messages.length || messages[messages.length - 1].role !== "user") {
    return res.status(400).json({ code: "missing_user_message", message: "Hiányzik a felhasználói kérdés." });
  }

  try {
    const contextText = [
      page ? `Aktuális útvonal: ${page}` : "",
      pageTitle ? `Aktuális oldal: ${pageTitle}` : "",
      locationName ? `Kiválasztott telephely: ${locationName}` : "",
      role ? `Felhasználói szerepkör: ${role}` : "",
    ].filter(Boolean).join("\n");

    const input = [
      ...(contextText ? [{ role: "developer", content: [{ type: "input_text", text: contextText }] }] : []),
      ...messages.map(m => ({ role: m.role, content: [{ type: "input_text", text: m.content }] })),
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
      {
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        timeout: 30_000,
      }
    );

    const data: any = response.data;
    let answer = String(data?.output_text || "").trim();
    if (!answer && Array.isArray(data?.output)) {
      answer = data.output
        .flatMap((item: any) => Array.isArray(item?.content) ? item.content : [])
        .filter((item: any) => item?.type === "output_text" && typeof item?.text === "string")
        .map((item: any) => item.text)
        .join("\n")
        .trim();
    }

    if (!answer) answer = "Most nem sikerült választ generálnom. Próbáld meg másképp megfogalmazni a kérdést.";
    return res.json({ answer, model: data?.model || process.env.OPENAI_MODEL || "gpt-5-mini" });
  } catch (err: any) {
    const status = Number(err?.response?.status || 0);
    const openAiError = err?.response?.data?.error || {};
    const openAiCode = String(openAiError?.code || openAiError?.type || "openai_error");
    const detail = String(openAiError?.message || err?.message || "Ismeretlen AI hiba").slice(0, 600);

    console.error("AI support chat error:", { status, code: openAiCode, detail });

    if (status === 401) {
      return res.status(502).json({ code: "invalid_api_key", message: "Az OpenAI API-kulcs érvénytelen vagy nem használható. Ellenőrizd az OPENAI_API_KEY értékét a Render Environment Variables között." });
    }
    if (status === 429) {
      return res.status(429).json({ code: openAiCode, message: "Az OpenAI API elérte a használati vagy számlázási keretet. Ellenőrizd az API Billing / Usage beállításokat.", detail });
    }
    if (status === 400) {
      return res.status(502).json({ code: openAiCode, message: "Az OpenAI API elutasította a kérést. Ellenőrizd az OPENAI_MODEL beállítást; a részletes hiba lent látható.", detail });
    }
    if (status === 403) {
      return res.status(502).json({ code: openAiCode, message: "Az API-kulcsnak nincs jogosultsága ehhez a modellhez vagy projekthez.", detail });
    }

    return res.status(502).json({ code: openAiCode, message: "Az AI támogatás átmenetileg nem elérhető.", detail });
  }
});

export default router;
