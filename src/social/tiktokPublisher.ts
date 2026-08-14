import axios from "axios";
import { socialConfig } from "./config";
import { materializeSocialMedia, socialText } from "./media";
import type { SocialCampaignRecord, SocialPublishResult } from "./types";

const TIKTOK_BASE = "https://open.tiktokapis.com";

export async function queryTikTokCreator() {
  const token = socialConfig.tiktok.accessToken;
  if (!token) throw new Error("TikTok nincs konfigurálva: TIKTOK_ACCESS_TOKEN szükséges.");
  const result = await axios.post(`${TIKTOK_BASE}/v2/post/publish/creator_info/query/`, {}, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8" },
    timeout: 20000,
  });
  if (result.data?.error?.code && result.data.error.code !== "ok") {
    throw new Error(`TikTok: ${result.data.error.message || result.data.error.code}`);
  }
  return result.data?.data || {};
}

export async function verifyTikTokAccount() {
  if (!socialConfig.tiktok.accessToken) return { ok: false, error: "Nincs konfigurálva." };
  try {
    const creator = await queryTikTokCreator();
    return {
      ok: true,
      account: {
        creator_username: creator.creator_username,
        creator_nickname: creator.creator_nickname,
        privacy_level_options: creator.privacy_level_options,
        comment_disabled: creator.comment_disabled,
        duet_disabled: creator.duet_disabled,
        stitch_disabled: creator.stitch_disabled,
        max_video_post_duration_sec: creator.max_video_post_duration_sec,
      },
    };
  } catch (error: any) {
    return { ok: false, error: socialText(error?.response?.data?.error?.message || error?.message, 500) };
  }
}

export async function publishTikTok(campaign: SocialCampaignRecord, payload: any): Promise<SocialPublishResult> {
  const token = socialConfig.tiktok.accessToken;
  if (!token) throw new Error("TikTok nincs konfigurálva: TIKTOK_ACCESS_TOKEN szükséges.");
  if (payload?.consent_confirmed !== true) {
    throw new Error("TikTok publikálás előtt jóvá kell hagyni a célfiókot és a közzétételt.");
  }

  const creator = await queryTikTokCreator();
  const requestedPrivacy = socialText(payload?.privacy_level, 80) || "SELF_ONLY";
  const available = Array.isArray(creator.privacy_level_options) ? creator.privacy_level_options.map(String) : [];
  if (!available.includes(requestedPrivacy)) {
    throw new Error(`A kiválasztott TikTok láthatóság nem engedélyezett. Választható: ${available.join(", ") || "nincs"}.`);
  }

  const imageUrl = await materializeSocialMedia(campaign.image_url, campaign.id, "image");
  const videoUrl = await materializeSocialMedia(campaign.video_url, campaign.id, "video");
  if (!imageUrl && !videoUrl) throw new Error("TikTok publikáláshoz kép vagy videó szükséges.");

  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8" };
  let result;
  if (videoUrl) {
    result = await axios.post(`${TIKTOK_BASE}/v2/post/publish/video/init/`, {
      post_info: {
        title: socialText(payload?.caption || payload?.title, 2200),
        privacy_level: requestedPrivacy,
        disable_comment: Boolean(payload?.disable_comment || creator.comment_disabled),
        disable_duet: Boolean(payload?.disable_duet || creator.duet_disabled),
        disable_stitch: Boolean(payload?.disable_stitch || creator.stitch_disabled),
        brand_organic_toggle: payload?.brand_organic_toggle !== false,
      },
      source_info: { source: "PULL_FROM_URL", video_url: videoUrl },
    }, { headers, timeout: 25000 });
  } else {
    result = await axios.post(`${TIKTOK_BASE}/v2/post/publish/content/init/`, {
      media_type: "PHOTO",
      post_mode: "DIRECT_POST",
      post_info: {
        title: socialText(payload?.title || campaign.headline, 90),
        description: socialText(payload?.caption, 4000),
        privacy_level: requestedPrivacy,
        disable_comment: Boolean(payload?.disable_comment || creator.comment_disabled),
        auto_add_music: false,
      },
      source_info: { source: "PULL_FROM_URL", photo_cover_index: 0, photo_images: [imageUrl] },
    }, { headers, timeout: 25000 });
  }

  if (result.data?.error?.code && result.data.error.code !== "ok") {
    throw new Error(`TikTok: ${result.data.error.message || result.data.error.code}`);
  }
  const publishId = String(result.data?.data?.publish_id || "");
  if (!publishId) throw new Error("TikTok nem adott vissza publish_id azonosítót.");
  return { status: "submitted", external_id: publishId, response: result.data };
}

export async function fetchTikTokPublishStatus(publishId: string) {
  const token = socialConfig.tiktok.accessToken;
  if (!token) throw new Error("TikTok token nincs konfigurálva.");
  const result = await axios.post(`${TIKTOK_BASE}/v2/post/publish/status/fetch/`, { publish_id: publishId }, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8" },
    timeout: 20000,
  });
  if (result.data?.error?.code && result.data.error.code !== "ok") {
    throw new Error(`TikTok státusz: ${result.data.error.message || result.data.error.code}`);
  }
  return result.data;
}
