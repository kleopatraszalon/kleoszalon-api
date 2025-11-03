import nodemailer from "nodemailer";
import dotenv from "dotenv";

dotenv.config();

async function sendLoginCodeEmail(toEmail: string, code: string) {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_PASS,
    },
  });

  const info = await transporter.sendMail({
    from: `"Kleoszalon" <${process.env.GMAIL_USER}>`,
    to: toEmail,
    subject: "Kleoszalon belépési kód",
    text: `Az Ön belépési kódja: ${code}\nA kód ${
      process.env.CODE_EXPIRES_MIN || 5
    } percig érvényes.`,
  });

  console.log("2FA e-mail elküldve:", info.messageId);
}

export default sendLoginCodeEmail;
