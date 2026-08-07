import nodemailer from "nodemailer";

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

export type OutgoingMail = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

export async function sendEmail(message: OutgoingMail) {
  console.log(`[MAIL] to=${message.to} subject=${message.subject}`);
  if (DISABLE_SMTP || !transporter) {
    console.warn("📭 SMTP küldés kihagyva; az üzenet naplózva lett.");
    return { sent: false, logged: true };
  }

  try {
    const info = await transporter.sendMail({
      from: SMTP_FROM,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html || `<p>${message.text.replace(/\n/g, "<br/>")}</p>`,
    });
    console.log("✅ E-mail elküldve, messageId:", info.messageId);
    return { sent: true, logged: false, messageId: info.messageId };
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
