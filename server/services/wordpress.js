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

export { createWpUser, getWpPasswordResetLink };
