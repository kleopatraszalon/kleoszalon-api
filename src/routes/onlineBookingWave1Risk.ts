import { Router, type Request, type Response, type NextFunction } from "express";
import db from "../db";
import {
  bookingValueFromServices,
  calculateClientNoShowRisk,
  createDepositRequirement,
  dynamicDepositDecision,
  ensureVirWave1Schema,
  loadAutomationPolicy,
  resolveClientByContact,
} from "../booking/virWave1Engine";

const router = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

router.use("/book", async (req: Request, res: Response, next: NextFunction) => {
  if (req.method !== "POST") return next();
  try {
    await ensureVirWave1Schema();
    const locationId = String(req.body?.location_id || "").trim();
    const serviceIds = Array.isArray(req.body?.service_ids) ? req.body.service_ids.map(String).filter((id: string) => UUID_RE.test(id)) : [];
    const phone = String(req.body?.phone || "").trim();
    const email = String(req.body?.email || "").trim();
    if (!UUID_RE.test(locationId) || !serviceIds.length) return next();

    const clientId = await resolveClientByContact(locationId, phone, email);
    const risk = await calculateClientNoShowRisk(clientId);
    const policy = await loadAutomationPolicy(locationId);
    const services = (await db.query(`SELECT id::text,COALESCE(promo_price,list_price,base_price,0)::numeric price FROM services WHERE id=ANY($1::uuid[]) AND COALESCE(is_active,true)=true`, [serviceIds])).rows;
    const bookingValue = bookingValueFromServices(services);
    const deposit = dynamicDepositDecision(risk, policy, bookingValue);
    const originalJson = res.json.bind(res);
    let finalized = false;

    (res as any).json = (body: any) => {
      if (finalized) return originalJson(body);
      const appointmentId = String(body?.id || "");
      const successfulBooking = res.statusCode >= 200 && res.statusCode < 300 && UUID_RE.test(appointmentId);
      if (!successfulBooking) return originalJson(body);
      finalized = true;
      void (async () => {
        let requirement: any = null;
        if (deposit.required && policy.mode === "assisted") {
          requirement = await createDepositRequirement(appointmentId, clientId, locationId, risk.score, deposit.percent, deposit.amount);
          await db.query(`INSERT INTO appointment_change_log(appointment_id,action,actor_key,after_data,note) VALUES($1::uuid,'dynamic_deposit_assessed','vir-wave1',$2::jsonb,$3)`, [appointmentId, JSON.stringify({ risk_score: risk.score, risk_level: risk.level, deposit_percent: deposit.percent, deposit_amount: deposit.amount, deposit_requirement_id: requirement?.id || null }), `VIR I. hullám dinamikus előleg: ${deposit.amount.toLocaleString("hu-HU")} Ft`]).catch(() => undefined);
        }
        originalJson({
          ...body,
          vir_wave1: {
            no_show_score: risk.score,
            risk_level: risk.level,
            deposit_required: Boolean(deposit.required && policy.mode === "assisted"),
            deposit_recommended: Boolean(deposit.required),
            deposit_percent: deposit.percent,
            deposit_amount: deposit.amount,
            deposit_status: requirement?.status || (deposit.required ? "recommended" : "not_required"),
            deposit_requirement_id: requirement?.id || null,
            automation_mode: policy.mode,
          },
        });
      })().catch((error) => {
        console.error("[vir-wave1] booking risk envelope failed", error);
        originalJson({ ...body, vir_wave1: { no_show_score: risk.score, risk_level: risk.level, deposit_required: false, deposit_status: "assessment_error" } });
      });
      return res;
    };
    return next();
  } catch (error) {
    console.warn("[vir-wave1] risk assessment fallback", error);
    return next();
  }
});

export default router;
