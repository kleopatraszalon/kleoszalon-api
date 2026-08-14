import { Router, Response, NextFunction } from "express";
import { AuthRequest, requireAuth } from "../middleware/auth";
import clientFormVersionsRouter from "./clientFormVersions";

const router = Router();

function canonicalRole(value: unknown): string {
  const role = String(value || "").trim().toLowerCase();
  if (["administrator", "rendszergazda", "superadmin", "super_admin"].includes(role)) return "admin";
  if (["üzletvezető", "uzletvezeto", "store_manager", "branch_manager"].includes(role)) return "location_manager";
  if (["szalonvezető", "szalonvezeto"].includes(role)) return "salon_manager";
  return role;
}

function roleList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(canonicalRole).filter(Boolean);
  const source = String(raw ?? "");
  try {
    const parsed = JSON.parse(source);
    if (Array.isArray(parsed)) return parsed.map(canonicalRole).filter(Boolean);
    if (parsed != null) return [canonicalRole(parsed)].filter(Boolean);
  } catch {}
  return source
    .split(",")
    .map(value => canonicalRole(value.replace(/[\[\]"]/g, "")))
    .filter(Boolean);
}

function normalizeClientFormRoles(req: AuthRequest, _res: Response, next: NextFunction) {
  if (req.user) {
    const roles = roleList(req.user.role);
    if (roles.length) req.user.role = roles.join(",") as any;
  }
  next();
}

router.use(requireAuth);
router.use(normalizeClientFormRoles);
router.use(clientFormVersionsRouter);

export default router;
