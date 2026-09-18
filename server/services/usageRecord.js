// server/services/usageRecord.js
//
// Reports ProCircle commission to Shopify App Pricing using
// Shopify's App Events API.
//
// The Shopify App Pricing usage meter handle is:
// procircle-commish

const APP_EVENTS_TOKEN_URL =
  "https://api.shopify.com/auth/access_token";

const APP_EVENTS_URL =
  "https://api.shopify.com/app/unstable/events";

const EVENT_HANDLE = "procircle-commish";

// Cache the App Events bearer token in memory so we don't request
// a new one for every commission event.
let cachedToken = null;
let cachedTokenExpiresAt = 0;

async function getAppEventsAccessToken() {
  // Give ourselves a 60-second safety margin.
  if (
    cachedToken &&
    Date.now() < cachedTokenExpiresAt - 60_000
  ) {
    return cachedToken;
  }

  const response = await fetch(APP_EVENTS_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: process.env.SHOPIFY_API_KEY,
      client_secret: process.env.SHOPIFY_API_SECRET,
      grant_type: "client_credentials",
    }),
  });

  const data = await response.json();

  if (!response.ok || !data.access_token) {
    const error = new Error(
      `Shopify App Events authentication failed: ${response.status}`
    );

    error.status = response.status;
    error.shopifyResponse = data;

    throw error;
  }

  cachedToken = data.access_token;

  // Shopify normally supplies expires_in. If it isn't present,
  // don't retain the token beyond this request.
  cachedTokenExpiresAt = data.expires_in
    ? Date.now() + Number(data.expires_in) * 1000
    : 0;

  return cachedToken;
}

/**
 * Report a ProCircle commission to Shopify App Pricing.
 *
 * shopId:
 *   Shopify numeric shop ID or gid://shopify/Shop/... ID.
 *
 * amount:
 *   Commission amount. Because commissions can contain decimals,
 *   Shopify requires fractional values to be sent as strings.
 *
 * orderId:
 *   Used to construct a permanent idempotency key so the same
 *   Shopify order cannot accidentally be billed twice.
 */
export async function postUsageRecord(
  shopId,
  amount,
  orderId
) {
  try {
    if (!shopId) {
      throw new Error(
        `Cannot report commission for order ${orderId}: missing Shopify shop ID`
      );
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error(
        `Cannot report commission for order ${orderId}: invalid amount`
      );
    }

    const accessToken =
      await getAppEventsAccessToken();

    const idempotencyKey =
      `procircle-commish-${orderId}`;

    const response = await fetch(APP_EVENTS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        shop_id: String(shopId),
        event_handle: EVENT_HANDLE,
        timestamp: new Date().toISOString(),
        idempotency_key: idempotencyKey,
        attributes: {
          value: amount.toFixed(2),
        },
      }),
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      const error = new Error(
        `Shopify App Event failed: ${response.status}`
      );

      error.status = response.status;
      error.shopifyResponse = data;

      throw error;
    }

    console.log(
      `✅ ProCircle commission event accepted for order ${orderId}: ${amount.toFixed(2)}`
    );

    return data;
  } catch (err) {
    console.error(
      `❌ postUsageRecord failed for order ${orderId}:`,
      err?.message || err
    );

    if (err?.shopifyResponse) {
      console.error(
        "❌ Shopify App Events response:",
        err.shopifyResponse
      );
    }

    return null;
  }
}