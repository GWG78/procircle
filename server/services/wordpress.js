// services/wordpress.js
//
// WordPress REST API helpers for the post-verification handoff: creates a
// WP user for a newly-verified member and fetches a password-reset link so
// they can log in immediately, rather than landing on a generic success
// page with no way to actually access the site yet. Authenticated via a WP
// Application Password (Basic Auth) — same credential set already used on
// the Apps Script side (createWordPressOrg_ in Config.js) for Organisation
// CPT creation.
import crypto from "node:crypto";

const WP_BASE_URL = process.env.WP_BASE_URL;
const WP_USERNAME = process.env.WP_USERNAME;
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD;

function wpAuthHeader() {
  return "Basic " + Buffer.from(`${WP_USERNAME}:${WP_APP_PASSWORD}`).toString("base64");
}

/**
 * Creates a WordPress user for a newly-verified member. Never throws —
 * the caller (GET /api/members/verify) falls back to the generic success
 * page on any failure, since email verification itself is already
 * complete by the time this runs and shouldn't be blocked by it.
 */
async function createWpUser(email, firstName, lastName) {
  try {
    const response = await fetch(`${WP_BASE_URL}/wp-json/wp/v2/users`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: wpAuthHeader(),
      },
      body: JSON.stringify({
        username: email,
        email,
        first_name: firstName,
        last_name: lastName,
        password: crypto.randomBytes(16).toString("hex"),
        roles: ["subscriber"],
      }),
    });

    if (response.status === 409) {
      return { success: true, existing: true };
    }

    if (response.status === 400) {
      const errorBody = await response.json();
      if (["existing_user_email", "existing_user_login"].includes(errorBody.code)) {
        return { success: true, existing: true };
      }
      return { success: false, error: `HTTP 400 — ${JSON.stringify(errorBody)}` };
    }

    if (!response.ok) {
      const errorBody = await response.text();
      return { success: false, error: `HTTP ${response.status} — ${errorBody}` };
    }

    const json = await response.json();
    return { success: true, wpUserId: json.id };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Fetches a WordPress password-reset link for an already-created user, via
 * a custom REST route this codebase doesn't own or control
 * (wp-json/procircle/v1/reset-link) — assumed to already exist on the
 * WordPress side. Never throws, same fallback reasoning as createWpUser.
 */
async function getWpPasswordResetLink(email) {
  try {
    const response = await fetch(
      `${WP_BASE_URL}/wp-json/procircle/v1/reset-link?email=${encodeURIComponent(email)}`,
      {
        method: "GET",
        headers: { Authorization: wpAuthHeader() },
      }
    );

    if (!response.ok) {
      const errorBody = await response.text();
      return { success: false, error: `HTTP ${response.status} — ${errorBody}` };
    }

    const json = await response.json();
    if (!json.resetLink) {
      return { success: false, error: "Response missing resetLink" };
    }

    return { success: true, resetLink: json.resetLink };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Formats a JS Date into ACF's fixed internal storage format for a Date
 * Time Picker field ("Y-m-d H:i:s") — this is NOT configurable via ACF's
 * Display/Return Format settings, which only affect how the value is shown
 * when read back, not what the REST API expects on write. Sending a raw
 * ISO string (e.g. "2026-08-15T00:00:00.000Z") here would not be accepted
 * the way ACF's own admin UI writes it.
 */
function toAcfDateTime(date) {
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

/**
 * Looks up a WordPress "brand" CPT post by slug (brandId.toLowerCase(),
 * matching the slug createWordPressBrand_ in Config.js sets at brand
 * signup). Returns the numeric post ID, or null if not found or on any
 * error — never throws, so a lookup failure just means the campaign post
 * below gets created without a brand relationship set, rather than
 * blocking campaign creation entirely.
 */
async function getWpBrandPostIdBySlug(slug) {
  try {
    const response = await fetch(
      `${WP_BASE_URL}/wp-json/wp/v2/brand?slug=${encodeURIComponent(slug)}`,
      { headers: { Authorization: wpAuthHeader() } }
    );

    if (!response.ok) return null;

    const posts = await response.json();
    return Array.isArray(posts) && posts.length ? posts[0].id : null;
  } catch (err) {
    console.error(`❌ getWpBrandPostIdBySlug error for slug "${slug}":`, err.message);
    return null;
  }
}

/**
 * Creates a WordPress "campaign" CPT post for a newly-created Campaign,
 * linking it to its parent brand via the ACF Relationship field ("brand",
 * configured to return Post ID). Only sets the fields Node knows at
 * creation time — hero_image/description are left for manual entry later,
 * same enrich-later pattern as brand's logo/brand_summary/discount_rate.
 *
 * Returns the new WP post ID on success, or null on any failure — never
 * throws, so a WP-side outage doesn't roll back an already-created,
 * already-billable Shopify discount (see routes/campaigns.mjs).
 */
async function createWpCampaignPost({
  brandWpPostId,
  name,
  slug,
  discountType,
  discountValue,
  discountCode,
  discountLink,
  status,
  startsAt,
  validForDays,
  maxRedemptions,
  maxRedemptionsPerUser,
  sourceCampaignId,
}) {
  try {
    const acf = {
      name,
      discount_type: discountType,
      discount_value: discountValue,
      discount_code: discountCode || "",
      discount_link: discountLink || "",
      status,
      valid_for_days: validForDays,
      max_redemptions: maxRedemptions ?? "",
      max_redemptions_per_user: maxRedemptionsPerUser,
      source_campaign_id: sourceCampaignId,
    };

    if (brandWpPostId) acf.brand = brandWpPostId;
    if (startsAt) acf.starts_at = toAcfDateTime(startsAt);

    const response = await fetch(`${WP_BASE_URL}/wp-json/wp/v2/campaign`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: wpAuthHeader(),
      },
      body: JSON.stringify({ title: name, slug, status: "publish", acf }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`❌ createWpCampaignPost failed (HTTP ${response.status}): ${errorBody}`);
      return null;
    }

    const json = await response.json();
    return json.id;
  } catch (err) {
    console.error("❌ createWpCampaignPost error:", err.message);
    return null;
  }
}

/**
 * Updates an existing WordPress "campaign" post's status (and, for ended
 * campaigns, ended_at/ended_reason). Called from routes/campaigns.mjs's
 * pause/resume handlers and campaignLifecycleService.js's
 * endCampaignAndNotify — anywhere a Campaign's stored status changes after
 * creation. No-op if wpPostId is falsy (campaign was never successfully
 * synced to WP in the first place). Never throws — a WP outage here must
 * not roll back a DB status change that's already committed.
 */
async function updateWpCampaignStatus(wpPostId, { status, endedAt, endedReason } = {}) {
  if (!wpPostId) return false;

  try {
    const acf = {};
    if (status) acf.status = status;
    if (endedAt) acf.ended_at = toAcfDateTime(endedAt);
    if (endedReason) acf.ended_reason = endedReason;

    const response = await fetch(`${WP_BASE_URL}/wp-json/wp/v2/campaign/${wpPostId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: wpAuthHeader(),
      },
      body: JSON.stringify({ acf }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`❌ updateWpCampaignStatus failed for post ${wpPostId} (HTTP ${response.status}): ${errorBody}`);
      return false;
    }

    return true;
  } catch (err) {
    console.error(`❌ updateWpCampaignStatus error for post ${wpPostId}:`, err.message);
    return false;
  }
}

export {
  createWpUser,
  getWpPasswordResetLink,
  getWpBrandPostIdBySlug,
  createWpCampaignPost,
  updateWpCampaignStatus,
};
