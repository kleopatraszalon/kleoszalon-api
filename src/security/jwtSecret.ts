const configuredSecret = String(process.env.JWT_SECRET || "").trim();
const isProduction = String(process.env.NODE_ENV || "").toLowerCase() === "production";

if (isProduction && !configuredSecret) {
  throw new Error("JWT_SECRET is required in production. Refusing to start with a default signing secret.");
}

/**
 * Production always requires an explicit JWT_SECRET.
 * The fallback is intentionally limited to local/non-production development.
 */
export const JWT_SECRET = configuredSecret || "kleo_local_dev_only_change_me";

export default JWT_SECRET;
