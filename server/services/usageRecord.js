// services/usageRecord.js
//
// Posts a commission charge against a shop's active billing subscription.
// Called from webhooks/ordersPaid.mjs after a redemption's order is linked.

import { shopify } from "../shopify.js";

const USAGE_RECORD_MUTATION = `
  mutation appUsageRecordCreate($subscriptionLineItemId: ID!, $price: MoneyInput!, $description: String!) {
    appUsageRecordCreate(subscriptionLineItemId: $subscriptionLineItemId, price: $price, description: $description) {
      appUsageRecord {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/**
 * subscriptionLineItemId is Shop.billingSubscriptionId — despite the field
 * name, it holds the app subscription *line item* id (see
 * services/billing.js), which is what this mutation actually requires.
 * Never throws — a failed usage post is logged and returned as null so a
 * webhook handler can decide how to react without crashing.
 */
export async function postUsageRecord(shop, accessToken, subscriptionLineItemId, amount, orderId) {
  try {
    const client = new shopify.clients.Graphql({ session: { shop, accessToken } });

    const response = await client.request(USAGE_RECORD_MUTATION, {
      variables: {
        subscriptionLineItemId,
        price: {
          amount: amount.toFixed(2),
          currencyCode: "EUR",
        },
        description: `ProCircle commission on order ${orderId}`,
      },
    });

    const result = response.data?.appUsageRecordCreate;

    if (result?.userErrors?.length > 0) {
      console.error(`❌ Usage record error for order ${orderId}:`, result.userErrors);
      return null;
    }

    console.log(`✅ Usage record posted for order ${orderId}: €${amount}`);
    return result?.appUsageRecord?.id || null;
  } catch (err) {
    console.error(`❌ postUsageRecord failed for order ${orderId}:`, err);
    return null;
  }
}
