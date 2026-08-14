import type { SocialCampaignRecord, SocialPlatform, SocialPublishResult } from "./types";
import { publishFacebook, publishInstagram, verifyFacebookAccount, verifyInstagramAccount } from "./metaPublisher";
import { fetchTikTokPublishStatus, publishTikTok, verifyTikTokAccount } from "./tiktokPublisher";

export async function publishSocialPlatform(platform: SocialPlatform, campaign: SocialCampaignRecord, payload: any): Promise<SocialPublishResult> {
  if (platform === "facebook") return publishFacebook(campaign, payload);
  if (platform === "instagram") return publishInstagram(campaign, payload);
  return publishTikTok(campaign, payload);
}

export async function verifySocialAccounts() {
  const [facebook, instagram, tiktok] = await Promise.all([
    verifyFacebookAccount(),
    verifyInstagramAccount(),
    verifyTikTokAccount(),
  ]);
  return { facebook, instagram, tiktok };
}

export { fetchTikTokPublishStatus };
