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
  return Array.from(
    new Set(
      values
        .map(String)
        .map((value) => value.trim().toLowerCase())
        .filter((value) => UUID_RE.test(value)),
    ),
  );
}

export async function employeeSkillEligibility(
  db: SkillDb,
  employeeIdInput: string,
  serviceIdsInput: unknown[],
): Promise<EmployeeSkillEligibility> {
  const employeeId = String(employeeIdInput || "").trim().toLowerCase();
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

  // Backward compatibility: until HR configures at least one override row for
  // an employee, historical unrestricted booking behavior remains unchanged.
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
            COALESCE(qualification_valid_until < CURRENT_DATE,false) AS qualification_expired
       FROM employee_service_overrides
      WHERE employee_id=$1::uuid AND service_id=ANY($2::uuid[])`,
    [employeeId, serviceIds],
  );

  const byService = new Map<string, any>(
    selected.rows.map((row: any) => [String(row.service_id).toLowerCase(), row]),
  );
  const blocked: string[] = [];
  const disabled: string[] = [];
  const expired: string[] = [];

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
    if (row.qualification_expired === true) {
      blocked.push(serviceId);
      expired.push(serviceId);
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
