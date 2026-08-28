import { Router, type NextFunction, type Request, type Response } from "express";
import db from "../db";
import {
  eligibleEmployeeIdsForServices,
  employeeSkillEligibility,
} from "../booking/employeeSkillEligibility";

const router = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function serviceIdsFromQuery(req: Request): string[] {
  return String(req.query.service_ids || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function serviceIdsFromBody(req: Request): string[] {
  return Array.isArray(req.body?.service_ids)
    ? req.body.service_ids.map(String).map((value: string) => value.trim()).filter(Boolean)
    : [];
}

router.use(async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (req.method === "POST" && req.path === "/book") {
      const employeeId = String(req.body?.employee_id || "").trim();
      const serviceIds = serviceIdsFromBody(req);
      if (!UUID_RE.test(employeeId) || !serviceIds.length || serviceIds.some((id) => !UUID_RE.test(id))) {
        return next();
      }

      const eligibility = await employeeSkillEligibility(db, employeeId, serviceIds);
      if (!eligibility.allowed) {
        return res.status(409).json({
          error: "A kiválasztott szakember jelenlegi szakmai jogosultsága alapján nem foglalható minden kiválasztott szolgáltatásra.",
          code: "EMPLOYEE_SKILL_NOT_ELIGIBLE",
        });
      }
      return next();
    }

    if (req.method === "GET" && req.path === "/availability") {
      const serviceIds = serviceIdsFromQuery(req);
      if (!serviceIds.length || serviceIds.some((id) => !UUID_RE.test(id))) return next();

      const originalJson = res.json.bind(res);
      (res as any).json = (body: any) => {
        if (!body || !Array.isArray(body.slots) || body.slots.length === 0) return originalJson(body);

        const employeeIds = Array.from(
          new Set(body.slots.map((slot: any) => String(slot?.employee_id || "")).filter((id: string) => UUID_RE.test(id))),
        );

        void eligibleEmployeeIdsForServices(db, employeeIds, serviceIds)
          .then((eligible) => {
            const slots = body.slots.filter((slot: any) => eligible.has(String(slot?.employee_id || "")));
            return originalJson({
              ...body,
              slots,
              skill_guard: {
                applied: true,
                removed_slots: Math.max(0, body.slots.length - slots.length),
              },
            });
          })
          .catch(next);

        return res;
      };
    }

    return next();
  } catch (error) {
    return next(error);
  }
});

export default router;
