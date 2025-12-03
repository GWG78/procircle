// server/routes/discounts.mjs
import express from "express";
import { PrismaClient } from "@prisma/client";
import { shopifyApi } from "@shopify/shopify-api";
import fetch from "node-fetch";
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
   2. SHOPIFY API CLIENT (for REST calls only)
   ============================================================ */
const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  scopes: process.env.SHOPIFY_SCOPES.split(","),
  hostName: process.env.APP_URL.replace(/https?:\/\//, ""),
  apiVersion: "2024-10",
  isEmbeddedApp: true,
});

/* ============================================================
   3. PAYLOAD VALIDATION
   ============================================================ */
function validateDiscountPayload(body) {
  const errors = [];

  if (!body.shopDomain) errors.push("shopDomain required");
  if (!body.userId) errors.push("userId required");
  if (!body.email) errors.push("email required");

  // percentage-only discount, 1–100
  const amount = Number(body.amount);
  if (isNaN(amount) || amount <= 0 || amount > 100) {
    errors.push("amount must be 1–100 (percentage only)");
  }

  // expiryDays: 1–365 or null
  let expiryDays =
    body.expiryDays == null
      ? null
      : Math.max(1, Math.min(365, Number(body.expiryDays) || 1));

  return {
    errors,
    clean: {
      shopDomain: body.shopDomain,
      userId: body.userId,
      email: body.email,
      name: body.name || "",
      amount,
      expiryDays,
      maxDiscounts:
        body.maxDiscounts == null ? null : Number(body.maxDiscounts),
      oneTimeUse: !!body.oneTimeUse,
      categories: Array.isArray(body.categories) ? body.categories : [],
      allowedCountries: Array.isArray(body.allowedCountries)
        ? body.allowedCountries
        : [],
      allowedMemberTypes: Array.isArray(body.allowedMemberTypes)
        ? body.allowedMemberTypes
        : [],
    },
  };
}

/* ============================================================
   4. GRAPHQL MUTATION FOR DISCOUNTS
   ============================================================ */
const DISCOUNT_MUTATION = `
mutation CreateDiscount($input: DiscountCodeBasicCreateInput!) {
  discountCodeBasicCreate(basicCodeDiscount: $input) {
    codeDiscountNode {
      id
      codeDiscount {
        ... on DiscountCodeBasic {
          title
          startsAt
          endsAt
          codes(first: 1) {
            nodes {
              code
            }
          }
        }
      }
    }
    userErrors {
      field
      message
    }
  }
}
`;

/* ============================================================
   5. MAIN ENDPOINT — POST /api/discounts/create
   ============================================================ */
router.post("/create", async (req, res) => {
  try {
    // -------- Step 1: Validate payload --------
    const { errors, clean } = validateDiscountPayload(req.body || {});
    if (errors.length) {
      return res.status(400).json({
        success: false,
        error: "Validation failed",
        details: errors,
      });
    }

    // -------- Step 2: Load shop + settings --------
    const shop = await prisma.shop.findUnique({
      where: { shopDomain: clean.shopDomain },
      include: { settings: true },
    });

    if (!shop) {
      return res.status(404).json({
        success: false,
        error: "Shop not found",
      });
    }

    const settings = shop.settings || {};

    // -------- Step 3: Eligibility (country / member type) --------
    if (settings.allowedCountries?.length) {
      if (
        !clean.allowedCountries.some((c) =>
          settings.allowedCountries.includes(c)
        )
      ) {
        return res.status(403).json({
          success: false,
          error: "Country not allowed",
        });
      }
    }

    if (settings.allowedMemberTypes?.length) {
      if (
        !clean.allowedMemberTypes.some((t) =>
          settings.allowedMemberTypes.includes(t)
        )
      ) {
        return res.status(403).json({
          success: false,
          error: "Member type not allowed",
        });
      }
    }

    // -------- Step 4: Enforce max 1 code per user + maxDiscounts --------
    const existing = await prisma.discount.findFirst({
      where: {
        shopId: shop.id,
        userId: clean.userId,
      },
    });

    if (existing) {
      return res.status(409).json({
        success: false,
        error: "User already has a discount",
      });
    }

    if (settings.maxDiscounts && settings.maxDiscounts > 0) {
      const total = await prisma.discount.count({
        where: { shopId: shop.id },
      });
      if (total >= settings.maxDiscounts) {
        return res.status(429).json({
          success: false,
          error: "Max number of discounts reached",
        });
      }
    }

    // -------- Step 5: Expiry --------
    const expiryDays = clean.expiryDays ?? settings.expiryDays ?? 30;
    const expiresAtIso = new Date(
      Date.now() + expiryDays * 86400000
    ).toISOString();
    const startsAtIso = new Date().toISOString();

    // -------- Step 6: Collections (from settings.categories) --------
    const collectionGids = await getCollectionGids(
      shop,
      settings.categories || []
    );

    // -------- Step 7: Build variables for GraphQL --------
    const code = generateDiscountCode(clean.name);

    const gqlVariables = {
      input: {
        title: `ProCircle-${code}`,
        code,
        startsAt: startsAtIso,
        endsAt: expiresAtIso,
        usageLimit: clean.oneTimeUse ? 1 : null,
        customerSelection: { all: true },

        customerGets: {
          value: {
            percentageValue: clean.amount,
          },
        },

        appliesTo: collectionGids.length
          ? {
              collectionsToAdd: collectionGids,
            }
          : {
              all: true,
            },
      },
    };

    // -------- Step 8: Call Shopify Admin GraphQL directly (no Shopify client) --------
    const adminGraphqlUrl = `https://${shop.shopDomain}/admin/api/2024-10/graphql.json`;

    const gqlHttpRes = await fetch(adminGraphqlUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": shop.accessToken,
      },
      body: JSON.stringify({
        query: DISCOUNT_MUTATION,
        variables: gqlVariables,
      }),
    });

    const gqlJson = await gqlHttpRes.json();

    if (!gqlHttpRes.ok) {
      console.error("Shopify GraphQL HTTP error:", gqlJson);
      return res.status(502).json({
        success: false,
        error: "Shopify GraphQL HTTP error",
        details: gqlJson,
      });
    }

    const payload = gqlJson.data?.discountCodeBasicCreate;

    if (!payload) {
      console.error("Malformed Shopify GraphQL response:", gqlJson);
      return res.status(500).json({
        success: false,
        error: "Malformed response from Shopify GraphQL",
        details: gqlJson,
      });
    }

    const userErrors = payload.userErrors || [];
    if (userErrors.length) {
      console.error("Shopify GraphQL userErrors:", userErrors);
      return res.status(400).json({
        success: false,
        error: "Shopify validation error",
        details: userErrors,
      });
    }

    // -------- Step 9: Save discount locally --------
    const saved = await prisma.discount.create({
      data: {
        shopId: shop.id,
        userId: clean.userId,
        email: clean.email,
        code,
        type: "percentage",
        amount: clean.amount,
        expiresAt: new Date(expiresAtIso),
      },
    });

    return res.json({
      success: true,
      discount: saved,
    });
  } catch (err) {
    console.error("❌ Discount creation error:", err);
    return res.status(500).json({
      success: false,
      error: "Shopify discount creation failed",
      details: err.message,
    });
  }
});

/* ============================================================
   Helper: Convert collection handles → Shopify GIDs
   ============================================================ */
async function getCollectionGids(shop, handles) {
  if (!handles || !handles.length) return [];

  const client = new shopify.clients.Rest({
    session: {
      shop: shop.shopDomain,
      accessToken: shop.accessToken,
    },
  });

  const gids = [];

  for (const handle of handles) {
    try {
      const res = await client.get({
        path: "collections",
        query: { handle },
      });

      const c = res.body?.collection;
      if (c?.id) {
        gids.push(`gid://shopify/Collection/${c.id}`);
      }
    } catch (err) {
      console.warn("Failed to resolve collection handle:", handle, err.message);
    }
  }

  return gids;
}

export default router;