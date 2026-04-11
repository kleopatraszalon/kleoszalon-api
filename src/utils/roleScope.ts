import { AuthRequest } from "../middleware/auth";

export function isAdmin(req: AuthRequest) {
  return (req.user?.role || "").toLowerCase() === "admin";
}

export function isManager(req: AuthRequest) {
  const role = (req.user?.role || "").toLowerCase();
  return role === "manager" || role === "location_manager" || role === "admin";
}

export function getScopedLocationId(req: AuthRequest, requestedLocationId?: string | null) {
  if (isAdmin(req)) return requestedLocationId || null;
  return req.user?.location_id ? String(req.user.location_id) : requestedLocationId || null;
}

export function canSeeFinancials(req: AuthRequest) {
  const role = (req.user?.role || "").toLowerCase();
  return role === "admin" || role === "manager" || role === "location_manager";
}
