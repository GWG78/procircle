import { SystemicBillingError } from "./billingErrors.js";

const PARTNER_API_VERSION = "2026-07";

// Any failure to reach/use the Partner API itself (bad config, network
// error, non-2xx, GraphQL errors) is systemic — it reflects a problem
// with our own credentials/connectivity, not with any individual shop,
// and callers must not treat it as a per-record failure. A shop simply
// not having an active subscription is NOT an error: the query
// succeeds and returns null, which is a legitimate per-record result.
export async function fetchActiveSubscription(shopId) {
  if (!shopId) {
    throw new SystemicBillingError("Shopify Shop ID is required");
  }

  const orgId = process.env.SHOPIFY_PARTNER_ORG_ID;
  const accessToken =
    process.env.SHOPIFY_PARTNER_API_ACCESS_TOKEN;
  const appId = process.env.SHOPIFY_APP_GID;

  if (!orgId || !accessToken || !appId) {
    throw new SystemicBillingError(
      "Missing Shopify Partner API environment variables"
    );
  }

  let response;
  try {
    response = await fetch(
      `https://partners.shopify.com/${orgId}/api/${PARTNER_API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({
          query: `
            query ActiveSubscription($appId: ID!, $shopId: ID!) {
              activeSubscription(appId: $appId, shopId: $shopId) {
                shop {
                  id
                  myshopifyDomain
                }
                billingPeriod
                cancelAtEndOfCycle
                items {
                  handle
                  description
                  price {
                    __typename
                    active
                    currency
                  }
                  usage {
                    quantity
                    cost {
                      amount
                      currencyCode
                    }
                  }
                }
                legacySubscriptionId
              }
            }
          `,
          variables: {
            appId,
            shopId,
          },
        }),
      }
    );
  } catch (err) {
    throw new SystemicBillingError(
      `Partner API request failed (network error): ${err.message}`,
      { cause: err }
    );
  }

  const result = await response.json().catch(() => null);

  if (!response.ok || result?.errors) {
    throw new SystemicBillingError(
      `Partner API request failed: ${JSON.stringify(
        result?.errors ?? result
      )}`
    );
  }

  return result.data?.activeSubscription ?? null;
}