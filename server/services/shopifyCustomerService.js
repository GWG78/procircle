// services/shopifyCustomerService.js
//
// Creates/links Shopify customers for members, and adds them to a
// campaign's discount customer-selection list so they can use its shared
// discount code.

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const API_VERSION = process.env.SHOPIFY_API_VERSION;

/**
 * Raw Shopify Admin GraphQL call — mirrors the pattern already used in
 * routes/discounts.mjs and scripts/createOrderWebhook.mjs (fetch +
 * X-Shopify-Access-Token), reused here rather than introducing a new client.
 */
async function shopifyGraphQL(shop, query, variables) {
  const endpoint = `https://${shop.shopDomain}/admin/api/${API_VERSION}/graphql.json`;

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": shop.accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  const text = await resp.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: "Invalid JSON from Shopify", details: text };
  }

  if (!resp.ok || json.errors) {
    return { ok: false, error: "Shopify GraphQL error", details: json.errors || json };
  }

  return { ok: true, data: json.data };
}

const CUSTOMER_CREATE = `
  mutation customerCreate($input: CustomerInput!) {
    customerCreate(input: $input) {
      customer { id }
      userErrors { field message }
    }
  }
`;

// Shopify's Admin API doesn't expose a literal `customerByEmail` root field —
// the documented way to look a customer up by email is a search-style query
// connection. This wraps that in a customerByEmail-shaped helper.
const CUSTOMER_BY_EMAIL = `
  query customerByEmail($query: String!) {
    customers(first: 1, query: $query) {
      edges {
        node { id email }
      }
    }
  }
`;

const DISCOUNT_CODE_BASIC_UPDATE = `
  mutation AddCustomerToDiscount($id: ID!, $input: DiscountCodeBasicInput!) {
    discountCodeBasicUpdate(id: $id, basicCodeDiscount: $input) {
      codeDiscountNode { id }
      userErrors { field message }
    }
  }
`;

async function customerByEmail(shop, email) {
  const result = await shopifyGraphQL(shop, CUSTOMER_BY_EMAIL, {
    query: `email:${email}`,
  });

  if (!result.ok) {
    throw new Error(`Shopify customerByEmail lookup failed: ${JSON.stringify(result.details)}`);
  }

  return result.data?.customers?.edges?.[0]?.node?.id || null;
}

/**
 * Returns the Shopify customer GID for this member on this shop, creating
 * both the Shopify customer and the MemberShopifyLink row if needed.
 */
async function getOrCreateCustomer(shop, member) {
  const existingLink = await prisma.memberShopifyLink.findUnique({
    where: { memberId_shopId: { memberId: member.id, shopId: shop.id } },
  });

  if (existingLink) {
    return existingLink.shopifyCustomerId;
  }

  const createResult = await shopifyGraphQL(shop, CUSTOMER_CREATE, {
    input: {
      email: member.email,
      firstName: member.firstName || undefined,
      lastName: member.lastName || undefined,
      tags: ["procircle"],
    },
  });

  if (!createResult.ok) {
    throw new Error(`Shopify customerCreate failed: ${JSON.stringify(createResult.details)}`);
  }

  const payload = createResult.data?.customerCreate;
  let shopifyCustomerId = payload?.customer?.id;

  const userErrors = payload?.userErrors || [];
  const isDuplicateEmail = userErrors.some((e) =>
    /taken|already exists|already been taken/i.test(e.message)
  );

  if (!shopifyCustomerId && isDuplicateEmail) {
    // Customer already exists on Shopify but we have no link yet — look it up.
    shopifyCustomerId = await customerByEmail(shop, member.email);
  }

  if (!shopifyCustomerId) {
    throw new Error(
      `Shopify customerCreate returned no customer: ${JSON.stringify(userErrors)}`
    );
  }

  await prisma.memberShopifyLink.create({
    data: {
      memberId: member.id,
      shopId: shop.id,
      shopifyCustomerId,
    },
  });

  return shopifyCustomerId;
}

/**
 * Adds this customer to the campaign's discount customer-selection list,
 * so they become eligible to use the campaign's single shared discount code.
 */
async function addMemberToCampaignDiscount(shop, campaign, shopifyCustomerId) {
  if (!campaign.shopifyDiscountId) {
    console.warn(
      `⚠️ Campaign ${campaign.id} (${campaign.slug}) has no shopifyDiscountId — it wasn't properly initialised. Skipping customer-selection update.`
    );
    return;
  }

  const result = await shopifyGraphQL(shop, DISCOUNT_CODE_BASIC_UPDATE, {
    id: campaign.shopifyDiscountId,
    input: {
      customerSelection: {
        customers: {
          add: [shopifyCustomerId],
        },
      },
    },
  });

  if (!result.ok || result.data?.discountCodeBasicUpdate?.userErrors?.length) {
    throw new Error(
      `Shopify discountCodeBasicUpdate failed: ${JSON.stringify(
        result.details || result.data?.discountCodeBasicUpdate?.userErrors
      )}`
    );
  }
}

export { getOrCreateCustomer, addMemberToCampaignDiscount };
