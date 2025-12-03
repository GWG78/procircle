// server/utils/createShopifyDiscount.js
import fetch from "node-fetch";

/**
 * Create a percentage discount in Shopify using GraphQL Admin API
 
export async function createShopifyDiscount({
  shopDomain,
  accessToken,
  code,
  amount,           // percentage (1–100)
  expiryDate,       // JS Date
  oneTimeUse,       // boolean
  collectionIds,    // array of Shopify GIDs (may be empty)
}) {
  const endpoint = `https://${shopDomain}/admin/api/2025-01/graphql.json`;

  // Build product rules for collection restrictions
  const productRules =
    collectionIds.length === 0
      ? [] // no restrictions → applies to all products
      : [
          {
            collections: {
              add: collectionIds,
            },
          },
        ];

  // GraphQL mutation for 2024+ Function Discounts
  const mutation = `
    mutation CreateDiscount($discount: DiscountAutomaticAppInput!) {
      discountAutomaticAppCreate(automaticAppDiscount: $discount) {
        automaticAppDiscount {
          id
          discountClass
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    discount: {
      title: `ProCircle ${code}`,
      functionId: "precircle-percentage-discount", // you can name this anything
      startsAt: new Date().toISOString(),
      endsAt: expiryDate.toISOString(),
      discountClass: "product",            // affects products
      combinesWith: {
        productDiscounts: false,
        orderDiscounts: false,
        shippingDiscounts: false,
      },
      metafields: [],
      automaticAppDiscountType: {
        percentage: {
          value: amount / 100, // must be decimal
        },
      },
      customerGets: {
        items: {
          productVariants: null,
          all: collectionIds.length === 0, // ALL products if no categories selected
          collections: collectionIds.length > 0 ? collectionIds : null,
        },
      },
      usageLimit: oneTimeUse ? 1 : null,
      code: code,
    },
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({ query: mutation, variables }),
  });

  const json = await response.json();

  if (json.errors) {
    return { success: false, error: json.errors };
  }

  const userErrors =
    json.data?.discountAutomaticAppCreate?.userErrors || [];

  if (userErrors.length > 0) {
    return { success: false, error: userErrors };
  }

  const discountId =
    json.data?.discountAutomaticAppCreate?.automaticAppDiscount?.id;

  return { success: true, id: discountId };
}*/