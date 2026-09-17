import prisma from "../prismaClient.js";

const TOKEN_ENDPOINT = (shopDomain) =>
  `https://${shopDomain}/admin/oauth/access_token`;

function expiryFromSeconds(seconds) {
  if (!seconds) return null;

  return new Date(Date.now() + Number(seconds) * 1000);
}

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