// src/utils/api.ts

// API alap URL:
// - ha van REACT_APP_API_URL, azt használjuk (pl. Render-en: https://kleoszalon-api.onrender.com)
// - különben default: http://localhost:5000 (helyi backend)
const API_BASE = (process.env.REACT_APP_API_URL || "http://localhost:5000").replace(
  /\/$/,
  ""
);

/**
 * Egységes API hívás:
 * - path lehet relatív ("/api/appointments") vagy teljes URL
 * - credentials: "include" a cookie-s auth miatt
 * - JSON body/response kezelés
 */
export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const url =
    path.startsWith("http://") || path.startsWith("https://")
      ? path
      : `${API_BASE}${path}`;

  const res = await fetch(url, {
    credentials: "include",
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers || {}),
    },
  });

  if (!res.ok) {
    let msg = `API hiba: ${res.status} ${res.statusText}`;
    try {
      const text = await res.text();
      if (text) msg += ` – ${text}`;
    } catch {
      // ha nem olvasható a body, nem baj
    }
    throw new Error(msg);
  }

  // ha nincs body (204), adjunk vissza üres objectet/arrayt
  try {
    return (await res.json()) as T;
  } catch {
    return {} as T;
  }
}

export default apiFetch;
