// server/routes/collections.mjs
import express from "express";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const router = express.Router();

/**
 * Raw Shopify Admin GraphQL call — same pattern as
 * services/discountLinkService.js and routes/discounts.mjs
 * (fetch + X-Shopify-Access-Token), reused here rather than a new client.
 */
async function shopifyGraphQL(shop, query, variables) {
  const endpoint = `https://${shop.shopDomain}/admin/api/${process.env.SHOPIFY_API_VERSION}/graphql.json`;

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

const GET_COLLECTIONS = `
  query GetCollections($first: Int!, $after: String) {
    collections(first: $first, after: $after, sortKey: TITLE) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        handle
        productsCount { count }
      }
    }
  }
`;

/**
 * Fetches every collection for the shop (paginated in batches of 50),
 * filtering out empty collections along the way.
 */
async function fetchAllCollections(shop) {
  const collections = [];
  let after = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const result = await shopifyGraphQL(shop, GET_COLLECTIONS, { first: 50, after });

    if (!result.ok) {
      throw new Error(`Shopify collections query failed: ${JSON.stringify(result.details)}`);
    }

    const { nodes, pageInfo } = result.data.collections;

    for (const node of nodes) {
      const productCount = node.productsCount?.count ?? 0;
      if (productCount >= 1) {
        collections.push({
          id: node.id,
          title: node.title,
          handle: node.handle,
          productCount,
        });
      }
    }

    hasNextPage = pageInfo.hasNextPage;
    after = pageInfo.endCursor;
  }

  collections.sort((a, b) => a.title.localeCompare(b.title));
  return collections;
}

/**
 * ===========================================================
 * GET /api/collections?shop=...
 * ===========================================================
 */
router.get("/", async (req, res) => {
  try {
    const shopDomain = req.query.shop;
    if (!shopDomain) {
      return res.status(400).json({ success: false, error: "shop is required" });
    }

    const shop = await prisma.shop.findUnique({ where: { shopDomain } });
    if (!shop || !shop.accessToken) {
      return res.status(404).json({ success: false, error: "Shop not found" });
    }

    const collections = await fetchAllCollections(shop);

    res.json({ success: true, collections });
  } catch (err) {
    console.error("❌ Error fetching collections:", err);
    res.status(500).json({ success: false, error: "Failed to fetch collections" });
  }
});

export default router;
