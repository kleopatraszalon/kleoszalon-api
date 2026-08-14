import nodemailer from "nodemailer";
import crypto from "crypto";
import { appendRawMessageToSent } from "./services/complaintMailbox";

const SMTP_HOST = process.env.SMTP_HOST || "smtp.gmail.com";
const SMTP_PORT = Number(process.env.SMTP_PORT || "587");
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER || "no-reply@example.com";
const DISABLE_SMTP = process.env.DISABLE_SMTP === "1";

if (!SMTP_USER || !SMTP_PASS) {
  console.warn("⚠️ SMTP_USER vagy SMTP_PASS hiányzik – e-mail küldés nem fog menni!");
}

let transporter: nodemailer.Transporter | null = null;
if (!DISABLE_SMTP && SMTP_USER && SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
} else {
  console.warn("📭 DISABLE_SMTP=1 vagy hiányzó SMTP hitelesítés – e-mail csak LOG-ban lesz.");
}

export type MailAttachment = {
  filename: string;
  content: Buffer | string;
  contentType?: string;
};

export type OutgoingMail = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: MailAttachment[];
};

export type EmailTransportHealth = {
  ok: boolean;
  configured: boolean;
  enabled: boolean;
  mode: "live" | "disabled" | "unconfigured" | "error";
  error_code: string | null;
  authentication_error: boolean;
  checked_at: string;
};

function authLikeError(error: any): boolean {
  const text = `${error?.code || ""} ${error?.responseCode || ""} ${error?.message || ""}`.toLowerCase();
  return text.includes("eauth") || text.includes("authentication") || text.includes("invalid login") || text.includes("username and password not accepted") || /(^|\D)(401|403|534|535)(\D|$)/.test(text);
}

export async function verifyEmailTransport(): Promise<EmailTransportHealth> {
  const checked_at = new Date().toISOString();
  if (DISABLE_SMTP) return { ok: false, configured: Boolean(SMTP_USER && SMTP_PASS), enabled: false, mode: "disabled", error_code: "SMTP_DISABLED", authentication_error: false, checked_at };
  if (!SMTP_USER || !SMTP_PASS || !transporter) return { ok: false, configured: false, enabled: true, mode: "unconfigured", error_code: "SMTP_NOT_CONFIGURED", authentication_error: false, checked_at };
  try {
    await transporter.verify();
    return { ok: true, configured: true, enabled: true, mode: "live", error_code: null, authentication_error: false, checked_at };
  } catch (error: any) {
    return {
      ok: false,
      configured: true,
      enabled: true,
      mode: "error",
      error_code: String(error?.code || error?.responseCode || "SMTP_VERIFY_FAILED").slice(0, 80),
      authentication_error: authLikeError(error),
      checked_at,
    };
  }
}

function encHeader(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value,"utf8").toString("base64")}?=`;
}
function b64Lines(value: Buffer | string): string {
  const b64 = Buffer.isBuffer(value) ? value.toString("base64") : Buffer.from(value,"utf8").toString("base64");
  return b64.match(/.{1,76}/g)?.join("\r\n") || "";
}
function buildSentMime(message: OutgoingMail, messageId?: string): Buffer {
  const mixed = `kleo-mixed-${crypto.randomBytes(8).toString("hex")}`;
  const alt = `kleo-alt-${crypto.randomBytes(8).toString("hex")}`;
  const html = message.html || `<p>${message.text.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\n/g,"<br/>")}</p>`;
  const id = messageId || `<${crypto.randomUUID()}@kleoszalon.hu>`;
  const lines: string[] = [
    `From: ${encHeader(String(SMTP_FROM))}`,
    `To: ${message.to}`,
    `Subject: ${encHeader(message.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${id}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
    "",
    `--${mixed}`,
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    "",
    `--${alt}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64Lines(message.text),
    `--${alt}`,
    `Content-Type: text/html; charset=UTF-8`,
    "Content-Transfer-Encoding: base64",
    "",
    b64Lines(html),
    `--${alt}--`,
  ];
  for (const attachment of message.attachments || []) {
    const filename = encHeader(String(attachment.filename || "attachment.bin").replace(/[\r\n"]/g,"_"));
    lines.push(
      `--${mixed}`,
      `Content-Type: ${attachment.contentType || "application/octet-stream"}; name="${filename}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${filename}"`,
      "",
      b64Lines(attachment.content),
    );
  }
  lines.push(`--${mixed}--`, "");
  return Buffer.from(lines.join("\r\n"), "utf8");
}

export async function sendEmail(message: OutgoingMail) {
  console.log(`[MAIL] to=${message.to} subject=${message.subject} attachments=${message.attachments?.length || 0}`);
  if (DISABLE_SMTP || !transporter) {
    console.warn("📭 SMTP küldés kihagyva; az üzenet naplózva lett.");
    return { sent: false, logged: true, imapSaved: false };
  }

  try {
    const info = await transporter.sendMail({
      from: SMTP_FROM,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html || `<p>${message.text.replace(/\n/g, "<br/>")}</p>`,
      attachments: message.attachments,
    });
    console.log("✅ E-mail elküldve, messageId:", info.messageId);
    let imapSaved = false;
    try {
      imapSaved = await appendRawMessageToSent(buildSentMime(message, info.messageId));
      if (imapSaved) console.log("✅ E-mail IMAP Sent mappába is mentve:", info.messageId);
    } catch (imapError: any) {
      console.warn("⚠️ SMTP sikeres, de az IMAP Sent szinkron nem sikerült:", imapError?.message || imapError);
    }
    return { sent: true, logged: false, messageId: info.messageId, imapSaved };
  } catch (err) {
    console.error("❌ E-mail küldési hiba:", err);
    throw err;
  }
}

export default async function sendLoginCodeEmail(to: string, code: string) {
  console.log(`[AUTH] [LOGIN CODE MAIL] to=${to} code=${code}`);
  await sendEmail({
    to,
    subject: "Kleopátra Szalon – belépési kód",
    text: `Az Ön belépési kódja: ${code}\nA kód néhány percig érvényes.`,
    html: `<p>Az Ön belépési kódja:</p><p style="font-size:22px;font-weight:bold;letter-spacing:3px">${code}</p><p>A kód néhány percig érvényes.</p>`,
  });
}
