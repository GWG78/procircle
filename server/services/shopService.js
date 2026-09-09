// services/shopService.js
//
// Resolves a shop's real Shopify business name for display purposes (e.g.
// brand name on member-facing offer cards) — separate from Shop.shopDomain,
// which is a technical identifier, not something a member should see.

import { PrismaClient } from "@prisma/client";
import { shopify } from "../shopify.js";

const prisma = new PrismaClient();

const SHOP_INFO_QUERY = `{ shop { name currencyCode } }`;

/**
 * Fetches a shop's real Shopify business name (and storefront currency) via
 * the Admin GraphQL API. Falls back to the raw shop domain / null currency
 * on any failure — never throws, since neither is something that should
 * block a caller.
 */
async function fetchShopifyShopName(shop) {
  try {
    const client = new shopify.clients.Graphql({
      session: { shop: shop.shopDomain, accessToken: shop.accessToken },
    });
    const response = await client.request(SHOP_INFO_QUERY);
    return {
      name: response.data?.shop?.name || shop.shopDomain,
      currencyCode: response.data?.shop?.currencyCode || null,
    };
  } catch (err) {
    console.error(`❌ fetchShopifyShopName failed for ${shop.shopDomain}:`, err.message);
    return { name: shop.shopDomain, currencyCode: null };
  }
}

/**
 * Returns a shop's display name, cached on Shop.name. Fetches from Shopify
 * and persists only on first call (or after Shop.name is manually cleared)
 * — mirrors the existing wpBrandTermId/logoWpAttachmentId cache-once
 * pattern. Loads its own Shop row (including accessToken) rather than
 * accepting one from the caller, so callers building client-facing
 * responses never need to select accessToken onto an object that gets
 * serialized back out.
 *
 * Shop.displayNameOverride, if set, wins unconditionally — checked before
 * anything else, with no read or write to Shop.name and no Shopify call.
 * The two fields stay strictly separate: Shop.name is always "what Shopify
 * says" (or null if never fetched), displayNameOverride is always "what
 * we've deliberately chosen to show instead." A manual DB edit to
 * Shop.name would get silently clobbered by any future refetch (a bug, a
 * manual cache-clear, a TTL-based refresh); displayNameOverride can't be,
 * since this function never writes to it and the Shop.name fetch/cache
 * path below never even runs while it's set.
 */
async function getOrFetchShopName(shopId) {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { id: true, shopDomain: true, accessToken: true, name: true, currencyCode: true, displayNameOverride: true },
  });
  if (!shop) return null;
  if (shop.displayNameOverride) return shop.displayNameOverride;
  if (shop.name && shop.currencyCode) return shop.name;

  const { name, currencyCode } = await fetchShopifyShopName(shop);
  await prisma.shop.update({ where: { id: shop.id }, data: { name, currencyCode } });
  return name;
}

export { fetchShopifyShopName, getOrFetchShopName };
