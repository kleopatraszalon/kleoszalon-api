import type { Pool, PoolClient } from "pg";

export type SkillDb = Pick<Pool, "query"> | Pick<PoolClient, "query">;

export type EmployeeSkillEligibility = {
  allowed: boolean;
  legacy_unrestricted: boolean;
  blocked_service_ids: string[];
  disabled_service_ids: string[];
  expired_service_ids: string[];
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizedIds(values: unknown[]): string[] {
  return Array.from(new Set(values.map(String).map((value) => value.trim()).filter((value) => UUID_RE.test(value))));
}

export async function employeeSkillEligibility(
  db: SkillDb,
  employeeId: string,
  serviceIdsInput: unknown[],
): Promise<EmployeeSkillEligibility> {
  const serviceIds = normalizedIds(serviceIdsInput);
  if (!UUID_RE.test(employeeId) || !serviceIds.length) {
    return {
      allowed: false,
      legacy_unrestricted: false,
      blocked_service_ids: serviceIds,
      disabled_service_ids: [],
      expired_service_ids: [],
    };
  }

  const configured = await db.query(
    `SELECT EXISTS(
       SELECT 1 FROM employee_service_overrides WHERE employee_id=$1::uuid
     ) AS configured`,
    [employeeId],
  );

  // Backward compatibility: historically a worker with zero override rows was
  // treated as unrestricted. Wave II preserves that behavior until HR assigns
  // at least one service, at which point the skill matrix becomes authoritative.
  if (!configured.rows[0]?.configured) {
    return {
      allowed: true,
      legacy_unrestricted: true,
      blocked_service_ids: [],
      disabled_service_ids: [],
      expired_service_ids: [],
    };
  }

  const selected = await db.query(
    `SELECT service_id::text,
            COALESCE(can_perform,true) AS can_perform,
            qualification_valid_until
       FROM employee_service_overrides
      WHERE employee_id=$1::uuid AND service_id=ANY($2::uuid[])`,
    [employeeId, serviceIds],
  );

  const byService = new Map<string, any>(selected.rows.map((row: any) => [String(row.service_id), row]));
  const blocked: string[] = [];
  const disabled: string[] = [];
  const expired: string[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (const serviceId of serviceIds) {
    const row = byService.get(serviceId);
    if (!row) {
      blocked.push(serviceId);
      continue;
    }
    if (row.can_perform === false) {
      blocked.push(serviceId);
      disabled.push(serviceId);
      continue;
    }
    if (row.qualification_valid_until) {
      const validUntil = new Date(`${String(row.qualification_valid_until).slice(0, 10)}T00:00:00`);
      if (Number.isFinite(validUntil.getTime()) && validUntil < today) {
        blocked.push(serviceId);
        expired.push(serviceId);
      }
    }
  }

  return {
    allowed: blocked.length === 0,
    legacy_unrestricted: false,
    blocked_service_ids: blocked,
    disabled_service_ids: disabled,
    expired_service_ids: expired,
  };
}

export async function eligibleEmployeeIdsForServices(
  db: SkillDb,
  employeeIdsInput: unknown[],
  serviceIdsInput: unknown[],
): Promise<Set<string>> {
  const employeeIds = normalizedIds(employeeIdsInput);
  const serviceIds = normalizedIds(serviceIdsInput);
  if (!employeeIds.length || !serviceIds.length) return new Set<string>();

  const { rows } = await db.query(
    `SELECT emp.employee_id::text AS employee_id,
            CASE
              WHEN NOT EXISTS(
                SELECT 1 FROM employee_service_overrides all_eo
                 WHERE all_eo.employee_id=emp.employee_id
              ) THEN true
              ELSE NOT EXISTS(
                SELECT 1
                  FROM unnest($2::uuid[]) AS sid(service_id)
                 WHERE NOT EXISTS(
                   SELECT 1
                     FROM employee_service_overrides eo
                    WHERE eo.employee_id=emp.employee_id
                      AND eo.service_id=sid.service_id
                      AND COALESCE(eo.can_perform,true)=true
                      AND (eo.qualification_valid_until IS NULL OR eo.qualification_valid_until>=CURRENT_DATE)
                 )
              )
            END AS allowed
       FROM unnest($1::uuid[]) AS emp(employee_id)`,
    [employeeIds, serviceIds],
  );

  return new Set(rows.filter((row: any) => row.allowed === true).map((row: any) => String(row.employee_id)));
}
