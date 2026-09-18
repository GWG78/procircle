import prisma from "../prismaClient.js";

const TOKEN_ENDPOINT = (shopDomain) =>
  `https://${shopDomain}/admin/oauth/access_token`;

// Refresh before the access token actually expires.
// This gives API requests a five-minute safety margin.
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

function expiryFromSeconds(seconds) {
  if (!seconds) return null;

  return new Date(Date.now() + Number(seconds) * 1000);
}

/**
 * Exchange an App Bridge ID token for an expiring offline
 * Shopify Admin API access token.
 *
 * Used on first authenticated load after Shopify-managed installation.
 */
export async function exchangeIdTokenForOfflineToken(
  shopDomain,
  idToken
) {
  const body = new URLSearchParams({
    grant_type:
      "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: idToken,
    subject_token_type:
      "urn:ietf:params:oauth:token-type:id_token",
    requested_token_type:
      "urn:shopify:params:oauth:token-type:offline-access-token",
    client_id: process.env.SHOPIFY_API_KEY,
    client_secret: process.env.SHOPIFY_API_SECRET,
    expiring: "1",
  });

  const response = await fetch(TOKEN_ENDPOINT(shopDomain), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });

  const data = await response.json();

  if (!response.ok) {
    const error = new Error(
      `Shopify token exchange failed: ${response.status}`
    );

    error.status = response.status;
    error.shopifyResponse = data;

    throw error;
  }

  const shop = await prisma.shop.upsert({
    where: { shopDomain },

    update: {
      accessToken: data.access_token,
      accessTokenExpiresAt: expiryFromSeconds(data.expires_in),
      refreshToken: data.refresh_token,
      refreshTokenExpiresAt:
        expiryFromSeconds(data.refresh_token_expires_in),
      scope: data.scope || "",
      installed: true,
      uninstalledAt: null,
    },

    create: {
      shopDomain,
      accessToken: data.access_token,
      accessTokenExpiresAt: expiryFromSeconds(data.expires_in),
      refreshToken: data.refresh_token,
      refreshTokenExpiresAt:
        expiryFromSeconds(data.refresh_token_expires_in),
      scope: data.scope || "",
      installed: true,
    },
  });

  return shop;
}

/**
 * Refresh an expiring Shopify offline access token.
 *
 * Shopify rotates the refresh token during this request, so the
 * new access token and new refresh token are written to the Shop
 * record together in one Prisma update.
 */
export async function refreshOfflineAccessToken(shop) {
  if (!shop?.shopDomain) {
    throw new Error("Cannot refresh Shopify token: missing shop domain");
  }

  if (!shop.refreshToken) {
    throw new Error(
      `Cannot refresh Shopify token for ${shop.shopDomain}: missing refresh token`
    );
  }

  if (
    shop.refreshTokenExpiresAt &&
    shop.refreshTokenExpiresAt.getTime() <= Date.now()
  ) {
    throw new Error(
      `Cannot refresh Shopify token for ${shop.shopDomain}: refresh token expired`
    );
  }

  console.log(
    `🔄 Refreshing Shopify offline access token for ${shop.shopDomain}`
  );

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: shop.refreshToken,
    client_id: process.env.SHOPIFY_API_KEY,
    client_secret: process.env.SHOPIFY_API_SECRET,
  });

  const response = await fetch(TOKEN_ENDPOINT(shop.shopDomain), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });

  const data = await response.json();

  if (!response.ok) {
    const error = new Error(
      `Shopify token refresh failed: ${response.status}`
    );

    error.status = response.status;
    error.shopifyResponse = data;

    throw error;
  }

  if (!data.access_token || !data.refresh_token) {
    const error = new Error(
      `Shopify token refresh returned incomplete token data for ${shop.shopDomain}`
    );

    error.shopifyResponse = data;

    throw error;
  }

  const updatedShop = await prisma.shop.update({
    where: { id: shop.id },

    data: {
      accessToken: data.access_token,
      accessTokenExpiresAt: expiryFromSeconds(data.expires_in),
      refreshToken: data.refresh_token,
      refreshTokenExpiresAt:
        expiryFromSeconds(data.refresh_token_expires_in),
      scope: data.scope || shop.scope || "",
    },
  });

  console.log(
    `✅ Shopify offline access token refreshed for ${shop.shopDomain}`
  );

  return updatedShop;
}

/**
 * Return a Shop with a usable Admin API access token.
 *
 * If the current access token expires within five minutes,
 * refresh it first.
 */
export async function ensureFreshOfflineAccessToken(shop) {
  if (!shop?.accessToken) {
    throw new Error(
      `Cannot ensure Shopify token: no access token for ${shop?.shopDomain || "unknown shop"}`
    );
  }

  // A token without an expiry date is treated as a legacy/non-expiring
  // token. Leave it alone rather than refreshing unnecessarily.
  if (!shop.accessTokenExpiresAt) {
    return shop;
  }

  const refreshAt =
    shop.accessTokenExpiresAt.getTime() - REFRESH_BUFFER_MS;

  if (Date.now() < refreshAt) {
    return shop;
  }

  return refreshOfflineAccessToken(shop);
}