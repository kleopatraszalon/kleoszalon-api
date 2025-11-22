import axios from "axios";

// Eldöntjük, hogy lokális vagy éles környezetben futunk
const isLocalhost =
  window.location.hostname === "localhost" ||
  window.location.hostname === "127.0.0.1";

// Nyers .env érték (Vite)
const rawEnvBase =
  (import.meta as any)?.env?.VITE_API_URL &&
  String((import.meta as any).env.VITE_API_URL).trim();

/**
 * Localhostos API-URL csak akkor engedett, ha maga az oldal is localhostról fut.
 * Ha a buildben benne maradt egy http://localhost:5000, de az oldal Renderen fut,
 * akkor azt eldobjuk, nehogy oda próbáljon kapcsolódni.
 */
function normalizeEnvBase(): string | undefined {
  if (!rawEnvBase) return undefined;

  const trimmed = rawEnvBase.replace(/\/+$/, ""); // lezáró / leszedése
  const isLocalEnvBase =
    trimmed.startsWith("http://localhost") ||
    trimmed.startsWith("http://127.0.0.1");

  if (isLocalEnvBase && !isLocalhost) {
    // Production oldalon ne használjunk localhost API-t
    return undefined;
  }

  return trimmed;
}

// 1) Megpróbáljuk az .env-ben beállított API-t használni
const envBase = normalizeEnvBase();

// 2) Ha nincs használható .env, akkor döntünk a futási környezet alapján
const base =
  envBase ||
  (isLocalhost
    ? "http://localhost:5000"
    : "https://kleoszalon-api-jon.onrender.com");

/**
 * Itt a base mindig protokoll + host (+ opcionális port), pl:
 *   - http://localhost:5000    (fejlesztés)
 *   - https://kleoszalon-api-jon.onrender.com   (Render)
 *
 * Az összes API-hívásra /api kerül a végére:
 *   GET ${base}/api/public/webshop/products
 */
const api = axios.create({
  baseURL: `${base}/api`,
  withCredentials: true,
  headers: { "Content-Type": "application/json" },
});

export default api;
