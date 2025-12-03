// server/routes/discounts.mjs
import express from "express";
import { PrismaClient } from "@prisma/client";
import { shopifyApi } from "@shopify/shopify-api";
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
   2. SHOPIFY ADMIN GRAPHQL CLIENT
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

  // Percentage only (1–100)
  const amount = Number(body.amount);
  if (isNaN(amount) || amount <= 0 || amount > 100) {
    errors.push("amount must be 1–100 (percentage)");
  }

  let expiryDays =
    body.expiryDays == null
      ? null
      : Math.max(1, Math.min(365, Number(body.expiryDays)));

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
   4. NEW SHOPIFY MUTATION (2024-10)
   ============================================================ */
const DISCOUNT_MUTATION = `
mutation discountCodeCreate($code: String!, $discount: DiscountCodeInput!) {
  discountCodeCreate(code: $code, discount: $discount) {
    userErrors {
      field
      message
    }
    codeDiscount {
      id
      title
      startsAt
      endsAt
      ... on DiscountCode {
        codes(first: 1) {
          nodes { code }
        }
      }
    }
  }
}
`;

/* ============================================================
   5. MAIN ENDPOINT — POST /api/discounts/create
   ============================================================ */
router.post("/create", async (req, res) => {
  try {
    /* ---- Step 1: Validate ---- */
    const { errors, clean } = validateDiscountPayload(req.body || {});
    if (errors.length) {
      return res.status(400).json({
        success: false,
        error: "Validation failed",
        details: errors,
      });
    }

    /* ---- Step 2: Load shop + settings ---- */
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

    /* ---- Step 3: Allowed country / member type filters ---- */
    if (settings.allowedCountries?.length) {
      if (!clean.allowedCountries.some((c) =>
        settings.allowedCountries.includes(c)
      )) {
        return res.status(403).json({
          success: false,
          error: "Country not allowed",
        });
      }
    }

    if (settings.allowedMemberTypes?.length) {
      if (!clean.allowedMemberTypes.some((t) =>
        settings.allowedMemberTypes.includes(t)
      )) {
        return res.status(403).json({
          success: false,
          error: "Member type not allowed",
        });
      }
    }

    /* ---- Step 4: Prevent duplicates + enforce maxDiscounts ---- */
    const existing = await prisma.discount.findFirst({
      where: { shopId: shop.id, userId: clean.userId },
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

    /* ---- Step 5: Expiry ---- */
    const expiryDays = clean.expiryDays ?? settings.expiryDays ?? 30;

    const startsAt = new Date().toISOString();
    const endsAt = new Date(
      Date.now() + expiryDays * 86400000
    ).toISOString();

    /* ---- Step 6: Resolve category → GID list ---- */
    const appliesTo =
      settings.categories?.length
        ? { collections: await getCollectionGids(shop, settings.categories) }
        : { all: true };

    /* ---- Step 7: Build GraphQL Input ---- */
    const code = generateDiscountCode(clean.name);

    const discountInput = {
      title: `ProCircle-${code}`,
      startsAt,
      endsAt,
      usageLimit: clean.oneTimeUse ? 1 : null,
      appliesOncePerCustomer: clean.oneTimeUse,
      customerSelection: { all: true },
      combinesWith: { productDiscounts: true },

      // Always percentage
      customerGets: {
        value: {
          percentage: clean.amount,
        },
      },

      // All products or restricted collections
      appliesTo,
    };

    /* ---- Step 8: Execute GraphQL ---- */
    const gql = new shopify.clients.Graphql({
      session: {
        shop: shop.shopDomain,
        accessToken: shop.accessToken,
      },
    });

    const gqlRes = await gql.query({
      data: {
        query: DISCOUNT_MUTATION,
        variables: {
          code,
          discount: discountInput,
        },
      },
    });

    const userErrors =
      gqlRes.body.data.discountCodeCreate.userErrors;

    if (userErrors?.length) {
      return res.status(400).json({
        success: false,
        error: "Shopify error",
        details: userErrors,
      });
    }

    /* ---- Step 9: Save locally ---- */
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
   Helper: Convert collection handles → GIDs
   ============================================================ */
async function getCollectionGids(shop, handles) {
  if (!handles.length) return [];

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
      console.warn("Failed to resolve collection:", handle);
    }
  }

  return gids;
}

export default router;