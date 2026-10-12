// server/services/subscriptionService.js
//
// Shopify-managed pricing: the merchant picks a plan on Shopify's own
// pricing page, and Shopify creates the AppSubscription itself — ProCircle
// never calls appSubscriptionCreate for that plan, so Shop.billingSubscriptionId
// (set only by the legacy self-managed flow in auth.mjs/services/billing.js)
// is not a reliable signal here. This checks currentAppInstallation directly
// instead. Used by the GET /api/settings redirect gate (web/src/App.jsx)
// and re-checked independently in routes/campaigns.mjs before a campaign
// can go active.

import { shopify } from "../shopify.js";

const ACTIVE_SUBSCRIPTIONS_QUERY = `
  query ProCircleCurrentSubscriptions {
    currentAppInstallation {
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
 * @param {string} shopDomain e.g. "example.myshopify.com"
 * @returns {string|null} null if SHOPIFY_APP_HANDLE isn't configured
 */
export function getPlanSelectionUrl(shopDomain) {
  const appHandle = process.env.SHOPIFY_APP_HANDLE;
  if (!appHandle || !shopDomain) return null;

  const storeHandle = shopDomain.replace(/\.myshopify\.com$/, "");
  return `https://admin.shopify.com/store/${storeHandle}/charges/${appHandle}/pricing_plans`;
}
