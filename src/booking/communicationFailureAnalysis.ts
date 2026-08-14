export type BookingCommunicationFailureCauseKey =
  | "configuration"
  | "authentication"
  | "invalid_recipient"
  | "rate_limit"
  | "network"
  | "provider_rejected"
  | "unknown";

export type BookingCommunicationFailureCause = {
  key: BookingCommunicationFailureCauseKey;
  label: string;
  priority: "high" | "medium" | "low";
  recommended_action: string;
};

const CAUSES: Record<BookingCommunicationFailureCauseKey, BookingCommunicationFailureCause> = {
  configuration: {
    key: "configuration",
    label: "Szolgáltató / konfiguráció",
    priority: "high",
    recommended_action: "Ellenőrizd az SMTP/SMS környezeti változókat és a szolgáltató engedélyezését.",
  },
  authentication: {
    key: "authentication",
    label: "Hitelesítési hiba",
    priority: "high",
    recommended_action: "Ellenőrizd a szolgáltatói felhasználót, jelszót/token-t és a küldési jogosultságot.",
  },
  invalid_recipient: {
    key: "invalid_recipient",
    label: "Hibás vagy elutasított címzett",
    priority: "medium",
    recommended_action: "A CRM-ben javítsd vagy tiltsd a hibás e-mail címet/telefonszámot; csak javítás után küldd újra.",
  },
  rate_limit: {
    key: "rate_limit",
    label: "Küldési limit / kvóta",
    priority: "high",
    recommended_action: "Ellenőrizd a szolgáltatói kvótát és a küldési sebességet; szükség esetén vezess be lassítást.",
  },
  network: {
    key: "network",
    label: "Hálózati / timeout / TLS hiba",
    priority: "high",
    recommended_action: "Ellenőrizd a hálózati elérést, DNS-t, TLS kapcsolatot és a szolgáltató rendelkezésre állását.",
  },
  provider_rejected: {
    key: "provider_rejected",
    label: "Szolgáltató által elutasítva",
    priority: "medium",
    recommended_action: "Vizsgáld meg a szolgáltatói válaszkódot, feladói reputációt és a levél/SMS tartalmát.",
  },
  unknown: {
    key: "unknown",
    label: "Ismeretlen / egyéb hiba",
    priority: "medium",
    recommended_action: "Vizsgáld meg a normalizált hibaüzenet mintáit és egészítsd ki az osztályozást, ha új hibatípus jelenik meg.",
  },
};

export function stripBookingCommunicationRetryPrefix(value: unknown): string {
  return String(value || "")
    .replace(/^Küldési hiba, újrapróbálás\s+\d+\/\d+:\s*/i, "")
    .replace(/^Végleges küldési hiba\s+\d+\/\d+:\s*/i, "")
    .trim();
}

export function normalizeBookingCommunicationFailure(value: unknown): string {
  return stripBookingCommunicationRetryPrefix(value)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<email>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "<id>")
    .replace(/\+?\d[\d\s()./-]{7,}\d/g, "<phone>")
    .replace(/\s+/g, " ")
    .slice(0, 240) || "Nincs rögzített hibaüzenet";
}

export function classifyBookingCommunicationFailure(
  value: unknown,
  channel: unknown = "email"
): BookingCommunicationFailureCause {
  const text = stripBookingCommunicationRetryPrefix(value).toLowerCase();
  const ch = String(channel || "").toLowerCase();

  if (
    text.includes("nincs konfigurálva") ||
    text.includes("not configured") ||
    text.includes("missing configuration") ||
    text.includes("missing credential") ||
    text.includes("smtp_user") ||
    text.includes("smtp_pass") ||
    text.includes("sms_gateway_url") ||
    (ch === "sms" && text.includes("gateway"))
  ) return CAUSES.configuration;

  if (
    text.includes("eauth") ||
    text.includes("authentication") ||
    text.includes("invalid login") ||
    text.includes("username and password not accepted") ||
    text.includes("unauthorized") ||
    text.includes("forbidden") ||
    /(^|\D)(401|403|534|535)(\D|$)/.test(text)
  ) return CAUSES.authentication;

  if (
    text.includes("eenvelope") ||
    text.includes("invalid recipient") ||
    text.includes("invalid address") ||
    text.includes("recipient address rejected") ||
    text.includes("mailbox unavailable") ||
    text.includes("user unknown") ||
    text.includes("no such user") ||
    text.includes("address rejected") ||
    /5\.1\.1/.test(text) ||
    /(^|\D)(550|551|553)(\D|$)/.test(text)
  ) return CAUSES.invalid_recipient;

  if (
    text.includes("rate limit") ||
    text.includes("rate-limit") ||
    text.includes("quota") ||
    text.includes("too many requests") ||
    text.includes("sending limit") ||
    /(^|\D)429(\D|$)/.test(text)
  ) return CAUSES.rate_limit;

  if (
    text.includes("etimedout") ||
    text.includes("econnreset") ||
    text.includes("econnrefused") ||
    text.includes("enotfound") ||
    text.includes("eai_again") ||
    text.includes("socket hang up") ||
    text.includes("timeout") ||
    text.includes("timed out") ||
    text.includes("getaddrinfo") ||
    text.includes("network") ||
    text.includes("tls") ||
    text.includes("certificate")
  ) return CAUSES.network;

  if (
    text.includes("rejected") ||
    text.includes("blocked") ||
    text.includes("denied") ||
    text.includes("spam") ||
    text.includes("responsecode") ||
    /(^|\D)[45]\d\d(\D|$)/.test(text)
  ) return CAUSES.provider_rejected;

  return CAUSES.unknown;
}
