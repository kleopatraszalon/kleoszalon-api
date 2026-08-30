type ViberSendInput = {
  receiver: string;
  text: string;
  senderName?: string;
  senderAvatar?: string;
};

type ViberSendResult = {
  ok: boolean;
  provider: "viber";
  status: number | null;
  status_message: string;
  message_token?: number | string;
};

export function virMessagingProviderCapabilities() {
  return {
    email: Boolean(process.env.SMTP_HOST || process.env.RESEND_API_KEY),
    sms: Boolean(process.env.TWILIO_ACCOUNT_SID || process.env.SMS_PROVIDER_URL),
    whatsapp: Boolean(process.env.WHATSAPP_ACCESS_TOKEN),
    voice: Boolean(process.env.TWILIO_ACCOUNT_SID || process.env.VOICE_PROVIDER_URL),
    viber: Boolean(process.env.VIBER_BOT_TOKEN),
    messenger: Boolean(process.env.MESSENGER_PAGE_ACCESS_TOKEN && process.env.MESSENGER_PAGE_ID),
  };
}

export async function sendViberText(input: ViberSendInput): Promise<ViberSendResult> {
  const token = String(process.env.VIBER_BOT_TOKEN || "").trim();
  if (!token) {
    return { ok: false, provider: "viber", status: null, status_message: "viber_not_configured" };
  }

  const receiver = String(input.receiver || "").trim();
  const text = String(input.text || "").trim();
  if (!receiver || !text) {
    return { ok: false, provider: "viber", status: null, status_message: "viber_receiver_and_text_required" };
  }

  const senderName = String(input.senderName || process.env.VIBER_SENDER_NAME || "Kleopátra").trim().slice(0, 28) || "Kleopátra";
  const avatar = String(input.senderAvatar || process.env.VIBER_SENDER_AVATAR_URL || "").trim();
  const sender: Record<string, string> = { name: senderName };
  if (/^https:\/\//i.test(avatar)) sender.avatar = avatar;

  const response = await fetch("https://chatapi.viber.com/pa/send_message", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Viber-Auth-Token": token,
    },
    body: JSON.stringify({ receiver, min_api_version: 7, sender, type: "text", text }),
  });

  let payload: any = {};
  try { payload = await response.json(); } catch { payload = {}; }
  const providerStatus = Number(payload?.status);
  const ok = response.ok && providerStatus === 0;
  return {
    ok,
    provider: "viber",
    status: Number.isFinite(providerStatus) ? providerStatus : response.status,
    status_message: String(payload?.status_message || (ok ? "ok" : `http_${response.status}`)),
    message_token: payload?.message_token,
  };
}
