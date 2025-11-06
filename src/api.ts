import axios from "axios";

const base = (import.meta as any).env?.VITE_API_URL?.replace(/\/$/, "") 
  || "http://localhost:10000"; // Renderen ez a saját backend URL-ed

export const api = axios.create({
  baseURL: base, // Pl.: https://<backend-domain>/api
  withCredentials: true,
  headers: { "Content-Type": "application/json" },
});
