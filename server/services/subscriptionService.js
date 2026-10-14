// server/services/subscriptionService.js
//
// Shopify-managed pricing: the merchant picks a plan on Shopify's own
// pricing page, and Shopify creates the AppSubscription itself — ProCircle
// never calls appSubscriptionCreate for that plan, so Shop.billingSubscriptionId
// is never populated for it (that column is now unused dead data — see
// webhooks/appUninstalled.mjs). This checks currentAppInstallation directly
// instead. Used by the GET /api/settings redirect gate (web/src/App.jsx)
// and re-checked independently in routes/campaigns.mjs before a campaign
// can go active.

import { shopify } from "../shopify.js";

// Also fetches app { handle } — used by getPlanSelectionUrl below to build
// the merchant's pricing-page URL from the live app registration rather
// than the SHOPIFY_APP_HANDLE env var.
const ACTIVE_SUBSCRIPTIONS_QUERY = `
  query ProCircleCurrentSubscriptions {
    currentAppInstallation {
      app {
        handle
      }
      activeSubscriptions {
        id
        name
        status
        lineItems {
          id
        }
      }
    }
  }
`;

/**
 * The server sometimes still runs under the old Custom app credentials
 * (client_id 207654bcf160a85ef5abf6fa59f8f832, handle procircle-forward —
 * see server/shopify.app.toml), which cannot use Shopify billing at all, so
 * activeSubscriptions is always empty there. BILLING_REQUIRED=false skips
 * the gate entirely for that deployment.
 */
function billingRequired() {
  return process.env.BILLING_REQUIRED !== "false";
}

/**
 * @param {{ shopDomain: string, accessToken?: string|null }} shop
 * @returns {Promise<boolean>}
 */
export async function hasActivePlan(shop) {
  if (!billingRequired()) {
    return true;
  }

  if (!shop?.accessToken) {
    return false;
  }

  try {
    const client = new shopify.clients.Graphql({
      session: { shop: shop.shopDomain, accessToken: shop.accessToken },
    });

    const response = await client.request(ACTIVE_SUBSCRIPTIONS_QUERY);
    const activeSubscriptions =
      response.data?.currentAppInstallation?.activeSubscriptions || [];

    return activeSubscriptions.some((sub) => sub.status === "ACTIVE");
  } catch (err) {
    // Fail closed — this is the billing gate reviewers check for, so a
    // transient Admin API error should not be treated as "has a plan".
    console.error(`❌ Failed to check active subscriptions for ${shop.shopDomain}:`, err?.message || err);
    return false;
  }
}

/**
 * @param {{ shopDomain: string, accessToken?: string|null }} shop
 * @returns {Promise<string|null>}
 */
async function resolveAppHandle(shop) {
  if (shop?.accessToken) {
    try {
      const client = new shopify.clients.Graphql({
        session: { shop: shop.shopDomain, accessToken: shop.accessToken },
      });

      const response = await client.request(ACTIVE_SUBSCRIPTIONS_QUERY);
      const handle = response.data?.currentAppInstallation?.app?.handle;

      if (handle) return handle;
    } catch (err) {
      // Fall back to the env var below.
      console.error(`❌ Failed to fetch app handle for ${shop.shopDomain}:`, err?.message || err);
    }
  }

  return process.env.SHOPIFY_APP_HANDLE || null;
}

/**
 * @param {{ shopDomain: string, accessToken?: string|null }} shop
 * @returns {Promise<string|null>} null if no handle is available, from the
 *   query or SHOPIFY_APP_HANDLE
 */
export async function getPlanSelectionUrl(shop) {
  const shopDomain = shop?.shopDomain;
  if (!shopDomain) return null;

  const appHandle = await resolveAppHandle(shop);
  if (!appHandle) return null;

  const storeHandle = shopDomain.replace(/\.myshopify\.com$/, "");
  return `https://admin.shopify.com/store/${storeHandle}/charges/${appHandle}/pricing_plans`;
}
