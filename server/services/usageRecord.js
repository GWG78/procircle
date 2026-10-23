// server/services/usageRecord.js
//
// Reports ProCircle commission to Shopify App Pricing using
// Shopify's App Events API.
//
// The Shopify App Pricing usage meter handle is:
// procircle-commish
//
// Error classification (see billingErrors.js):
// - Token acquisition failure, or 401/403 on the event submission itself,
//   is treated as SYSTEMIC — it means our own credentials/connectivity
//   are broken, not that this particular order is unbillable.
// - Network errors, 429, and 5xx are RETRYABLE.
// - Other 4xx are PERMANENT (per-record).
//
// Verified against the dev store (2026-10-20): resubmitting an already-
// recorded idempotency_key returns HTTP 202 { success: true }, i.e. a
// normal 2xx — not a conflict error. So `response.ok` already covers
// both "newly accepted" and "already recorded" identically; no special
// duplicate-key handling is needed.

import {
  SystemicBillingError,
  RetryableBillingError,
  PermanentBillingError,
} from "./billingErrors.js";

const APP_EVENTS_TOKEN_URL =
  "https://api.shopify.com/auth/access_token";

const APP_EVENTS_URL =
  "https://api.shopify.com/app/2026-10/events";

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

  let response;
  try {
    response = await fetch(APP_EVENTS_TOKEN_URL, {
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
  } catch (err) {
    throw new SystemicBillingError(
      `Shopify App Events token request failed (network error): ${err.message}`,
      { cause: err }
    );
  }

  const data = await response.json().catch(() => null);

  if (!response.ok || !data?.access_token) {
    throw new SystemicBillingError(
      `Shopify App Events authentication failed: ${response.status} ${JSON.stringify(data)}`
    );
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
 *
 * Returns the parsed Shopify response body on success (including an
 * idempotent "already recorded" resubmission, which Shopify reports as
 * a normal 2xx). Throws SystemicBillingError / RetryableBillingError /
 * PermanentBillingError on failure — callers must catch and handle
 * each class, not swallow them.
 */
export async function postUsageRecord(
  shopId,
  amount,
  orderId
) {
  if (!shopId) {
    throw new PermanentBillingError(
      `Cannot report commission for order ${orderId}: missing Shopify shop ID`,
      { immediate: true }
    );
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new PermanentBillingError(
      `Cannot report commission for order ${orderId}: invalid amount`,
      { immediate: true }
    );
  }

  const accessToken = await getAppEventsAccessToken();

  const idempotencyKey = `procircle-commish-${orderId}`;

  let response;
  try {
    response = await fetch(APP_EVENTS_URL, {
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
  } catch (err) {
    throw new RetryableBillingError(
      `Shopify App Event request failed for order ${orderId} (network error): ${err.message}`,
      { cause: err }
    );
  }

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const message = `Shopify App Event failed for order ${orderId}: ${response.status} ${JSON.stringify(data)}`;

    if (response.status === 401 || response.status === 403) {
      throw new SystemicBillingError(message);
    }

    if (response.status === 429 || response.status >= 500) {
      throw new RetryableBillingError(message, { status: response.status });
    }

    throw new PermanentBillingError(message, { status: response.status });
  }

  console.log(
    `✅ ProCircle commission event accepted for order ${orderId}: ${amount.toFixed(2)} (HTTP ${response.status})`
  );

  return data;
}
