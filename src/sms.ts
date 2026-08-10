import axios from "axios";

export type OutgoingSms = {
  to: string;
  text: string;
};

export async function sendSms(message: OutgoingSms) {
  const url = String(process.env.SMS_GATEWAY_URL || "").trim();
  const token = String(process.env.SMS_GATEWAY_TOKEN || "").trim();
  const sender = String(process.env.SMS_SENDER || "Kleopatra").trim();
  const disabled = process.env.DISABLE_SMS === "1";

  if (disabled) {
    console.warn("[SMS] DISABLE_SMS=1 – SMS küldés kihagyva.");
    return { sent: false, logged: true };
  }
  if (!url) throw new Error("SMS_GATEWAY_URL nincs konfigurálva.");
  if (!message.to || !message.text) throw new Error("Az SMS címzettje és szövege kötelező.");

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response: any = await axios.post(
    url,
    { to: message.to, text: message.text, sender },
    { headers, timeout: 15_000 }
  );

  return {
    sent: true,
    logged: false,
    provider_id: response.data?.id || response.data?.message_id || response.data?.messageId || null,
  };
}

export default sendSms;
