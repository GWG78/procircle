// services/billing.js
//
// Creates the usage-based billing subscription a shop must approve before
// commission can be charged on redeemed pro deal sales. Called from
// auth.mjs right after OAuth completes.

import { shopify } from "../shopify.js";

const PLAN_NAME = "ProCircle Performance Plan";

const ACTIVE_SUBSCRIPTIONS_QUERY = `
  query {
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

const BILLING_MUTATION = `
  mutation appSubscriptionCreate(
    $name: String!
    $lineItems: [AppSubscriptionLineItemInput!]!
    $returnUrl: URL!
    $test: Boolean
  ) {
    appSubscriptionCreate(name: $name, lineItems: $lineItems, returnUrl: $returnUrl, test: $test) {
      appSubscription {
        id
        status
        lineItems {
          id
        }
      }
      confirmationUrl
      userErrors {
        field
        message
      }
    }
  }
`;

/**
 * Ensures a usage-based billing subscription exists for this shop —
 * returns the existing one if already active, otherwise creates a new one.
 *
 * Returns:
 *   { confirmationUrl: string|null, lineItemId: string }  on success
 *   null                                                   on failure
 *
 * confirmationUrl is null when a subscription was already active (nothing
 * new for the merchant to approve) and set when a new one was just created
 * (the caller must redirect the merchant there to approve billing).
 * lineItemId is what appUsageRecordCreate needs later — see
 * services/usageRecord.js — and is what auth.mjs persists as
 * Shop.billingSubscriptionId.
 */
export async function ensureBillingSubscription(shop, accessToken, returnUrl) {
  try {
    const client = new shopify.clients.Graphql({ session: { shop, accessToken } });

    const existing = await client.request(ACTIVE_SUBSCRIPTIONS_QUERY);
    const activeSubscriptions =
      existing.data?.currentAppInstallation?.activeSubscriptions || [];
    const alreadyActive = activeSubscriptions.find((sub) => sub.name === PLAN_NAME);

    if (alreadyActive) {
      const lineItemId = alreadyActive.lineItems?.[0]?.id || null;
      console.log(`✅ Billing subscription already active for ${shop} (${alreadyActive.id})`);
      if (!lineItemId) {
        console.error(
          `❌ Active subscription for ${shop} has no line items — cannot post usage records:`,
          alreadyActive
        );
        return null;
      }
      return { confirmationUrl: null, lineItemId };
    }

    const response = await client.request(BILLING_MUTATION, {
      variables: {
        name: PLAN_NAME,
        returnUrl,
        test: process.env.NODE_ENV !== "production",
        lineItems: [
          {
            plan: {
              appUsagePricingDetails: {
                cappedAmount: {
                  amount: 10000,
                  currencyCode: "EUR",
                },
                terms: "Commission of up to 8% applied per verified pro deal sale",
              },
            },
          },
        ],
      },
    });

    const result = response.data?.appSubscriptionCreate;

    if (result?.userErrors?.length > 0) {
      console.error(`❌ Billing subscription error for ${shop}:`, result.userErrors);
      return null;
    }

    const lineItemId = result?.appSubscription?.lineItems?.[0]?.id || null;
    const confirmationUrl = result?.confirmationUrl || null;

    if (!confirmationUrl || !lineItemId) {
      console.error(
        `❌ Billing subscription response missing confirmationUrl or lineItemId for ${shop}:`,
        result
      );
      return null;
    }

    console.log(`💳 Created billing subscription for ${shop}, awaiting merchant approval`);
    return { confirmationUrl, lineItemId };
  } catch (err) {
    console.error(`❌ ensureBillingSubscription failed for ${shop}:`, err);
    return null;
  }
}
