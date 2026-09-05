export type CanonicalRole =
  | "admin"
  | "manager"
  | "location_manager"
  | "salon_manager"
  | "hr_manager"
  | "receptionist"
  | "employee"
  | "customer";

const ALIASES: Record<string, CanonicalRole> = {
  admin: "admin",
  administrator: "admin",
  rendszergazda: "admin",
  superadmin: "admin",
  super_admin: "admin",

  manager: "manager",
  "vezető": "manager",
  vezeto: "manager",

  location_manager: "location_manager",
  business_manager: "location_manager",
  "üzletvezető": "location_manager",
  uzletvezeto: "location_manager",
  store_manager: "location_manager",
  branch_manager: "location_manager",

  salon_manager: "salon_manager",
  "szalonvezető": "salon_manager",
  szalonvezeto: "salon_manager",

  hr: "hr_manager",
  hr_manager: "hr_manager",
  human_resources: "hr_manager",
  "személyügy": "hr_manager",
  szemelyugy: "hr_manager",

  receptionist: "receptionist",
  reception: "receptionist",
  "recepciós": "receptionist",
  recepcios: "receptionist",
  "recepció": "receptionist",
  recepcio: "receptionist",

  employee: "employee",
  staff: "employee",
  worker: "employee",
  "munkatárs": "employee",
  munkatars: "employee",
  colleague: "employee",

  customer: "customer",
  client: "customer",
  guest: "customer",
  "ügyfél": "customer",
  ugyfel: "customer",
  "vendég": "customer",
  vendeg: "customer",
};

export function normalizeRoleKey(value: unknown): string {
  const raw = String(value ?? "").trim().toLowerCase();
  if (/^(?:receptionist|reception|recepciós|recepcios|recepció|recepcio)(?:[\s_-]*\d+)?$/u.test(raw)) return "receptionist";
  return ALIASES[raw] || raw;
}

export function parseRoleKeys(raw: unknown): string[] {
  let values: unknown[] = [];
  if (Array.isArray(raw)) values = raw;
  else {
    const text = String(raw ?? "").trim();
    if (!text) return [];
    try {
      const parsed = JSON.parse(text);
      values = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      values = text.split(",").map(x => x.replace(/[\[\]"]/g, "").trim());
    }
  }
  return Array.from(new Set(values.map(normalizeRoleKey).filter(Boolean)));
}

export function hasAnyRole(raw: unknown, allowed: readonly string[]): boolean {
  const roles = parseRoleKeys(raw);
  const wanted = new Set(allowed.map(normalizeRoleKey));
  return roles.some(role => wanted.has(role));
}

export function isAdminRole(raw: unknown): boolean {
  return parseRoleKeys(raw).includes("admin");
}