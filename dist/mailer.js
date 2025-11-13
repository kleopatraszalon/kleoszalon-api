"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = sendLoginCodeEmail;
// src/mailer.ts
const nodemailer_1 = __importDefault(require("nodemailer"));
const SMTP_HOST = process.env.SMTP_HOST || "smtp.gmail.com";
const SMTP_PORT = Number(process.env.SMTP_PORT || "587");
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER || "no-reply@example.com";
// 🔹 Ezzel tudsz SMTP-t gyakorlatilag kikapcsolni Renderen:
// Renderen állítsd: DISABLE_SMTP=1
const DISABLE_SMTP = process.env.DISABLE_SMTP === "1";
if (!SMTP_USER || !SMTP_PASS) {
    console.warn("⚠️ SMTP_USER vagy SMTP_PASS hiányzik – e-mail küldés nem fog menni!");
}
let transporter = null;
if (!DISABLE_SMTP && SMTP_USER && SMTP_PASS) {
    transporter = nodemailer_1.default.createTransport({
        host: SMTP_HOST,
        port: SMTP_PORT,
        secure: SMTP_PORT === 465, // 465 = SSL, 587 = STARTTLS
        auth: {
            user: SMTP_USER,
            pass: SMTP_PASS,
        },
        // pár timeout, hogy ne lógjon sokáig, ha mégis próbálkozunk
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 20000,
    });
}
else {
    console.warn("📭 DISABLE_SMTP=1 vagy hiányzó SMTP hitelesítés – e-mail csak LOG-ban lesz.");
}
async function sendLoginCodeEmail(to, code) {
    // 🔹 MINDIG logoljuk – fejlesztéshez így is használható
    console.log(`[AUTH] [LOGIN CODE MAIL] to=${to} code=${code}`);
    // Ha ki van kapcsolva az SMTP (pl. Renderen): csak log, és kilépünk
    if (DISABLE_SMTP || !transporter) {
        console.warn("📭 SMTP küldés kihagyva (DISABLE_SMTP=1 vagy nincs transporter).");
        return;
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
    console.log("📧 E-mail küldése kóddal (SMTP):", {
        host: SMTP_HOST,
        port: SMTP_PORT,
        from: mailOptions.from,
        to: mailOptions.to,
    });
    try {
        const info = await transporter.sendMail(mailOptions);
        console.log("✅ E-mail elküldve, messageId:", info.messageId);
        if (info.accepted && info.accepted.length > 0) {
            console.log("✅ Elfogadott címek:", info.accepted);
        }
        if (info.rejected && info.rejected.length > 0) {
            console.warn("⚠️ Elutasított címek:", info.rejected);
        }
    }
    catch (err) {
        console.error("❌ E-mail küldési hiba:", err);
    }
}
