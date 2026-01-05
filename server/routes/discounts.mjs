// server/routes/discounts.mjs
import express from "express";
import { PrismaClient } from "@prisma/client";
import { generateDiscountCode } from "../utils/generateCode.js";

const prisma = new PrismaClient();
const router = express.Router();

/* ============================================================
   1. INTERNAL API KEY VALIDATION
   ============================================================ */
router.use((req, res, next) => {
  const token = req.headers["x-api-key"];
  if (!token || token !== process.env.GOOGLE_SHEET_SECRET) {
    return res.status(401).json({
      success: false,
      error: "Unauthorized API access",
    });
  }
  next();
});

/* ============================================================
   2. PAYLOAD VALIDATION
   ============================================================ */
function validateDiscountPayload(body) {
  const errors = [];

  if (!body.shopDomain) errors.push("shopDomain required");
  if (!body.userId) errors.push("userId required");
  if (!body.email) errors.push("email required");

  const amount = Number(body.amount);
  if (isNaN(amount) || amount <= 0 || amount > 100) {
    errors.push("amount must be percentage between 1–100");
  }

  const expiryDays =
    body.expiryDays == null
      ? null
      : Math.max(1, Math.min(365, Number(body.expiryDays)));

  return {
    errors,
    clean: {
      shopDomain: String(body.shopDomain).trim(),
      userId: String(body.userId).trim(),
      email: String(body.email).trim(),
      name: body.name || "",
      amount,
      expiryDays,
      maxDiscounts:
        body.maxDiscounts == null ? null : Number(body.maxDiscounts),
      oneTimeUse: !!body.oneTimeUse,
      categories: Array.isArray(body.categories) ? body.categories : [],
    },
  };
}

/* ============================================================
   3. RAW SHOPIFY GRAPHQL (NO SDK, NO DEPRECATIONS)
   ============================================================ */
async function shopifyGraphQL({ shopDomain, accessToken, query, variables }) {
  const endpoint = `https://${shopDomain}/admin/api/2024-10/graphql.json`;

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
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
    return { ok: false, error: "Shopify GraphQL error", details: json };
  }

  return { ok: true, data: json.data };
}

/* ============================================================
   4. GRAPHQL DEFINITIONS
   ============================================================ */
const DISCOUNT_BASIC_CREATE = `
mutation CreateBasicDiscount($basicCodeDiscount: DiscountCodeBasicInput!) {
  discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
    codeDiscountNode {
      id
      codeDiscount {
        ... on DiscountCodeBasic {
          title
          startsAt
          endsAt
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

const COLLECTION_BY_HANDLE = `
query CollectionByHandle($handle: String!) {
  collectionByHandle(handle: $handle) {
    id
  }
}
`;

/* ============================================================
   5. RESOLVE COLLECTION HANDLES → GIDs
   ============================================================ */
async function resolveCollectionGids(shopDomain, accessToken, handles) {
  if (!handles?.length) return [];

  const gids = [];

  for (const h of handles) {
    const r = await shopifyGraphQL({
      shopDomain,
      accessToken,
      query: COLLECTION_BY_HANDLE,
      variables: { handle: String(h).trim() },
    });

    if (r.ok && r.data?.collectionByHandle?.id) {
      gids.push(r.data.collectionByHandle.id);
    }
  }

  return gids;
}

/* ============================================================
   6. MAIN ENDPOINT — POST /api/discounts/create
   ============================================================ */
router.post("/create", async (req, res) => {
  try {
    const { errors, clean } = validateDiscountPayload(req.body || {});
    if (errors.length) {
      return res.status(400).json({ success: false, error: errors });
    }

    const shop = await prisma.shop.findUnique({
      where: { shopDomain: clean.shopDomain },
      include: { settings: true },
    });

    if (!shop) {
      return res.status(404).json({ success: false, error: "Shop not found" });
    }

    const settings = shop.settings || {};

    // Prevent duplicate codes per user
    const existing = await prisma.discount.findFirst({
      where: { shopId: shop.id, userId: clean.userId },
    });

   if (existing) {
  return res.json({
    success: true,
    discountCode: existing.code,
    alreadyExisted: true,
  });
}

    // Max discounts
    if (settings.maxDiscounts) {
      const count = await prisma.discount.count({
        where: { shopId: shop.id },
      });
      if (count >= settings.maxDiscounts) {
        return res.status(429).json({
          success: false,
          error: "Max discounts reached",
        });
      }
    }

    const expiryDays = clean.expiryDays ?? settings.expiryDays ?? 30;
    const startsAt = new Date().toISOString();
    const endsAt = new Date(Date.now() + expiryDays * 86400000).toISOString();

    const code = generateDiscountCode(clean.name);
    const collectionGids = await resolveCollectionGids(
      shop.shopDomain,
      shop.accessToken,
      settings.categories || []
    );

    const basicCodeDiscount = {
      title: `ProCircle-${code}`,
      code,
      startsAt,
      endsAt,
      usageLimit: clean.oneTimeUse ? 1 : null,
      appliesOncePerCustomer: false,
      customerSelection: { all: true },
      customerGets: {
        value: { percentage: clean.amount / 100 },
        items: collectionGids.length
          ? { collections: { collectionsToAdd: collectionGids } }
          : { all: true },
      },
    };

    const gql = await shopifyGraphQL({
      shopDomain: shop.shopDomain,
      accessToken: shop.accessToken,
      query: DISCOUNT_BASIC_CREATE,
      variables: { basicCodeDiscount },
    });

    const result = gql.data?.discountCodeBasicCreate;

    if (!result || result.userErrors?.length) {
      return res.status(400).json({
        success: false,
        error: "Shopify error",
        details: result?.userErrors || gql.details,
      });
    }

    const saved = await prisma.discount.create({
      data: {
        shopId: shop.id,
        userId: clean.userId,
        email: clean.email,
        code,
        type: "percentage",
        amount: clean.amount,
        expiresAt: new Date(endsAt),
      },
    });

    return res.json({ success: true, discount: saved });

  } catch (err) {
    console.error("❌ Discount creation error:", err);
    return res.status(500).json({
      success: false,
      error: "Discount creation failed",
      details: err.message,
    });
  }
});

/* ============================================================
   7. SYNC REDEEMED CODES
   ============================================================ */
router.get("/unsynced", async (req, res) => {
  const rows = await prisma.discount.findMany({
    where: { syncedToSheets: false, redeemedAt: { not: null } },
  });
  res.json({ success: true, rows });
});

router.post("/mark-synced", async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ success: false });

  await prisma.discount.update({
    where: { code },
    data: { syncedToSheets: true },
  });

  res.json({ success: true });
});

export default router;