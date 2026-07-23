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

const DISCOUNT_CODE_ACTIVATE = `
  mutation ActivateCampaignDiscount($id: ID!) {
    discountCodeActivate(id: $id) {
      codeDiscountNode { id }
      userErrors { field message }
    }
  }
`;

const DISCOUNT_CODE_DEACTIVATE = `
  mutation DeactivateCampaignDiscount($id: ID!) {
    discountCodeDeactivate(id: $id) {
      codeDiscountNode { id }
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
 * Creates the one Shopify discount code for a campaign, with the customer
 * list seeded with a single sentinel customer (see campaigns.mjs) rather
 * than `customerSelection: { all: true }`. An explicit list is required for
 * removeCustomerFromCampaignDiscount to actually gate checkout — `all: true`
 * ignores the list entirely, which was silently defeating the whole
 * expiry/removal mechanism. `discountCodeBasicCreate` also rejects an empty
 * `customers.add` array, which is why a sentinel is needed at all: real
 * members are added via shopifyCustomerService.addMemberToCampaignDiscount
 * as they redeem, and removed by the daily expiry cron — the sentinel just
 * keeps the list non-empty and is never itself removed.
 *
 * Campaigns no longer carry a fixed expiry — access is a per-member window
 * (Redemption.accessExpiresAt) enforced by the daily cron removing expired
 * members from this discount's customer selection, not a hard end date on
 * the discount itself. So `endsAt` is always null here.
 *
 * @param {{ shopDomain: string, accessToken: string }} shop
 * @param {{ name: string, slug: string, discountType: string, discountValue: number, startsAt?: Date|string|null, maxRedemptions?: number|null }} campaign
 * @param {string} sentinelCustomerId Shopify customer GID seeded into customerSelection.customers.add
 * @returns {Promise<{ discountCode: string, discountLink: string, shopifyDiscountId: string }>}
 */
async function createCampaignDiscount(shop, campaign, sentinelCustomerId) {
  const discountCode = `PROCIRCLE-${campaign.slug.toUpperCase()}`;

  const input = {
    title: `ProCircle — ${campaign.name}`,
    code: discountCode,
    startsAt: campaign.startsAt ?? new Date().toISOString(),
    endsAt: null,
    customerSelection: {
      customers: {
        add: [sentinelCustomerId],
      },
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

const DISCOUNT_ALREADY_GONE_MESSAGE = "Code discount does not exist.";

/**
 * Activates (discountCodeActivate) or deactivates (discountCodeDeactivate)
 * the Shopify discount backing a campaign, so toggling a campaign's active
 * state in the app actually gates checkout — not just our own eligibility
 * engine. Called from campaigns.mjs's pause/resume/end handlers *before* the
 * DB write, so a Shopify failure never leaves Campaign.status out of sync
 * with the real discount's state.
 *
 * If the discount was deleted outside the app (merchant deleted it directly
 * in Shopify's Discounts page), Shopify returns a userError rather than a
 * transport-level failure: {"field":["id"],"message":"Code discount does
 * not exist."}. That specific case is treated as already-in-target-state —
 * logged as a warning (with campaignId if the caller has one) and resolved
 * normally rather than thrown, so the caller can proceed to update the DB
 * as if the Shopify call had succeeded. Any other userError still throws.
 *
 * @param {{ shopDomain: string, accessToken: string }} shop
 * @param {string} shopifyDiscountId
 * @param {boolean} active
 * @param {{ campaignId?: number|string }} [context] Only used for the warning log below.
 */
async function setCampaignDiscountActive(shop, shopifyDiscountId, active, context = {}) {
  const mutation = active ? DISCOUNT_CODE_ACTIVATE : DISCOUNT_CODE_DEACTIVATE;
  const mutationName = active ? "discountCodeActivate" : "discountCodeDeactivate";

  const data = await shopifyGraphQL(shop, mutation, { id: shopifyDiscountId });
  const result = data?.[mutationName];

  const userErrors = result?.userErrors || [];
  const alreadyGone = userErrors.some((e) => e.message === DISCOUNT_ALREADY_GONE_MESSAGE);

  if (alreadyGone) {
    console.warn(
      `⚠️ Shopify ${mutationName}: discount already gone (deleted outside the app) — campaignId=${context.campaignId ?? "unknown"}, shopifyDiscountId=${shopifyDiscountId}. Treating as already in target state.`
    );
    return;
  }

  if (!result || userErrors.length) {
    throw new Error(
      `Shopify ${mutationName} failed: ${JSON.stringify(userErrors.length ? userErrors : result)}`
    );
  }
}

export { createCampaignDiscount, setCampaignDiscountActive, DISCOUNT_ALREADY_GONE_MESSAGE };
