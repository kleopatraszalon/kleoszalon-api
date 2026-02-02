import axios from "axios";

const base =
  (import.meta as any).env?.VITE_API_URL?.replace(/\/$/, "") ||
  window.location.origin;

const api = axios.create({
  baseURL: `${base}/api`,
  withCredentials: true,
  headers: { "Content-Type": "application/json" },
});

export default api; // ✅ default export
