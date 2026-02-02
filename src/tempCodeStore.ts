// nagyon egyszerű in-memory store a 2FA kódokhoz
type CodeRecord = {
  code: string;
  userId: string;
  role: string;
  location_id: string | null;
  expiresAt: number; // timestamp (ms)
};

const tempCodes = new Map<string, CodeRecord>();
// kulcs: email

export function saveCodeForEmail(email: string, rec: CodeRecord) {
  tempCodes.set(email.toLowerCase(), rec);
}

export function getCodeForEmail(email: string): CodeRecord | null {
  const item = tempCodes.get(email.toLowerCase());
  if (!item) return null;
  // lejárt?
  if (Date.now() > item.expiresAt) {
    tempCodes.delete(email.toLowerCase());
    return null;
  }
  return item;
}

export function consumeCode(email: string): CodeRecord | null {
  const item = getCodeForEmail(email);
  if (!item) return null;
  tempCodes.delete(email.toLowerCase());
  return item;
}
