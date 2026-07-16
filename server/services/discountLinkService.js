// services/discountLinkService.js
//
// Creates the single Shopify discount code that backs a Campaign's
// shareable link. Called once at campaign creation time — everyone who
// redeems the campaign shares this same code, and is added to its
// customer-selection list via shopifyCustomerService.addMemberToCampaignDiscount.

const API_VERSION = process.env.SHOPIFY_API_VERSION;

const DISCOUNT_CODE_BASIC_CREATE = `
  mutation CreateCampaignDiscount($input: DiscountCodeBasicInput!) {
    discountCodeBasicCreate(basicCodeDiscount: $input) {
      codeDiscountNode {
        id
        codeDiscount {
          ... on DiscountCodeBasic {
            codes(first: 1) {
              nodes { code }
            }
          }
        }
      }
      userErrors { field message }
    }
  }
`;

/**
 * Calls the Shopify Admin GraphQL API for a given shop.
 */
async function shopifyGraphQL(shop, query, variables) {
  const endpoint = `https://${shop.shopDomain}/admin/api/${API_VERSION}/graphql.json`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": shop.accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON from Shopify: ${text}`);
  }

  if (!response.ok || json.errors) {
    throw new Error(
      `Shopify GraphQL error: ${JSON.stringify(json.errors || json)}`
    );
  }

  return json.data;
}

/**
 * Creates the one Shopify discount code for a campaign, starting with an
 * empty customer-selection list — members are added to it as they redeem
 * (see shopifyCustomerService.addMemberToCampaignDiscount).
 *
 * @param {{ shopDomain: string, accessToken: string }} shop
 * @param {{ name: string, slug: string, discountType: string, discountValue: number, startsAt?: Date|string|null, expiresAt?: Date|string|null, maxRedemptions?: number|null }} campaign
 * @returns {Promise<{ discountCode: string, discountLink: string, shopifyDiscountId: string }>}
 */
async function createCampaignDiscount(shop, campaign) {
  const discountCode = `PROCIRCLE-${campaign.slug.toUpperCase()}`;

  const input = {
    title: `ProCircle — ${campaign.name}`,
    code: discountCode,
    startsAt: campaign.startsAt ?? new Date().toISOString(),
    endsAt: campaign.expiresAt ?? null,
    customerSelection: {
      customers: { add: [] },
    },
    customerGets: {
      value:
        campaign.discountType === "percentage"
          ? { percentage: campaign.discountValue / 100 }
          : { discountAmount: { amount: campaign.discountValue, appliesOnEachItem: false } },
      items: { all: true },
    },
    appliesOncePerCustomer: true,
    usageLimit: campaign.maxRedemptions ?? null,
  };

  const data = await shopifyGraphQL(shop, DISCOUNT_CODE_BASIC_CREATE, { input });

  const result = data?.discountCodeBasicCreate;

  if (!result || result.userErrors?.length) {
    throw new Error(
      `Shopify discountCodeBasicCreate failed: ${JSON.stringify(
        result?.userErrors || result
      )}`
    );
  }

  const shopifyDiscountId = result.codeDiscountNode?.id;
  const returnedCode =
    result.codeDiscountNode?.codeDiscount?.codes?.nodes?.[0]?.code || discountCode;

  if (!shopifyDiscountId) {
    throw new Error("Shopify did not return a discount id for the created discount.");
  }

  const discountLink = `https://${shop.shopDomain}/discount/${returnedCode}?redirect=/collections/all`;

  return { discountCode: returnedCode, discountLink, shopifyDiscountId };
}

export { createCampaignDiscount };
