export const SOCIAL_PLATFORMS = ["facebook", "instagram", "tiktok"] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

export type SocialPublishResult = {
  status: "published" | "submitted";
  external_id?: string | null;
  external_container_id?: string | null;
  external_url?: string | null;
  response?: unknown;
};

export type SocialCampaignRecord = {
  id: string;
  source_type: string;
  source_id?: string | null;
  name: string;
  headline: string;
  description?: string | null;
  image_url?: string | null;
  video_url?: string | null;
  link_url?: string | null;
};
