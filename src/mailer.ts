import nodemailer from "nodemailer";

const user = process.env.SMTP_USER;
const pass = process.env.SMTP_PASS;

console.log("🧩 SMTP_USER:", user);
console.log("🧩 SMTP_PASS:", pass ? "✅ van" : "❌ hiányzik");

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: Number(process.env.SMTP_PORT) || 587,
  secure: false,
  auth: {
    user,
    pass,
  },
});

export default async function sendLoginCodeEmail(to: string, code: string) {
  try {
    console.log("📨 E-mail küldés indul:", to);
    const mailOptions = {
      from: `"Kleopátra Szalon" <${user}>`,
      to,
      subject: "Belépési kód – Kleopátra Szalon",
      text: `Az Ön belépési kódja: ${code}`,
    };
    await transporter.sendMail(mailOptions);
    console.log(`📧 Kód elküldve: ${to}`);
  } catch (err) {
    console.error("❌ E-mail küldés hiba:", err);
    throw err;
  }
}
