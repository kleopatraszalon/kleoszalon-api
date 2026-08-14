export const socialConfig = {
  metaGraphVersion: String(process.env.META_GRAPH_VERSION || "v25.0").trim(),
  publicApiUrl: String(process.env.PUBLIC_API_URL || "https://kleoszalon-api-1.onrender.com").replace(/\/$/, ""),
  publicSiteUrl: String(process.env.PUBLIC_SITE_URL || "https://weblap-o3g6.onrender.com").replace(/\/$/, ""),
  publicRecruitmentUrl: String(process.env.PUBLIC_RECRUITMENT_URL || "https://weblap-o3g6.onrender.com/karrier").trim(),
  facebook: {
    pageId: String(process.env.META_PAGE_ID || "").trim(),
    accessToken: String(process.env.META_PAGE_ACCESS_TOKEN || "").trim(),
  },
  instagram: {
    userId: String(process.env.META_IG_USER_ID || "").trim(),
    accessToken: String(process.env.META_IG_ACCESS_TOKEN || process.env.META_PAGE_ACCESS_TOKEN || "").trim(),
  },
  tiktok: {
    accessToken: String(process.env.TIKTOK_ACCESS_TOKEN || "").trim(),
    openId: String(process.env.TIKTOK_OPEN_ID || "").trim(),
  },
};

export function publicSocialAccountStatus() {
  return {
    meta_graph_version: socialConfig.metaGraphVersion,
    media_public_base: `${socialConfig.publicApiUrl}/uploads/social`,
    accounts: {
      facebook: {
        configured: Boolean(socialConfig.facebook.pageId && socialConfig.facebook.accessToken),
        account_id: socialConfig.facebook.pageId || null,
        required_env: ["META_PAGE_ID", "META_PAGE_ACCESS_TOKEN"],
      },
      instagram: {
        configured: Boolean(socialConfig.instagram.userId && socialConfig.instagram.accessToken),
        account_id: socialConfig.instagram.userId || null,
        required_env: ["META_IG_USER_ID", "META_IG_ACCESS_TOKEN vagy META_PAGE_ACCESS_TOKEN"],
      },
      tiktok: {
        configured: Boolean(socialConfig.tiktok.accessToken),
        account_id: socialConfig.tiktok.openId || null,
        required_env: ["TIKTOK_ACCESS_TOKEN"],
        audit_note: "Nyilvános Direct Post használathoz TikTok app-audit és video.publish jogosultság szükséges.",
      },
    },
  };
}
