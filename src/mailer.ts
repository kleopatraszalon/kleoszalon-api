// src/mailer.ts
import nodemailer from "nodemailer";

const SMTP_HOST = process.env.SMTP_HOST || "smtp.gmail.com";
const SMTP_PORT = Number(process.env.SMTP_PORT || "587");
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER || "no-reply@example.com";

if (!SMTP_USER || !SMTP_PASS) {
  console.warn("⚠️ SMTP_USER vagy SMTP_PASS hiányzik – e-mail küldés nem fog menni!");
}

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_PORT === 465, // 465 = SSL, 587 = STARTTLS
  auth: {
    user: SMTP_USER,
    pass: SMTP_PASS,
  },
});

export default async function sendLoginCodeEmail(to: string, code: string) {
  if (!SMTP_USER || !SMTP_PASS) {
    console.error("❌ SMTP konfiguráció hiányzik, nem lehet levelet küldeni.");
    throw new Error("SMTP configuration missing");
  }

  const mailOptions = {
    from: SMTP_FROM,
    to,
    subject: "Kleopátra Szalon – belépési kód",
    text: `Az Ön belépési kódja: ${code}`,
    html: `
      <p>Az Ön belépési kódja:</p>
      <p style="font-size: 22px; font-weight: bold; letter-spacing: 3px;">
        ${code}
      </p>
      <p>A kód néhány percig érvényes.</p>
    `,
  };

  console.log("📧 E-mail küldése kóddal:", {
    host: SMTP_HOST,
    port: SMTP_PORT,
    from: mailOptions.from,
    to: mailOptions.to,
  });

  const info = await transporter.sendMail(mailOptions);

  console.log("✅ E-mail elküldve, messageId:", info.messageId);
  if (info.accepted && info.accepted.length > 0) {
    console.log("✅ Elfogadott címek:", info.accepted);
  }
  if (info.rejected && info.rejected.length > 0) {
    console.warn("⚠️ Elutasított címek:", info.rejected);
  }

  return info;
}
