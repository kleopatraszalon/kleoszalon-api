import type { NextFunction, Request, Response } from "express";
import db from "../db";

export type ProcessIntegrityReleaseGate = {
  key: string;
  group: string;
  label: string;
  status: "pass" | "fail";
  blocking: true;
  editable: false;
  message: string;
  evidence: string | null;
  source: "business-process-integrity";
};

const TZ = "Europe/Budapest";
const GLOBAL_LOCATION_KEY = "__all__";

function previousControlDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now() - 86_400_000));
}

async function tableExists(table: string) {
  const { rows } = await db.query("SELECT to_regclass($1) IS NOT NULL ok", [`public.${table}`]);
  return Boolean(rows[0]?.ok);
}

export async function buildProcessIntegrityReleaseGate(): Promise<ProcessIntegrityReleaseGate> {
  const businessDate = previousControlDate();
  try {
    if (!(await tableExists("business_process_integrity_runs"))) {
      return {
        key: "business.process_integrity",
        group: "Üzleti integritás",
        label: "Előző üzleti nap teljes folyamatintegritása",
        status: "fail",
        blocking: true,
        editable: false,
        message: `NO-GO: a ${businessDate} naphoz a Business Process Integrity séma vagy futási bizonyíték nem érhető el.`,
        evidence: null,
        source: "business-process-integrity",
      };
    }

    const { rows } = await db.query(
      `SELECT business_date::text business_date,status,process_count,passed_count,warning_count,failed_count,
              exception_count,generated_at
         FROM business_process_integrity_runs
        WHERE business_date=$1::date AND location_key=$2
        LIMIT 1`,
      [businessDate, GLOBAL_LOCATION_KEY],
    );
    const row = rows[0];
    if (!row) {
      return {
        key: "business.process_integrity",
        group: "Üzleti integritás",
        label: "Előző üzleti nap teljes folyamatintegritása",
        status: "fail",
        blocking: true,
        editable: false,
        message: `NO-GO: a ${businessDate} üzleti napra nincs globális folyamatintegritási futás.`,
        evidence: null,
        source: "business-process-integrity",
      };
    }

    const exceptionCount = Number(row.exception_count || 0);
    const passed = String(row.status || "").toLowerCase() === "ok" && exceptionCount === 0;
    const evidence = `business_date=${row.business_date}; status=${row.status}; processes=${Number(row.process_count || 0)}; passed=${Number(row.passed_count || 0)}; warnings=${Number(row.warning_count || 0)}; failed=${Number(row.failed_count || 0)}; exceptions=${exceptionCount}; generated_at=${new Date(row.generated_at).toISOString()}`;

    return {
      key: "business.process_integrity",
      group: "Üzleti integritás",
      label: "Előző üzleti nap teljes folyamatintegritása",
      status: passed ? "pass" : "fail",
      blocking: true,
      editable: false,
      message: passed
        ? `PASS: a ${row.business_date} üzleti nap pénzügyi, készlet-, beszerzési és rendszerintegritási kontrollja eltérés nélkül zárt.`
        : `NO-GO: a ${row.business_date} üzleti nap folyamatintegritása ${row.status}; ${exceptionCount} kivétel, ${Number(row.failed_count || 0)} kritikus és ${Number(row.warning_count || 0)} figyelmeztetéses folyamat maradt.`,
      evidence,
      source: "business-process-integrity",
    };
  } catch (error: any) {
    return {
      key: "business.process_integrity",
      group: "Üzleti integritás",
      label: "Előző üzleti nap teljes folyamatintegritása",
      status: "fail",
      blocking: true,
      editable: false,
      message: `NO-GO: a folyamatintegritási release gate nem ellenőrizhető (${error?.message || "ismeretlen adatbázishiba"}).`,
      evidence: null,
      source: "business-process-integrity",
    };
  }
}

function recomputeReleaseDecision(body: any, gate: ProcessIntegrityReleaseGate) {
  if (!body || !Array.isArray(body.gates)) return body;
  const gates = [...body.gates.filter((item: any) => item?.key !== gate.key), gate];
  const blocking = gates.filter((item: any) => Boolean(item?.blocking));
  const blockers = blocking.filter((item: any) => item?.status !== "pass");
  const summary = {
    total: gates.length,
    pass: gates.filter((item: any) => item?.status === "pass").length,
    warning: gates.filter((item: any) => item?.status === "warning").length,
    fail: gates.filter((item: any) => item?.status === "fail").length,
    pending: gates.filter((item: any) => item?.status === "pending").length,
    blocking_total: blocking.length,
    blocking_open: blockers.length,
  };
  return {
    ...body,
    release_ready: blockers.length === 0,
    decision: blockers.length === 0 ? "GO" : "NO-GO",
    summary,
    blockers: blockers.map((item: any) => ({ key: item.key, label: item.label, status: item.status, message: item.message })),
    gates,
    meta: {
      ...(body.meta || {}),
      process_integrity_gate: gate.status,
      process_integrity_evidence: gate.evidence,
    },
  };
}

export async function enforceProcessIntegrityReleaseGate(req: Request, res: Response, next: NextFunction) {
  if (req.method !== "GET" || (req.path !== "/" && req.path !== "")) return next();
  const gate = await buildProcessIntegrityReleaseGate();
  const originalJson = res.json.bind(res);
  res.json = ((body: any) => originalJson(recomputeReleaseDecision(body, gate))) as typeof res.json;
  next();
}
