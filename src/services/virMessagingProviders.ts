type ViberSendInput = {
  receiver: string;
  text: string;
  senderName?: string;
  senderAvatar?: string;
  trackingData?: string;
};

type ViberSendResult = {
  ok: boolean;
  provider: "viber";
  status: number | null;
  status_message: string;
  message_token?: number | string;
};

type MessengerSendInput = {
  receiver: string;
  text: string;
  touchId?: string;
  ctaLabel?: string;
  messagingType?: "RESPONSE" | "UPDATE" | "MESSAGE_TAG";
  tag?: string;
};

type MessengerSendResult = {
  ok: boolean;
  provider: "messenger";
  status: number;
  status_message: string;
  message_id?: string;
  recipient_id?: string;
};

export function virMessagingProviderCapabilities() {
  return {
    email: Boolean(process.env.SMTP_HOST || process.env.RESEND_API_KEY),
    sms: Boolean(process.env.TWILIO_ACCOUNT_SID || process.env.SMS_PROVIDER_URL),
    whatsapp: Boolean(process.env.WHATSAPP_ACCESS_TOKEN),
    voice: Boolean(process.env.TWILIO_ACCOUNT_SID || process.env.VOICE_PROVIDER_URL),
    viber: Boolean(process.env.VIBER_BOT_TOKEN),
    viber_webhook: Boolean(process.env.VIBER_BOT_TOKEN && (process.env.VIBER_TENANT_ID || process.env.COMMUNICATION_DEFAULT_TENANT_ID)),
    messenger: Boolean(process.env.MESSENGER_PAGE_ACCESS_TOKEN && process.env.MESSENGER_PAGE_ID),
    messenger_webhook: Boolean(process.env.MESSENGER_APP_SECRET && process.env.MESSENGER_VERIFY_TOKEN && (process.env.MESSENGER_TENANT_ID || process.env.COMMUNICATION_DEFAULT_TENANT_ID)),
  };
}

export async function sendViberText(input: ViberSendInput): Promise<ViberSendResult> {
  const token = String(process.env.VIBER_BOT_TOKEN || "").trim();
  if (!token) return { ok: false, provider: "viber", status: null, status_message: "viber_not_configured" };

  const receiver = String(input.receiver || "").trim();
  const text = String(input.text || "").trim();
  if (!receiver || !text) return { ok: false, provider: "viber", status: null, status_message: "viber_receiver_and_text_required" };

  const senderName = String(input.senderName || process.env.VIBER_SENDER_NAME || "Kleopátra").trim().slice(0, 28) || "Kleopátra";
  const avatar = String(input.senderAvatar || process.env.VIBER_SENDER_AVATAR_URL || "").trim();
  const sender: Record<string, string> = { name: senderName };
  if (/^https:\/\//i.test(avatar)) sender.avatar = avatar;
  const trackingData=String(input.trackingData||"").slice(0,4096);
  const body:any={ receiver, min_api_version: 7, sender, type: "text", text };
  if(trackingData)body.tracking_data=trackingData;

  const response = await fetch("https://chatapi.viber.com/pa/send_message", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Viber-Auth-Token": token },
    body: JSON.stringify(body),
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

export async function sendMessengerText(input:MessengerSendInput):Promise<MessengerSendResult>{
  const token=String(process.env.MESSENGER_PAGE_ACCESS_TOKEN||"").trim();
  const pageId=String(process.env.MESSENGER_PAGE_ID||"").trim();
  if(!token||!pageId)return{ok:false,provider:"messenger",status:0,status_message:"messenger_not_configured"};
  const receiver=String(input.receiver||"").trim(),text=String(input.text||"").trim();
  if(!receiver||!text)return{ok:false,provider:"messenger",status:0,status_message:"messenger_receiver_and_text_required"};
  const version=String(process.env.META_GRAPH_VERSION||"v26.0").trim();
  const messagingType=input.messagingType||"RESPONSE";
  const message:any={text};
  if(input.ctaLabel&&input.touchId){
    message.attachment={type:"template",payload:{template_type:"button",text,buttons:[{type:"postback",title:String(input.ctaLabel).slice(0,20),payload:`KLEO_TOUCH:${input.touchId}`}]}};
    delete message.text;
  }
  const body:any={recipient:{id:receiver},messaging_type:messagingType,message};
  if(messagingType==="MESSAGE_TAG"&&input.tag)body.tag=String(input.tag);
  const response=await fetch(`https://graph.facebook.com/${encodeURIComponent(version)}/${encodeURIComponent(pageId)}/messages`,{
    method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`},body:JSON.stringify(body)
  });
  let payload:any={};try{payload=await response.json()}catch{payload={}}
  const ok=response.ok&&Boolean(payload?.message_id);
  return{ok,provider:"messenger",status:response.status,status_message:String(payload?.error?.message|| (ok?"ok":`http_${response.status}`)),message_id:payload?.message_id,recipient_id:payload?.recipient_id};
}
