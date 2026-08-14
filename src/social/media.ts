import path from "path";
import { mkdir, writeFile } from "fs/promises";
import { socialConfig } from "./config";
import type { SocialPlatform } from "./types";

export function socialText(value: unknown, max = 5000) {
  return String(value ?? "").trim().slice(0, max);
}

export function stripSocialHtml(value: unknown) {
  return socialText(value, 12000)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function isUuid(value: unknown) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}

export function publicHttpUrl(value: unknown) {
  const s = socialText(value, 16000000);
  return /^https?:\/\//i.test(s) ? s : "";
}

export function addSocialTracking(urlValue: string | null | undefined, platform: SocialPlatform, campaignId: string, sourceType: string) {
  const fallback = sourceType === "job" ? socialConfig.publicRecruitmentUrl : `${socialConfig.publicSiteUrl}/foglalas`;
  const base = publicHttpUrl(urlValue) || fallback;
  try {
    const url = new URL(base);
    url.searchParams.set("utm_source", platform);
    url.searchParams.set("utm_medium", "social");
    url.searchParams.set("utm_campaign", `vir-${sourceType}-${campaignId}`);
    return url.toString();
  } catch {
    return base;
  }
}

export async function materializeSocialMedia(raw: unknown, campaignId: string, kind: "image" | "video") {
  const value = socialText(raw, 16000000);
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;

  const match = value.match(/^data:([^;]+);base64,(.+)$/s);
  if (!match) throw new Error(`${kind === "image" ? "A kép" : "A videó"} csak nyilvános HTTPS URL vagy feltöltött média lehet.`);

  const mime = match[1].toLowerCase();
  const allowed = kind === "image"
    ? new Map<string, string>([["image/jpeg", "jpg"], ["image/png", "png"], ["image/webp", "webp"]])
    : new Map<string, string>([["video/mp4", "mp4"], ["video/quicktime", "mov"], ["video/webm", "webm"]]);
  const ext = allowed.get(mime);
  if (!ext) throw new Error(`Nem támogatott ${kind === "image" ? "kép" : "videó"} formátum: ${mime}`);

  const bytes = Buffer.from(match[2], "base64");
  const maxBytes = kind === "image" ? 8 * 1024 * 1024 : 64 * 1024 * 1024;
  if (!bytes.length || bytes.length > maxBytes) throw new Error(`${kind === "image" ? "A kép" : "A videó"} mérete nem megfelelő.`);

  const directory = path.join(process.cwd(), "uploads", "social");
  await mkdir(directory, { recursive: true });
  const fileName = `${campaignId}-${kind}.${ext}`;
  await writeFile(path.join(directory, fileName), bytes);
  return `${socialConfig.publicApiUrl}/uploads/social/${fileName}`;
}
