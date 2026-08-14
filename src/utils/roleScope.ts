import { AuthRequest } from "../middleware/auth";

function roles(req: AuthRequest) {
  const raw = req.user?.role;
  return (Array.isArray(raw) ? raw : [raw])
    .map((role) => String(role || "").trim().toLowerCase())
    .filter(Boolean);
}

export function isAdmin(req: AuthRequest) {
  return roles(req).includes("admin");
}

export function isManager(req: AuthRequest) {
  const current = roles(req);
  return current.some((role) => role === "manager" || role === "location_manager" || role === "admin");
}

export function getScopedLocationId(req: AuthRequest, requestedLocationId?: string | null) {
  if (isAdmin(req)) return requestedLocationId || null;
  return req.user?.location_id ? String(req.user.location_id) : requestedLocationId || null;
}

export function canSeeFinancials(req: AuthRequest) {
  const current = roles(req);
  return current.some((role) => role === "admin" || role === "manager" || role === "location_manager");
}