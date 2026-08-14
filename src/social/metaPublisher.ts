import axios from "axios";
import { socialConfig } from "./config";
import { addSocialTracking, materializeSocialMedia, socialText } from "./media";
import type { SocialCampaignRecord, SocialPublishResult } from "./types";

async function metaForm(endpoint: string, data: Record<string, string>) {
  const body = new URLSearchParams(data);
  return axios.post<any>(`https://graph.facebook.com/${socialConfig.metaGraphVersion}/${endpoint}`, body, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 25000,
  });
}

export async function verifyFacebookAccount() {
  if (!socialConfig.facebook.pageId || !socialConfig.facebook.accessToken) return { ok: false, error: "Nincs konfigurálva." };
  try {
    const result = await axios.get<any>(`https://graph.facebook.com/${socialConfig.metaGraphVersion}/${socialConfig.facebook.pageId}`, {
      params: { fields: "id,name", access_token: socialConfig.facebook.accessToken },
      timeout: 15000,
    });
    return { ok: true, account: result.data };
  } catch (error: any) {
    return { ok: false, error: socialText(error?.response?.data?.error?.message || error?.message, 500) };
  }
}

export async function verifyInstagramAccount() {
  if (!socialConfig.instagram.userId || !socialConfig.instagram.accessToken) return { ok: false, error: "Nincs konfigurálva." };
  try {
    const result = await axios.get<any>(`https://graph.facebook.com/${socialConfig.metaGraphVersion}/${socialConfig.instagram.userId}`, {
      params: { fields: "id,username,name", access_token: socialConfig.instagram.accessToken },
      timeout: 15000,
    });
    return { ok: true, account: result.data };
  } catch (error: any) {
    return { ok: false, error: socialText(error?.response?.data?.error?.message || error?.message, 500) };
  }
}

export async function publishFacebook(campaign: SocialCampaignRecord, payload: any): Promise<SocialPublishResult> {
  const { pageId, accessToken } = socialConfig.facebook;
  if (!pageId || !accessToken) throw new Error("Facebook nincs konfigurálva: META_PAGE_ID és META_PAGE_ACCESS_TOKEN szükséges.");

  const trackedUrl = addSocialTracking(campaign.link_url, "facebook", campaign.id, campaign.source_type);
  const caption = `${socialText(payload?.caption, 5000)}${trackedUrl ? `\n\n${trackedUrl}` : ""}`.trim();
  const imageUrl = await materializeSocialMedia(campaign.image_url, campaign.id, "image");
  const videoUrl = await materializeSocialMedia(campaign.video_url, campaign.id, "video");

  let result;
  if (videoUrl) {
    result = await metaForm(`${pageId}/videos`, { file_url: videoUrl, description: caption, access_token: accessToken });
  } else if (imageUrl) {
    result = await metaForm(`${pageId}/photos`, { url: imageUrl, caption, access_token: accessToken });
  } else {
    result = await metaForm(`${pageId}/feed`, { message: socialText(payload?.caption, 5000), link: trackedUrl, access_token: accessToken });
  }

  return {
    status: "published",
    external_id: String(result.data?.post_id || result.data?.id || ""),
    external_url: trackedUrl,
    response: result.data,
  };
}

async function waitForInstagramContainer(containerId: string, accessToken: string) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const result = await axios.get<any>(`https://graph.facebook.com/${socialConfig.metaGraphVersion}/${containerId}`, {
      params: { fields: "status_code,status", access_token: accessToken },
      timeout: 15000,
    });
    const state = String(result.data?.status_code || "");
    if (state === "FINISHED") return;
    if (["ERROR", "EXPIRED"].includes(state)) throw new Error(`Instagram médiafeldolgozás sikertelen: ${socialText(result.data?.status, 500)}`);
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  throw new Error("Instagram média még feldolgozás alatt van; próbálja újra rövidesen.");
}

export async function publishInstagram(campaign: SocialCampaignRecord, payload: any): Promise<SocialPublishResult> {
  const { userId, accessToken } = socialConfig.instagram;
  if (!userId || !accessToken) throw new Error("Instagram nincs konfigurálva: META_IG_USER_ID és hozzáférési token szükséges.");

  const trackedUrl = addSocialTracking(campaign.link_url, "instagram", campaign.id, campaign.source_type);
  const caption = `${socialText(payload?.caption, 2100)}${trackedUrl ? `\n\n${trackedUrl}` : ""}`.slice(0, 2200);
  const imageUrl = await materializeSocialMedia(campaign.image_url, campaign.id, "image");
  const videoUrl = await materializeSocialMedia(campaign.video_url, campaign.id, "video");
  if (!imageUrl && !videoUrl) throw new Error("Instagram publikáláshoz kép vagy videó szükséges.");

  const createData: Record<string, string> = { caption, access_token: accessToken };
  if (videoUrl) {
    createData.media_type = "REELS";
    createData.video_url = videoUrl;
  } else {
    createData.image_url = imageUrl;
  }

  const created = await metaForm(`${userId}/media`, createData);
  const containerId = String(created.data?.id || "");
  if (!containerId) throw new Error("Instagram nem adott vissza média-konténer azonosítót.");
  await waitForInstagramContainer(containerId, accessToken);
  const published = await metaForm(`${userId}/media_publish`, { creation_id: containerId, access_token: accessToken });

  return {
    status: "published",
    external_id: String(published.data?.id || ""),
    external_container_id: containerId,
    external_url: trackedUrl,
    response: published.data,
  };
}
