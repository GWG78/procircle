const PARTNER_API_VERSION = "2026-07";

export async function fetchActiveSubscription(shopId) {
  if (!shopId) {
    throw new Error("Shopify Shop ID is required");
  }

  const orgId = process.env.SHOPIFY_PARTNER_ORG_ID;
  const accessToken =
    process.env.SHOPIFY_PARTNER_API_ACCESS_TOKEN;
  const appId = process.env.SHOPIFY_APP_GID;

  if (!orgId || !accessToken || !appId) {
    throw new Error(
      "Missing Shopify Partner API environment variables"
    );
  }

  const response = await fetch(
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

  const result = await response.json();

  if (!response.ok || result.errors) {
    throw new Error(
      `Partner API request failed: ${JSON.stringify(
        result.errors ?? result
      )}`
    );
  }

  return result.data?.activeSubscription ?? null;
}